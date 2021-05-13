import { DiscoveryKey, ContactId, IContact } from './types';
import AutomergeDiscovery from './AutomergeDiscovery';
import Dexie from 'dexie';
import Automerge from 'automerge';
import { EventEmitter } from 'events';
import debug from 'debug';
import { v4 as uuid } from 'uuid';
import * as crypto from './crypto';

type DocumentId = string;

interface SavedBinary {
  id: string;
  binary: Automerge.BinaryDocument;
}

interface System {
  contacts: Automerge.List<IContact>;
}

export function createRootDoc<T>(
  changeFn: Automerge.ChangeFn<T>
): Automerge.Doc<T> {
  return Automerge.load(
    // @ts-ignore
    Automerge.Frontend.getLastLocalChange(
      Automerge.change(Automerge.init('0000'), { time: 0 }, changeFn)
    )
  );
}

class IndexedDatabase extends Dexie {
  documents: Dexie.Table<SavedBinary, ContactId>;

  constructor(dbname) {
    super(dbname);
    this.version(2).stores({
      documents: 'id',
    });
    this.documents = this.table('documents');
  }
}

const SYSTEM_ID = 'BACKCHANNEL_ROOT_DOCUMENT';

export class Database<T> extends EventEmitter {
  _idb: IndexedDatabase;
  _root: AutomergeDiscovery<System>;
  _syncers: Map<DocumentId, AutomergeDiscovery<T>>;

  opened: boolean;
  log: debug;

  static ROOT = SYSTEM_ID;

  constructor(dbname) {
    super();
    this._idb = new IndexedDatabase(dbname);
    this.open().then(() => {
      this.opened = true;
      this.log('open');
      this.emit('open');
    });
    this.log = debug('bc:db');
    this._syncers = new Map<DocumentId, AutomergeDiscovery<T>>();
  }

  error(err) {
    this.log('got error', err);
    throw new Error(err);
  }

  private _hydrateContact(contact: IContact): IContact {
    let isConnected = this.isConnected(contact);
    return { ...contact, isConnected };
  }

  getContacts(): IContact[] {
    return this._root.doc.contacts.map((c) => this._hydrateContact(c));
  }

  getRootDocument(): AutomergeDiscovery<System> {
    return this._root;
  }

  onDeviceConnect(peerId: string, send: Function): Function {
    let doc = this._root;
    return this._addPeer(doc, peerId, send);
  }

  _addPeer(doc: AutomergeDiscovery<unknown>, peerId: string, send: Function) {
    let contact = this.getContactById(peerId);
    this.log('adding peer', contact);
    let peer = {
      id: peerId,
      send,
      key: Buffer.from(contact.key, 'hex'),
    };
    return doc.addPeer(peerId, peer);
  }

  onPeerConnect(docId: DocumentId, peerId: string, send: Function): Function {
    let doc = this._syncer(docId);
    return this._addPeer(doc, peerId, send);
  }

  onDisconnect(docId, peerId) {
    let doc = this._syncer(docId);
    if (doc) doc.removePeer(peerId);
    else this._root.removePeer(peerId);
  }

  getDocument(docId: DocumentId): Automerge.Doc<T> {
    this.log('getting document', docId);
    let syncer = this._syncers.get(docId);
    if (!syncer) throw new Error('No doc for docId ' + docId);
    return syncer.doc;
  }

  /**
   * Is this contact currently connected to us? i.e., currently online and we
   * have an open websocket connection with them
   * @param {IContact} contact The contact object
   * @return {boolean} connected If the contact is currently connected
   */
  isConnected(contact: IContact): boolean {
    let docId;
    if (contact.device) {
      docId = SYSTEM_ID;
    } else {
      docId = contact.discoveryKey;
    }
    let doc = this._syncers.get(docId);
    this.log('isConnected', docId, contact.id);
    return doc && doc.hasPeer(contact.id);
  }

  getDocumentByContactId(contactId: ContactId): Automerge.Doc<T> {
    let contact = this.getContactById(contactId);
    let docId = contact.discoveryKey;
    return this.getDocument(docId);
  }

  change(docId: DocumentId, changeFn: Automerge.ChangeFn<T>) {
    this.log('changing', docId);
    let syncer = this._syncers.get(docId);
    if (!syncer)
      this.error(new Error('Document doesnt exist with id ' + docId));
    syncer.change(changeFn);
  }

