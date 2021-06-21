import { Client } from '@localfirst/relay-client';
import events from 'events';
import catnames from 'cat-names';
import debug from 'debug';
import Automerge from 'automerge';
import { v4 as uuid } from 'uuid';
import { serialize, deserialize } from 'bson';

import { ContactList, Database } from './db';
import { FileProgress, Blobs } from './blobs';
import {
  DocumentId,
  Key,
  MessageId,
  Code,
  ContactId,
  IDevice,
  IContact,
  TextMessage,
  FileMessage,
  IMessage,
  FileState,
  MessageType,
} from './types';
import { Wormhole } from './wormhole';
import { symmetric, EncryptedProtocolMessage } from './crypto';

export enum EVENTS {
  MESSAGE = 'MESSAGE',
  ACK = 'ACK',
  CONTACT_CONNECTED = 'contact.connected',
  CONTACT_DISCONNECTED = 'contact.disconnected',
  OPEN = 'open',
  CONTACT_LIST_SYNC = 'CONTACT_LIST_SYNC',
  ERROR = 'error',
  FILE_PROGRESS = 'progress',
  FILE_SENT = 'sent',
  FILE_DOWNLOAD = 'download',
  CLOSE = 'close',
  RELAY_CONNECT = 'relay.connect',
  RELAY_DISCONNECT = 'relay.disconnect',
}

export enum ERROR {
  UNREACHABLE = 404,
  PEER = 500,
}

export enum FileStates {
  QUEUED = 0,
  ERROR = 1,
  SUCCESS = 2,
  PROGRESS = 3,
}

export type BackchannelSettings = {
  relay: string;
};

export interface Mailbox {
  messages: Automerge.List<EncryptedProtocolMessage>;
}
/**
 * The backchannel class manages the database and wormholes.
 */
export class Backchannel extends events.EventEmitter {
  public db: Database<Mailbox>;
  private _wormhole: Wormhole;
  private _client: Client;
  private _open: boolean;
  private _blobs: Blobs;
  private log: debug;
  private relay: string;

  /**
   * Create a new backchannel client. Each instance represents a user opening
   * the backchannel app on their device. There is one Mailbox per contact which
   * is identified by the contact's discoveryKey.
   * @constructor
   * @param {string} dbName The name of the db for indexeddb
   * @param defaultRelay The default URL of the relay
   */
  constructor(dbName: string, _settings: BackchannelSettings) {
    super();

    this.db = new Database<Mailbox>(dbName);

    this._blobs = new Blobs();

    this._blobs.on('progress', (p: FileProgress) => {
      this.emit(EVENTS.FILE_PROGRESS, p);
    });

    this._blobs.on('error', (p: FileProgress) => {
      this.emit(EVENTS.ERROR, p);
    });

    this._blobs.on('sent', (p: FileProgress) => {
      this._updateFileState(p.id, p.contactId, FileState.SUCCESS);
      this.emit(EVENTS.FILE_SENT, p);
    });

    this._blobs.on('download', (p: FileProgress) => {
      this._updateFileState(p.id, p.contactId, FileState.SUCCESS);
      this.db.saveBlob(p.id, p.data);
      this.emit(EVENTS.FILE_DOWNLOAD, p);
    });

    this.db.on('patch', ({ docId, patch, changes }) => {
      changes.forEach((c) => {
        let change = Automerge.decodeChange(c);

        if (change.message === MessageType.TEXT) {
          let contact = this.db.getContactByDiscoveryKey(docId);
          this.emit(EVENTS.MESSAGE, { contactId: contact.id, docId });
        }

        if (change.message === MessageType.ACK) {
          try {
            let contact = this.db.getContactByDiscoveryKey(docId);
            this.deleteDevice(contact.id).then((_) => {
              this.emit(EVENTS.ACK, { contactId: contact.id, docId });
            });
          } catch (err) {
            // this is OK, just means that this device sent multiple tombstones
            // and we have already deleted this device on a previous ack
            this.emit(EVENTS.ACK, { contactId: null, docId });
          }
        }

        if (change.message === MessageType.TOMBSTONE) {
          let contact = this.db.getContactByDiscoveryKey(docId);
          let msg = {
            type: MessageType.ACK,
            timestamp: Date.now().toString(),
            target: contact.id,
          };
          this._addMessage(msg, contact).then(() => {
            this.log('destroying');
            this.destroy();
          });
        }
      });
    });

    this.db.on('CONTACT_LIST_CHANGE', this.onChangeContactList.bind(this));

    this.db.once('open', () => {
      this.relay =
        (this.db.settings && this.db.settings.relay) || _settings.relay;
      this.log('Connecting to relay', this.relay);
      let documentIds = this.db.documents;
      this._client = this._createClient(this.relay, documentIds);
      this._wormhole = new Wormhole(this._client);
      this.emit(EVENTS.OPEN);
    });
    this.log = debug('bc:backchannel');
  }

