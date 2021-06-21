import Automerge from 'automerge';
import { EventEmitter } from 'events';
import debug from 'debug';
import { v4 as uuid } from 'uuid';
import { Backend } from 'automerge';

import * as crypto from './crypto';
import { Key, ContactId, IContact, IDevice } from './types';
import { MultipleDocuments, ReceiveSyncMsg } from 'automerge-sync';
import { DB } from './automerge-db';
import { randomBytes } from 'crypto';

type DocumentId = string;

enum System {
  ContactList,
  DeviceList,
}

export interface ContactList {
  contacts: Automerge.List<IContact>;
  settings: any;
}

export interface DeviceList {
  devices: Automerge.List<IDevice>;
}

const CONTACT_LIST = 'BACKCHANNEL_ROOT_DOCUMENT';
const DEVICE_LIST = 'BACKCHANNEL_DEVICE_LIST';

export class Database<T> extends EventEmitter {
  public onContactListChange: Function;
  private _idb: DB;
  private log: debug;
  private dbname: string;
  private _opened: boolean;
  private syncer: MultipleDocuments = new MultipleDocuments();
  private _opening: boolean = false;

  /**
   * Create a new database for a given Automerge document type.
   *
   * @param {string} dbname The name of the database
   */
  constructor(dbname: string) {
    super();
    this.dbname = dbname;
    this.log = debug(`bc:db:${randomBytes(4).toString('hex')}`);
    this._idb = new DB(dbname);
    this.open().then(() => {
      this._opened = true;
      this.log('open');
      this.emit('open');
    });
  }

  /**
   * Get an array of all document ids
   */
  get documents(): string[] {
    return this.syncer.documents.filter(
      (d) => d !== CONTACT_LIST && d !== DEVICE_LIST
    );
  }

  get settings(): any {
    return this.root.settings;
  }

  async changeRoot(changeFn: Automerge.ChangeFn<ContactList>) {
    await this.change(CONTACT_LIST, changeFn);
  }

  get all() {
    return Array.from(this.root.contacts).concat(this.devices);
  }

  set root(doc: Automerge.Doc<ContactList>) {
    this.syncer.add(CONTACT_LIST, doc);
  }

  get root(): Automerge.Doc<ContactList> {
    return this.syncer.get(CONTACT_LIST) as Automerge.Doc<ContactList>;
  }

  get devices(): IDevice[] {
    let doc = this.syncer.get(DEVICE_LIST) as Automerge.Doc<DeviceList>;
    return doc.devices;
  }

  async hasBlob(id: string): Promise<boolean> {
    let num = await this._idb.blobs.where({ id }).count();
    return num > 0;
  }

  async getBlob(id: string): Promise<Uint8Array> {
    let maybeBlob = await this._idb.blobs.get(id);
    if (maybeBlob) return maybeBlob.data;
    else return null;
  }

  saveBlob(id: string, data: Uint8Array) {
    return this._idb.blobs.put({ id, data }, id);
  }

  getContacts(): IContact[] {
    if (!this.root.contacts) return [];
    return this.root.contacts.map((c) => this._hydrateContact(c));
  }

  error(err) {
    this.log('got error', err);
    throw new Error(err);
  }

  /**
   * When a peer connects, call this function
   * @param peerId
   * @param docId
   * @param send
   * @returns
   */
  onPeerConnect(docId: string, peerId: string, send: Function): ReceiveSyncMsg {
    return this.syncer.onPeerConnect(docId, peerId, send);
  }

  /**
   * When a peer disconnects, call this function
   * @param docId A unique identifer for the document
   * @param peerId A unique identifier for the peer (should be the same called in onPeerConnect)
   */
  async onDisconnect(docId, peerId): Promise<void> {
    this.log('onDisconnect', docId);
    let peer = this.syncer.getPeer(docId, peerId);
    this.syncer.onPeerDisconnect(docId, peerId);
    if (peer) await this._idb.storeSyncState(docId, peerId, peer.state);
  }

  getDocument(docId: DocumentId): Automerge.Doc<unknown> {
    this.log('getting document', docId);
    return this.syncer.get(docId);
  }

  /**
   * Is this contact currently connected to us? i.e., currently online and we
   * have an open connection with them
   * @param {IContact} contact The contact object
   * @return {boolean} If the contact is currently connected
   */
  isConnected(contact: IContact): boolean {
    return this.syncer.isConnected(contact.discoveryKey, contact.id);
  }

  getDocumentIds(contact: IContact): string[] {
    let ids = [contact.discoveryKey];
    if (contact.device) ids.push(CONTACT_LIST);
    return ids;
  }

  /**
   * Make a change to a document.
   * @param docId The document ID
   * @param changeFn The Automerge change function to change the document.
   */
  async change<J>(
    docId: DocumentId,
    changeFn: Automerge.ChangeFn<J>,
    message?: string
  ) {
    let change = this.syncer.change(docId, changeFn, message);
    await this._idb.storeChange(docId, change);
  }

  async deleteDevice(id: ContactId): Promise<void> {
    this.log('deleteContact', id);
    await this.change<DeviceList>(DEVICE_LIST, (doc: DeviceList) => {
      let idx = doc.devices.findIndex((c) => c.id === id);
      delete doc.devices[idx];
    });
  }

  async deleteContact(id: ContactId): Promise<void> {
    this.log('deleteContact', id);
    await this.change<ContactList>(CONTACT_LIST, (doc: ContactList) => {
      let idx = doc.contacts.findIndex((c) => c.id === id);
      delete doc.contacts[idx];
    });
  }