  _createSyncer<J>(
    docId: DocumentId,
    doc: Automerge.Doc<J>
  ): AutomergeDiscovery<J> {
    let syncer = new AutomergeDiscovery<J>(doc);
    syncer.on('sync', (peerId) => {
      this.log('got sync', docId, peerId);
      this.emit('sync', { docId, peerId });
    });
    return syncer;
  }

  async open() {
    if (this.opened) return;
    let system = await this._idb.documents
      .where({ id: SYSTEM_ID })
      .limit(1)
      .toArray();
    if (system.length) {
      // LOAD EXISTING DOCUMENTS
      let c = 0;
      let systemDoc: Automerge.Doc<System> = Automerge.load(system[0].binary);
      this._root = this._createSyncer(SYSTEM_ID, systemDoc);
      await this._idb.documents.each(async (_doc) => {
        if (_doc.id !== SYSTEM_ID) {
          c++;
          let doc: Automerge.Doc<T> = Automerge.load(_doc.binary);
          this._syncers.set(_doc.id, this._createSyncer(_doc.id, doc));
        }
      });
      this.log(`loaded ${c} existing docs`);
      this.log('got contacts:', this._root.doc.contacts);
      return;
    } else {
      // NEW DOCUMENT!
      let systemDoc: Automerge.Doc<System> = createRootDoc<System>(
        (doc: System) => {
          doc.contacts = [];
        }
      );
      this._root = this._createSyncer(SYSTEM_ID, systemDoc);
      await this.save();
      this.log('new contact list:', this._root.doc.contacts);
      return;
    }
  }

  /**
   * Add a contact.
   */
  addContact(contact: IContact): ContactId {
    let id = uuid();
    contact.discoveryKey = crypto.computeDiscoveryKey(
      Buffer.from(contact.key, 'hex')
    );
    this._changeContactList((doc: System) => {
      contact.id = id;
      doc.contacts.push(contact);
    });
    return id;
  }

  /**
   * Add a document to the database.
   * @param docId Unique documentid for this document
   * @param doc An automerge document
   */
  addDocument(docId: DocumentId, doc: Automerge.Doc<T>) {
    let syncer: AutomergeDiscovery<T> = this._createSyncer<T>(docId, doc);
    this._syncers.set(docId, syncer);
    this.log('addDocument', docId, doc);
  }

  /**
   * Update an existing contact in the database. The contact object should have
   * an `id`. The only valid property you can change is the moniker.
   * @param {IContact} contact - The contact to update to the database
   */
  editMoniker(id: ContactId, moniker: string) {
    this._changeContactList((doc: System) => {
      let contacts = doc.contacts.filter((c) => c.id === id);
      if (!contacts.length)
        this.error(new Error('Could not find contact with id' + id));
      contacts[0].moniker = moniker;
    });
  }

  getContactById(id: ContactId): IContact {
    let contacts = this._root.doc.contacts.filter((c) => c.id === id);
    if (!contacts.length) this.error(new Error('No contact with id ' + id));
    return this._hydrateContact(contacts[0]);
  }

  /**
   * Get contact by discovery key
   * @param {string} discoveryKey - the discovery key for this contact
   */
  getContactByDiscoveryKey(discoveryKey: string): IContact {
    let contacts = this._root.doc.contacts.filter(
      (c) => c.discoveryKey === discoveryKey
    );
    if (!contacts.length) {
      this.error(
        new Error(
          'No contact with that document? that shouldnt be possible. Maybe you cleared your cache...'
        )
      );
    }

    return this._hydrateContact(contacts[0]);
  }

  async save() {
    await this._idb.documents.put({
      id: SYSTEM_ID,
      binary: Automerge.save(this._root.doc),
    });
    let c = 1;
    for (let d in this._syncers) {
      await this._save(d);
      c++;
    }
    this.log(`saved ${c} documents`);
  }

  async destroy() {
    let tasks = [];
    this._syncers.forEach((_, docId) => {
      tasks.push(this._idb.documents.delete(docId));
    });
    tasks.push(this._idb.documents.delete(SYSTEM_ID));
    this.log('destroying', tasks.length, 'documents');
    this.opened = false;
    return Promise.all(tasks);
  }

  _changeContactList(changeFn: Automerge.ChangeFn<System>) {
    this._root.change(changeFn);
  }

  async _save(id: DocumentId, _doc?: Automerge.Doc<T>): Promise<string> {
    let doc = _doc || this.getDocument(id);
    return this._idb.documents.put({
      id,
      binary: Automerge.save(doc),
    });
  }

  _syncer(docId) {
    return this._syncers.get(docId);
  }
}
