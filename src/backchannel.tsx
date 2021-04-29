import Wormhole from './wormhole';
import type { SecureWormhole, MagicWormhole } from './wormhole';
import { arrayToHex } from 'enc-utils';
import {
  EncryptedProtocolMessage,
  Code,
  Database,
  ContactId,
  IContact,
  IMessage,
} from './db';
import { Client } from '@localfirst/relay-client';
import crypto from 'crypto';
import events from 'events';
import catnames from 'cat-names';
import config from './config.json';

let instance = null;

/**
 * The backchannel class manages the database and wormholes
 */
export class Backchannel extends events.EventEmitter {
  private _wormhole: MagicWormhole;
  private _db: Database;
  private _client: Client;
  private _sockets = new Map<number, WebSocket>();

  /**
   * Create a new backchannel client. Each instance represents a user opening
   * the backchannel app on their device.
   * @constructor
   * @param {string} dbName - the name of the database saved in IndexedDb
   */
  constructor(dbName: string, relay: string) {
    super();
    this._wormhole = Wormhole();
    this._db = new Database(dbName);
    this._client = new Client({
      url: relay,
    });
    this._setupListeners();
    // TODO: catch this error upstream and inform the user properly
    //
    this._client.once('server.connect', () => {
      this.emit('open');
    });
    this._db.open().catch((err) => {
      console.error(`Database open failed : ${err.stack}`);
    });
  }

  /**
   * Create a new contact in the database
   *
   * @param {IContact} contact - The contact to add to the database
   * @returns {ContactId} id - The local id number for this contact
   */
  async addContact(contact: IContact): Promise<ContactId> {
    let hash = crypto.createHash('sha256');
    hash.update(contact.key);
    contact.discoveryKey = hash.digest('hex');
    contact.moniker = contact.moniker || catnames.random();
    return this._db.contacts.add(contact);
  }

  /**
   * Update an existing contact in the database.
   * The contact object should have an `id`
   * @param {IContact} contact - The contact to update to the database
   */
  updateContact(contact: IContact): Promise<ContactId> {
    return this._db.contacts.put(contact);
  }

  /**
   * Send a message to a contact. Assumes that you've already
   * connected with the contact from listening to the `contact.connected` event
   * @param {WebSocket} socket: the open socket for the contact
   */
  async sendMessage(contactId: ContactId, text: string): Promise<IMessage> {
    // TODO: automerge this
    let msg: IMessage = {
      text: text,
      contact: contactId,
      timestamp: Date.now().toString(),
      incoming: false,
    };
    let socket: WebSocket = this._getSocketByContactId(contactId);
    let mid = await this._db.messages.add(msg);
    let contact = await this.getContactById(contactId);
    msg.id = mid;
    let sendable: string = IMessage.encode(msg, contact.key);
    socket.send(sendable);
    return msg;
  }

  async getMessagesByContactId(cid: ContactId): Promise<IMessage[]> {
    return this._db.messages.where('contact').equals(cid).toArray();
  }

  async getContactById(id: ContactId): Promise<IContact> {
    let contacts = await this._db.contacts.where('id').equals(id).toArray();
    if (!contacts.length) {
      throw new Error('No contact with id');
    }
    return contacts[0];
  }

  /**
   * Get contact by discovery key
   * @param {string} discoveryKey - the discovery key for this contact
   */
  async getContactByDiscoveryKey(discoveryKey: string): Promise<IContact> {
    let contacts = await this._db.contacts
      .where('discoveryKey')
      .equals(discoveryKey)
      .toArray();
    if (!contacts.length) {
      throw new Error(
        'No contact with that document? that shouldnt be possible. Maybe you cleared your cache...'
      );
    }

    return contacts[0];
  }

  /**
   * Join a document and start connecting to peers that have it
   * @param {DocumentId} documentId
   */
  connectToContact(contact: IContact) {
    if (!contact || !contact.discoveryKey)
      throw new Error('contact.discoveryKey required');
    this._client.join(contact.discoveryKey);
  }

  async connectToContactId(cid: ContactId) {
    let contact = await this.getContactById(cid);
    this.connectToContact(contact);
  }

  /**
   * Leave a document and disconnect from peers
   * @param {DocumentId} documentId
   */
  disconnectFromContact(contact: IContact) {
    if (!contact || !contact.discoveryKey)
      throw new Error('contact.discoveryKey required');
    this._client.leave(contact.discoveryKey);
  }

  async getCode(): Promise<Code> {
    let code = await this._wormhole.getCode();
    return code;
  }

  // sender/initiator
  async announce(code: Code): Promise<ContactId> {
    let connection = await this._wormhole.announce(code);
    return this._createContactFromWormhole(connection);
  }

  // redeemer/receiver
  async accept(code: Code): Promise<ContactId> {
    let connection = await this._wormhole.accept(code);
    return this._createContactFromWormhole(connection);
  }

  async listContacts(): Promise<IContact[]> {
    return await this._db.contacts.toArray();
  }

  /**
   * Is this contact currently connected to us? i.e., currently online and we
   * have an open websocket connection with them
   * @param {ContactId} contactId
   * @return {boolean} connected
   */
  isConnected(contactId: ContactId): boolean {
    return this._sockets.has(contactId);
  }

  /**
   * Destroy this instance and delete the data
   * Disconnects from all websocket clients
   * Danger! Unrecoverable!
   */
  async destroy() {
    await this._client.disconnectServer();
    await this._db.delete();
  }

  // PRIVATE
  private _getSocketByContactId(cid: ContactId): WebSocket {
    return this._sockets.get(cid);
  }

  private async _receiveMessage(
    contact: IContact,
    buffer: Buffer
  ): Promise<IMessage> {
    console.log(buffer);
    let message: IMessage = IMessage.decode(buffer, contact.key);
    message.contact = contact.id;
    let id = await this._db.messages.put(message);
    message.id = id;
    return message;
  }

  private _setupListeners() {
    this._client
      .on('peer.disconnect', async ({ documentId }) => {
        let contact = await this.getContactByDiscoveryKey(documentId);
        this._sockets.delete(contact.id);
        this.emit('contact.disconnected', { contact });
      })
      .on('peer.connect', async ({ socket, documentId }) => {
        let contact = await this.getContactByDiscoveryKey(documentId);
        socket.onmessage = (e) => {
          this._receiveMessage(contact, e.data)
            .then((message) => {
              this.emit('message', {
                contact,
                message,
              });
            })
            .catch((err) => {
              console.error('error', err);
              console.trace(err);
            });
        };

        socket.onerror = (err) => {
          console.error('error', err);
          console.trace(err);
        };

        this._sockets.set(contact.id, socket);
        let openContact = {
          socket,
          contact,
          documentId,
        };
        this.emit('contact.connected', openContact);
      });
  }

  private _createContactFromWormhole(
    connection: SecureWormhole
  ): Promise<ContactId> {
    let metadata = {
      key: arrayToHex(connection.key),
    };

    return this.addContact(metadata);
  }
}

export default function initialize() {
  if (instance) return instance;
  let dbName = 'backchannel_' + window.location.hash;
  console.log('connecting to relay', config.RELAY_URL);
  instance = new Backchannel(dbName, config.RELAY_URL);
  instance.on('error', function onError(err: Error) {
    console.error('Connection error');
    console.error(err);
  });

  return instance;
}