  async addDevice(key: Key) {
    let id = uuid();
    let discoveryKey = await crypto.computeDiscoveryKey(key);
    let device: IDevice = {
      id,
      device: 1,
      key,
      discoveryKey,
    };
    this.log('addDevice', key);
    await this.change<DeviceList>(DEVICE_LIST, (doc: DeviceList) => {
      doc.devices.push(device);
    });
    return id;
  }

  /**
   * Add a contact.
   */
  async addContact(key: Key, moniker: string): Promise<ContactId> {
    let id = uuid();
    let discoveryKey = await crypto.computeDiscoveryKey(key);
    let contact: IContact = {
      id,
      key,
      device: 0,
      moniker,
      discoveryKey,
    };
    this.log('addContact', key, moniker);
    //@ts-ignore
    await this.change(CONTACT_LIST, (doc: ContactList) => {
      doc.contacts.push(contact);
    });
    return id;
  }

  /**
   * Open the database. This is called automatically when you create the
   * instance and you don't need to call it.
   * @returns When the database has been opened
   */
  async open(): Promise<any[]> {
    this.log('opening', this._opening);
    if (this._opening)
      return new Promise((resolve) => {
        this.once('open', resolve);
      });
    this._opening = true;
    if (this._opened) return;
    this._idb = new DB(this.dbname);
    await this._loadDocument(CONTACT_LIST);
    this.log('got contacts', this.root.contacts);
    await this._loadDocument(DEVICE_LIST);
    if (this.root.contacts) {
      // LOAD EXISTING DOCUMENTS
      let c = 0;
      this.log('loading contacts+devices', this.all);
      let tasks = [];
      this.all.forEach(async (contact) => {
        c++;
        let docId = contact.discoveryKey;
        this.log('loading', docId);
        tasks.push(this._loadDocument(docId));
      });
      this.log(`loaded ${c} existing docs`);
      this.log('got contacts:', this.root.contacts);
      this.log('got devices:', this.devices);
      return Promise.all(tasks);
    } else {
      // NEW INSTANCE!
      this.log('new instance!');
      //@ts-ignore
      await this.addDocument(CONTACT_LIST, (doc: ContactList) => {
        doc.contacts = [];
        doc.settings = {};
      });

      //@ts-ignore
      await this.addDocument(DEVICE_LIST, (doc: DeviceList) => {
        doc.devices = [];
      });
      return;
    }
  }

  /**
   * Update an existing contact in the database. The contact object should have
   * an `id`. The only valid properties you can change are the moniker and avatar.
   * @param {ContactId} id - The id of the contact to update
   * @param {string} moniker - The contact's new moniker
   */
  editMoniker(id: ContactId, moniker: string): Promise<void> {
    return this.change<ContactList>(CONTACT_LIST, (doc: ContactList) => {
      let contacts = doc.contacts.filter((c) => c.id === id);
      if (!contacts.length)
        this.error(new Error('Could not find contact with id=' + id));
      contacts[0].moniker = moniker;
    });
  }

  /**
   * Update an existing contact in the database. The contact object should have
   * an `id`. The only valid properties you can change are the moniker and avatar.
   * @param {ContactId} id - The id of the contact to update
   * @param {string} avatar - Stringified image of the contact's new avatar.
   */
  editAvatar(id: ContactId, avatar: string): Promise<void> {
    return this.change(CONTACT_LIST, (doc: ContactList) => {
      let contacts = doc.contacts.filter((c) => c.id === id);
      if (!contacts.length)
        this.error(new Error('Could not find contact with id=' + id));
      contacts[0].avatar = avatar;
    });
  }

  getContactById(id: ContactId): IContact {
    let contacts = this.all.filter((c) => c.id === id);
    if (!contacts.length)
      this.error(new Error('No contact or device with id ' + id));
    return this._hydrateContact(contacts[0]);
  }

  /**
   * Get contact by discovery key
   * @param {string} discoveryKey - the discovery key for this contact
   */
  getContactByDiscoveryKey(discoveryKey: string): IContact {
    let contacts = this.all.filter((c) => c.discoveryKey === discoveryKey);
    if (!contacts.length) {
      this.error(
        new Error(
          'No contact with that document? that shouldnt be possible. Maybe you cleared your cache...'
        )
      );
    }

    return this._hydrateContact(contacts[0]);
  }

  async destroy() {
    this._opened = false;
    this.syncer.destroy();
    return this._idb.destroy();
  }

  async addDocument(
    docId: DocumentId,
    changeFn: Automerge.ChangeFn<System | T>
  ): Promise<DocumentId> {
    let doc = Automerge.change(Automerge.init('0000'), { time: 0 }, changeFn);
    let change = Automerge.Frontend.getLastLocalChange(doc);
    this.log('addDocument', docId);
    await this._idb.storeChange(docId, change);
    return this._loadDocument(docId);
  }

  private async _loadDocument(docId: DocumentId): Promise<DocumentId> {
    let doc = await this._idb.getDoc(docId);
    let state = doc.serializedDoc
      ? Backend.load(doc.serializedDoc)
      : Backend.init();

    let syncer = await this.syncer.loadDocument(docId, doc.changes, state);

    syncer.on('patch', ({ patch, changes }) => {
      changes.forEach(async (c) => {
        await this._idb.storeChange(docId, c);
      });
      if (docId === CONTACT_LIST) {
        if (changes.length) this.emit('CONTACT_LIST_CHANGE');
      } else {
        this.emit('patch', { docId, patch, changes });
      }
    });
    return docId;
  }

  private _hydrateContact(contact: IContact): IContact {
    let isConnected = this.isConnected(contact);
    return { ...contact, isConnected };
  }
}