  onChangeContactList() {
    let tasks = [];
    this.contacts.forEach((c) => {
      try {
        let doc = this.db.getDocument(c.discoveryKey) as Automerge.Doc<Mailbox>;
        if (!doc.messages) throw new Error();
      } catch (err) {
        this.log('creating a document for contact');
        tasks.push(this._addContactDocument(c));
      }
    });

    Promise.all(tasks).then(() => {
      this.emit(EVENTS.CONTACT_LIST_SYNC);
    });
  }

  async updateSettings(newSettings: BackchannelSettings) {
    const documentIds = this.db.documents;
    if (newSettings.relay !== this.db.settings.relay) {
      this._client = this._createClient(newSettings.relay, documentIds);
      this._wormhole = new Wormhole(this._client);
    }
    let ready = { ...this.db.root.settings, ...newSettings };
    return this.db.changeRoot((doc: ContactList) => {
      doc.settings = ready;
    });
  }

  get settings() {
    return { ...this.db.settings, relay: this.relay };
  }

  opened() {
    return this._open;
  }

  /**
   * Create a one-time code for a new backchannel contact.
   * @returns {Code} code The code to use in announce
   */
  getCode(): Promise<Code> {
    return this._wormhole.getCode();
  }

  /**
   * Create a one-time code for a new backchannel contact.
   * @returns {Code} code The code to use in announce
   */
  getNumericCode(): Promise<Code> {
    return this._wormhole.getNumericCode();
  }

  /**
   * Open a websocket connection to the magic wormhole service and accept the
   * code. Once the contact has been established, a contact will
   * then be created with an anonymous handle and the id returned.
   *
   * @param {Code} code The code to accept
   * @param {number} timeout The timeout before giving up, default 20 seconds
   * @returns {ContactId} The ID of the contact in the database
   */
  async accept(code: Code, timeout = 60000): Promise<ContactId> {
    let sanitizedCode = code.toLowerCase().trim();
    let TWENTY_SECONDS = timeout;
    return new Promise(async (resolve, reject) => {
      setTimeout(() => {
        this._wormhole.leave(sanitizedCode);
        reject(
          new Error(`This code has expired. Try again with a different one.`)
        );
      }, TWENTY_SECONDS);
      try {
        let key: Key = await this._wormhole.accept(sanitizedCode);
        return resolve(key);
      } catch (err) {
        this._wormhole.leave(sanitizedCode);
        reject(
          new Error(
            'Secure connection failed. Did you type the code correctly? Try again.'
          )
        );
      }
    });
  }

  /**
   * This updates the moniker for a given contact and saves the contact in the database.
   * @param {ContactId} contactId The contact id to edit
   * @param {string} moniker The new moniker for this contact
   * @return {IContact} The new contact information
   */
  async editMoniker(contactId: ContactId, moniker: string): Promise<IContact> {
    this.log('editmoniker', contactId, moniker);
    await this.db.editMoniker(contactId, moniker);
    return this.db.getContactById(contactId);
  }

  async addDevice(key: Key): Promise<ContactId> {
    return this._addContact(key, true);
  }

  /**
   * This updates the avatar for a given contact.
   * @param {ContactId} contactId The contact id to edit
   * @param {string} avatar The new moniker for this contact
   * @return {IContact} The new contact information
   */
  async editAvatar(contactId: ContactId, avatar: string): Promise<IContact> {
    this.log('editAvatar,', contactId, avatar);
    await this.db.editAvatar(contactId, avatar);
    return this.db.getContactById(contactId);
  }

