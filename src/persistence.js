/**
 * Offline storage and operation queue using IndexedDB.
 * Zero external dependencies.
 * Provides an in-memory fallback for environments without native indexedDB (e.g. Node.js).
 */

import { idKey } from './clock.js';

export class OfflineStore {
  /**
   * @param {string} [dbName='rga-crdt-db']
   * @param {number} [version=1]
   */
  constructor(dbName = 'rga-crdt-db', version = 1) {
    this.dbName = dbName;
    this.version = version;
    /** @type {IDBDatabase | null} */
    this.db = null;
    this.isSupported = typeof indexedDB !== 'undefined';

    // In-memory fallback stores for environments without IndexedDB (e.g. Node.js)
    this._memQueue = new Map();
    this._memAllOps = new Map();

    this._isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;

    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this._isOnline = true;
      });
      window.addEventListener('offline', () => {
        this._isOnline = false;
      });
    }
  }

  /**
   * Initializes the IndexedDB database and object stores.
   * @returns {Promise<void>}
   */
  async init() {
    if (!this.isSupported) return;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('offline_queue')) {
          db.createObjectStore('offline_queue', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('all_ops')) {
          db.createObjectStore('all_ops', { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve();
      };

      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }

  /**
   * Queues an operation while offline.
   * Keyed by Lamport op ID to prevent duplicate insertions into the queue.
   *
   * @param {object} op - The operation ({ type, id, char?, afterId? })
   * @returns {Promise<void>}
   */
  async queueOp(op) {
    if (!op || !op.id) return;
    const key = idKey(op.id);
    const entry = { key, op, timestamp: Date.now() };

    if (!this.isSupported || !this.db) {
      this._memQueue.set(key, entry);
      return;
    }

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('offline_queue', 'readwrite');
      const store = tx.objectStore('offline_queue');
      const req = store.put(entry);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Retrieves all currently queued offline operations in insertion order.
   * @returns {Promise<object[]>}
   */
  async getQueuedOps() {
    if (!this.isSupported || !this.db) {
      const entries = Array.from(this._memQueue.values());
      entries.sort((a, b) => a.timestamp - b.timestamp);
      return entries.map(e => e.op);
    }

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('offline_queue', 'readonly');
      const store = tx.objectStore('offline_queue');
      const req = store.getAll();
      req.onsuccess = () => {
        const entries = req.result || [];
        entries.sort((a, b) => a.timestamp - b.timestamp);
        resolve(entries.map(e => e.op));
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Removes a specific operation from the offline queue.
   * @param {object} opId
   * @returns {Promise<void>}
   */
  async removeQueuedOp(opId) {
    if (!opId) return;
    const key = idKey(opId);

    if (!this.isSupported || !this.db) {
      this._memQueue.delete(key);
      return;
    }

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('offline_queue', 'readwrite');
      const store = tx.objectStore('offline_queue');
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Clears all queued offline operations.
   * @returns {Promise<void>}
   */
  async clearQueue() {
    if (!this.isSupported || !this.db) {
      this._memQueue.clear();
      return;
    }

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('offline_queue', 'readwrite');
      const store = tx.objectStore('offline_queue');
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Replays the offline queue:
   * 1. Dedupes against CRDT state (ops already in CRDT are not double-applied).
   * 2. Broadcasts each queued op to the provided broadcast callbacks.
   * 3. Clears the queue upon completion.
   *
   * @param {import('./crdt.js').CRDT} crdt
   * @param {Array<(op: object) => void>} broadcastFns - Broadcast callbacks (e.g. BroadcastChannel, WebRTC)
   * @returns {Promise<number>} Number of replayed operations
   */
  async replayQueue(crdt, broadcastFns = []) {
    const queuedOps = await this.getQueuedOps();
    if (queuedOps.length === 0) return 0;

    let replayedCount = 0;
    for (const op of queuedOps) {
      // 1. Dedupe check: ensure op is not double-applied to local CRDT
      const key = idKey(op.id);
      const isAlreadyInDoc = crdt.nodesById.has(key);

      if (!isAlreadyInDoc) {
        crdt.applyRemoteOp(op);
      }

      // 2. Rebroadcast to peers
      for (const fn of broadcastFns) {
        if (typeof fn === 'function') {
          try {
            fn(op);
          } catch (err) {
            console.error('Error broadcasting replayed op:', err);
          }
        }
      }

      // 3. Save to persistent op log
      await this.saveOp(op);
      replayedCount++;
    }

    // 4. Clear queue
    await this.clearQueue();
    return replayedCount;
  }

  /**
   * Persists an operation to the long-term op log.
   * @param {object} op
   * @returns {Promise<void>}
   */
  async saveOp(op) {
    if (!op || !op.id) return;
    const key = idKey(op.id);
    const entry = { key, op, timestamp: Date.now() };

    if (!this.isSupported || !this.db) {
      this._memAllOps.set(key, entry);
      return;
    }

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('all_ops', 'readwrite');
      const store = tx.objectStore('all_ops');
      const req = store.put(entry);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Loads all historical operations from long-term storage.
   * @returns {Promise<object[]>}
   */
  async loadAllOps() {
    if (!this.isSupported || !this.db) {
      const entries = Array.from(this._memAllOps.values());
      entries.sort((a, b) => a.timestamp - b.timestamp);
      return entries.map(e => e.op);
    }

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('all_ops', 'readonly');
      const store = tx.objectStore('all_ops');
      const req = store.getAll();
      req.onsuccess = () => {
        const entries = req.result || [];
        entries.sort((a, b) => a.timestamp - b.timestamp);
        resolve(entries.map(e => e.op));
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }
}
