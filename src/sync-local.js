/**
 * Multi-tab synchronization using the browser-native BroadcastChannel API.
 * Broadcasts and receives CRDT operations across browser tabs on the same origin.
 * Zero external dependencies.
 */

export class LocalSync {
  /**
   * @param {string} siteId - Unique site identifier for the local replica.
   * @param {string} [channelName='rga-editor-sync'] - BroadcastChannel name.
   */
  constructor(siteId, channelName = 'rga-editor-sync') {
    if (!siteId) {
      throw new Error('LocalSync requires a valid siteId');
    }
    this.siteId = siteId;
    this.channelName = channelName;

    /** @type {BroadcastChannel} */
    this.channel = new BroadcastChannel(channelName);

    /** @type {Set<(op: object) => void>} */
    this.opCallbacks = new Set();

    /** @type {Set<(requesterSiteId: string) => void>} */
    this.syncRequestCallbacks = new Set();

    /** @type {Set<(ops: object[]) => void>} */
    this.syncResponseCallbacks = new Set();

    /** @type {Set<(presence: object) => void>} */
    this.presenceCallbacks = new Set();

    this.channel.onmessage = (event) => {
      this._handleMessage(event.data);
    };
  }

  /**
   * Broadcasts a local CRDT operation to all other open tabs.
   * @param {object} op - The operation ({ type, id, char?, afterId? })
   */
  broadcastOp(op) {
    if (!op) return;
    this.channel.postMessage({
      type: 'op',
      op,
      senderSiteId: this.siteId,
    });
  }

  /**
   * Registers a callback invoked whenever an operation arrives from another tab.
   * @param {(op: object) => void} callback
   * @returns {() => void} Unsubscribe function
   */
  onRemoteOp(callback) {
    this.opCallbacks.add(callback);
    return () => this.opCallbacks.delete(callback);
  }

  /**
   * Broadcasts a sync request asking any existing tab to reply with its operation log.
   * Call this when a new tab opens to catch up to the current document state.
   */
  requestSync() {
    this.channel.postMessage({
      type: 'sync-request',
      senderSiteId: this.siteId,
    });
  }

  /**
   * Registers a callback invoked when a newly opened tab requests current document state.
   * @param {(requesterSiteId: string) => void} callback
   * @returns {() => void} Unsubscribe function
   */
  onSyncRequest(callback) {
    this.syncRequestCallbacks.add(callback);
    return () => this.syncRequestCallbacks.delete(callback);
  }

  /**
   * Sends the current operation log in response to a sync-request from a peer tab.
   * @param {object[]} ops - The full operation log
   * @param {string} [targetSiteId] - Target replica ID (optional)
   */
  sendSyncResponse(ops, targetSiteId) {
    this.channel.postMessage({
      type: 'sync-response',
      ops,
      targetSiteId,
      senderSiteId: this.siteId,
    });
  }

  /**
   * Registers a callback invoked when an operation log arrives in response to a sync-request.
   * @param {(ops: object[]) => void} callback
   * @returns {() => void} Unsubscribe function
   */
  onSyncResponse(callback) {
    this.syncResponseCallbacks.add(callback);
    return () => this.syncResponseCallbacks.delete(callback);
  }

  /**
   * Broadcasts ephemeral presence data (cursor/selection) to peer tabs.
   * @param {object} presenceData - { siteId, cursorIndex, selectionEnd, label }
   */
  broadcastPresence(presenceData) {
    if (!presenceData) return;
    this.channel.postMessage({
      type: 'presence',
      presence: presenceData,
      senderSiteId: this.siteId,
    });
  }

  /**
   * Registers a callback invoked when presence data arrives from another tab.
   * @param {(presence: object) => void} callback
   * @returns {() => void} Unsubscribe function
   */
  onPresence(callback) {
    this.presenceCallbacks.add(callback);
    return () => this.presenceCallbacks.delete(callback);
  }

  /**
   * Closes the BroadcastChannel and cleans up all listeners.
   */
  destroy() {
    this.opCallbacks.clear();
    this.syncRequestCallbacks.clear();
    this.syncResponseCallbacks.clear();
    this.presenceCallbacks.clear();
    this.channel.close();
  }

  /**
   * Internal message dispatcher.
   * @private
   */
  _handleMessage(data) {
    if (!data || typeof data !== 'object') return;
    if (data.senderSiteId === this.siteId) return;

    if (data.type === 'op' && data.op) {
      for (const cb of this.opCallbacks) {
        cb(data.op);
      }
    } else if (data.type === 'sync-request') {
      for (const cb of this.syncRequestCallbacks) {
        cb(data.senderSiteId);
      }
    } else if (data.type === 'sync-response' && Array.isArray(data.ops)) {
      if (!data.targetSiteId || data.targetSiteId === this.siteId) {
        for (const cb of this.syncResponseCallbacks) {
          cb(data.ops);
        }
      }
    } else if (data.type === 'presence' && data.presence) {
      for (const cb of this.presenceCallbacks) {
        cb(data.presence);
      }
    }
  }
}