  /**
   * Create a new contact in the database
   *
   * @param {Key} key - The key add to the database
   * @returns {ContactId} id - The local id number for this contact
   */
  async addContact(key: Key, device?: boolean): Promise<ContactId> {
    return this._addContact(key, false);
  }

  async _addContact(key: Key, device?: boolean): Promise<ContactId> {
    let moniker = catnames.random();
    let id;
    if (device) {
      id = await this.db.addDevice(key);
    } else {
      id = await this.db.addContact(key, moniker);
    }
    let contact = this.db.getContactById(id);
    this.log('adding contact', contact.discoveryKey, contact);
    await this._addContactDocument(contact);
    return contact.id;
  }

  async _addContactDocument(contact: IContact) {
    let docId = contact.discoveryKey;
    await this.db.addDocument(docId, (doc: Mailbox) => {
      doc.messages = [];
    });
    return this.db.getDocument(docId);
  }

  _getEncryptedMessages(contactId: ContactId): EncryptedProtocolMessage[] {
    let contact = this.db.getContactById(contactId);

    try {
      //@ts-ignore
      let doc: Automerge.Doc<Mailbox> = this.db.getDocument(
        contact.discoveryKey
      );
      return doc.messages;
    } catch (err) {
      console.trace(err);
      throw new Error('Error getting messages, this should never happen.');
    }
  }

  /**
   * Get messages with another contact.
   * @param contactId The ID of the contact
   * @returns
   */
  async getMessagesByContactId(contactId: ContactId): Promise<IMessage[]> {
    let contact = this.db.getContactById(contactId);
    let messages = this._getEncryptedMessages(contactId);
    return Promise.all(
      messages.map((cipher) => {
        return this.decryptMessage(cipher, contact);
      })
    );
  }

  /**
   * Returns a list of contacts.
   * @returns An array of contacts
   */
  get contacts(): IContact[] {
    return this.db.getContacts();
  }

  get devices(): IDevice[] {
    return this.db.devices;
  }

  listContacts() {
    return this.contacts;
  }

  async hasTombstone(contact: IContact): Promise<boolean> {
    let messages = this._getEncryptedMessages(contact.id);
    if (messages.length === 0) return;
    let maybe_tombstone = await this.decryptMessage(messages.pop(), contact);
    return maybe_tombstone?.type === MessageType.TOMBSTONE;
  }

  /**
   * Sends a tombstone message, which tells the other device
   * to unlink itself and self-destruct.
   * @param {string} id The device id
   * @returns Once the message has been added to automerge
   */
  async sendTombstone(id: ContactId): Promise<void> {
    let contact = await this.db.getContactById(id);
    if (await this.hasTombstone(contact)) return;
    let msg: IMessage = {
      type: MessageType.TOMBSTONE,
      target: id,
      timestamp: Date.now().toString(),
    };
    return this._addMessage(msg, contact);
  }

  /**
   * Send a message to a contact. Assumes that you've already
   * connected with the contact from listening to the `contact.connected` event
   * @param {WebSocket} socket: the open socket for the contact
   */
  async sendMessage(contactId: ContactId, text: string): Promise<IMessage> {
    let msg: TextMessage = {
      id: uuid(),
      target: contactId,
      text: text,
      type: MessageType.TEXT,
      timestamp: Date.now().toString(),
    };
    this.log('sending message', msg);
    let contact = this.db.getContactById(contactId);
    await this._addMessage(msg, contact);
    return msg;
  }

  async sendFile(contactId: ContactId, file: File): Promise<FileMessage> {
    let msg: FileMessage = {
      id: uuid(),
      target: contactId,
      timestamp: Date.now().toString(),
      type: MessageType.FILE,
      mime_type: file.type,
      size: file.size,
      lastModified: file.lastModified,
      name: file.name,
      state: FileState.QUEUED,
    };
    let contact = this.db.getContactById(contactId);
    await this._addMessage(msg, contact);
    let meta = {
      id: msg.id,
      lastModified: msg.lastModified,
      mime_type: msg.mime_type,
      size: msg.size,
      name: msg.name,
    };
    try {
      let sent = await this._blobs.sendFile({
        contactId: contact.id,
        meta,
        file,
      });

      await this._updateFileState(
        msg.id,
        contact.id,
        sent ? FileState.SUCCESS : FileState.QUEUED
      );
    } catch (err) {
      this._updateFileState(msg.id, contactId, FileState.ERROR);
    }
    return msg;
  }

  /**
   * Start connecting to the contact.
   * @param {IContact} contact The contact to connect to
   */
  connectToContact(contact: IContact) {
    if (!contact || !contact.discoveryKey || contact.isConnected) return;
    this._client.join(contact.discoveryKey);
  }

  /**
   * Start connecting to the contact.
   * @param {ContactId} cid The contact id
   */
  connectToContactId(cid: ContactId) {
    this.log('connecting to contact with id', cid);
    let contact = this.db.getContactById(cid);
    this.connectToContact(contact);
  }

  /**
   * Start connecting to all known contacts. Danger: opens a websocket
   * connection for each contact which could be an expensive operation.
   */
  connectToAllContacts() {
    this.contacts.forEach((contact) => {
      this.connectToContact(contact);
    });
  }

  /**
   * Did the file message fail to send?
   * @param {FileMessage} msg
   * @returns true if there are pending files, false if no pending files
   */
  hasPendingFiles(msg: FileMessage): boolean {
    return this._blobs.hasPendingFiles(msg.target);
  }

  /**
   * Delete a contact in the database
   *
   * @param {ContactId} id - The local id number for this contact
   */
  async deleteContact(id: ContactId) {
    let contact = this.db.getContactById(id);
    this._client.leave(contact.discoveryKey);
    await this.db.deleteContact(id);
  }

  async deleteDevice(id: ContactId) {
    let contact = this.db.getContactById(id);
    this._client.leave(contact.discoveryKey);
    await this.db.deleteDevice(id);
  }

  /**
   * Unlink this device. Delete all devices you're linked with.
   * @returns
   */
  unlinkDevice(): Promise<void> {
    this._client.disconnectServer();
    return new Promise<void>((resolve, reject) => {
      this._client.on('server.disconnect', () => {
        let tasks = [];
        this.devices.forEach((d) => {
          tasks.push(this.deleteDevice(d.id));
        });

        Promise.all(tasks)
          .then((_) => {
            this._client = this._createClient(this.relay);
            resolve();
          })
          .catch(reject);
      });
    });
  }

  /**
   * Destroy this instance and delete the data. Disconnects from all websocket
   * clients.  Danger! Unrecoverable!
   */
  async destroy() {
    this._open = false;
    await this._client.disconnectServer();
    await this.db.destroy();
    this.emit(EVENTS.CLOSE);
  }

  async _encrypt(
    msg: Uint8Array,
    contact: IContact
  ): Promise<EncryptedProtocolMessage> {
    let cipher = await symmetric.encrypt(
      contact.key,
      Buffer.from(msg).toString('hex')
    );
    return cipher;
  }

  async _decrypt(
    cipher: EncryptedProtocolMessage,
    contact: IContact
  ): Promise<ArrayBuffer> {
    let plainText = await symmetric.decrypt(contact.key, cipher);
    return Uint8Array.from(Buffer.from(plainText, 'hex'));
  }

  async decryptMessage(
    cipher: EncryptedProtocolMessage,
    contact: IContact
  ): Promise<IMessage> {
    let decoded = await this._decrypt(cipher, contact);
    return deserialize(decoded) as IMessage;
  }

  private async _onPeerConnect(
    socket: WebSocket,
    documentId: DocumentId,
    userName: string
  ) {
    let onerror = (err) => {
      let code = ERROR.PEER;
      this.emit(EVENTS.ERROR, err, code);
      console.trace(err);
    };
    socket.addEventListener('error', onerror);

    if (documentId.startsWith('wormhole')) {
      // this is handled by wormhole.ts
      return this.log('got connection to ', documentId);
    }

    let contact = this.db.getContactByDiscoveryKey(documentId);
    let peerId = contact.id + '#' + userName;

    socket.binaryType = 'arraybuffer';
    this.log('onpeer connect', documentId);
    try {
      this._blobs.addPeer(contact.id, async (msg: Uint8Array) => {
        let cipher = await this._encrypt(msg, contact);
        let encoded = serialize({ msgType: 'files', msg: cipher });
        if (isOpen(socket)) socket.send(encoded);
        else throw new Error('SOCKET CLOSED');
      });

      let getAutomergeListener = (socket, docId, peerId) => {
        let automergeSend = (msg: Uint8Array) => {
          let msgType = 'automerge';
          // automerge wants you to encrypt inside the document
          // but not over the sync protocol.
          let encoded = serialize({ msgType, docId, msg });
          socket.send(encoded);
        };
        return this.db.onPeerConnect(peerId, docId, automergeSend);
      };

      let documentIds = this.db.getDocumentIds(contact);
      let listeners = {};
      documentIds.forEach((id) => {
        listeners[id] = getAutomergeListener(socket, id, peerId);
      });

      // Setup onmessage event
      let onmessage = (e) => {
        let decoded = deserialize(e.data); // msgType, msg
        this.log('onmessage', decoded);
        switch (decoded.msgType) {
          case 'files':
            this._decrypt(decoded.msg, contact).then((syncMsg) => {
              this._blobs.receiveFile(contact.id, syncMsg);
            });
            break;
          case 'automerge':
            let msg = Uint8Array.from(decoded.msg.buffer);
            let fn = listeners[decoded.docId];
            if (fn) fn(msg);
            break;
        }
      };
      socket.addEventListener('message', onmessage);

      // HACK: localfirst/relay-client also has a peer.disconnect event
      // but it is somewhat unreliable.
      let onclose = () => {
        let documentIds = this.db.getDocumentIds(contact);
        socket.removeEventListener('message', onmessage);
        socket.removeEventListener('close', onclose);
        documentIds.forEach((documentId) => {
          this.db.onDisconnect(documentId, peerId).then(() => {
            this.emit(EVENTS.CONTACT_DISCONNECTED, { contact });
          });
        });
      };
      socket.addEventListener('close', onclose);

      contact.isConnected = this.db.isConnected(contact);
      this.log('contact.connected', contact);
      let openContact = {
        socket,
        contact,
      };
      this.emit(EVENTS.CONTACT_CONNECTED, openContact);
    } catch (err) {
      this.emit(EVENTS.ERROR, err);
    }
  }

  private _createClient(relay: string, documentIds?: DocumentId[]): Client {
    let client = new Client({
      url: relay,
      documentIds,
    });

    client.on('error', (err) => {
      let error = {
        message: 'Relay unreachable',
        delay: client.retryDelay,
      };
      let code = ERROR.UNREACHABLE;
      this.emit(EVENTS.ERROR, error, code);
    });

    client.on('server.connect', () => {
      this.emit(EVENTS.RELAY_CONNECT);
      this.log('on server connect');
      this._open = true;
    });

    client.on('server.disconnect', () => {
      this.log('on server disconnect');
      this.emit(EVENTS.RELAY_DISCONNECT);
      this._open = false;
    });

    client.on('peer.connect', ({ socket, documentId, userName }) => {
      this._onPeerConnect(socket, documentId, userName);
    });

    return client;
  }

  private async _addMessage(msg: IMessage, contact: IContact) {
    let docId = contact.discoveryKey;
    let commitMessage = msg.type;
    let encrypted = await this._encrypt(serialize(msg), contact);
    let res = await this.db.change<Mailbox>(
      docId,
      (doc: Mailbox) => {
        doc.messages.push(encrypted);
      },
      commitMessage
    );
    return res;
  }

  private async _updateFileState(
    msgId: MessageId,
    contactId: ContactId,
    state: FileState
  ) {
    let contact = this.db.getContactById(contactId);
    if (!contact) return;
    let docId = contact.discoveryKey;

    let doc = this.db.getDocument(docId) as Automerge.Doc<Mailbox>
    return new Promise((resolve, reject) => {
      doc.messages.map((cipher: EncryptedProtocolMessage, idx: number) => {
        return this.decryptMessage(cipher, contact).then(message => {
          if (message.id === msgId) {
            this.db.change(docId, (doc: Mailbox) => {
              //@ts-ignore
              doc.messages[idx].state = state
            }).then(resolve).catch(reject);
          }
        })
      });
    })
  }
}

function isOpen(ws) {
  return ws.readyState === ws.OPEN;
}
