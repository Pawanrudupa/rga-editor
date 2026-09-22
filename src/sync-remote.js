/**
 * WebRTC peer-to-peer data channel transport for cross-device synchronization.
 * Uses manual copy/paste signaling without requiring a signaling server.
 * Zero external dependencies.
 */

export class RemoteSync {
  /**
   * @param {string} siteId - Unique site identifier for the local replica.
   * @param {object} [options]
   * @param {RTCIceServer[]} [options.iceServers] - STUN/TURN server configuration.
   */
  constructor(siteId, options = {}) {
    if (!siteId) {
      throw new Error('RemoteSync requires a valid siteId');
    }
    this.siteId = siteId;
    this.iceServers = options.iceServers || [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];

    /** @type {RTCPeerConnection | null} */
    this.pc = null;

    /** @type {RTCDataChannel | null} */
    this.dataChannel = null;

    /** @type {'disconnected' | 'connecting' | 'connected'} */
    this.status = 'disconnected';

    /** @type {Set<(op: object) => void>} */
    this.opCallbacks = new Set();

    /** @type {Set<(status: string) => void>} */
    this.statusCallbacks = new Set();

    /** @type {Set<(requesterSiteId: string) => void>} */
    this.syncRequestCallbacks = new Set();

    /** @type {Set<(ops: object[]) => void>} */
    this.syncResponseCallbacks = new Set();

    /** @type {Set<(presence: object) => void>} */
    this.presenceCallbacks = new Set();
  }

  /**
   * Step 1 (Host): Creates the RTCPeerConnection and RTCDataChannel, generates the SDP Offer,
   * waits for complete ICE gathering, and returns a self-contained SDP JSON string.
   *
   * @returns {Promise<string>} Serialized offer JSON with complete ICE candidates.
   */
  async createOffer() {
    this.destroy();
    this._setStatus('connecting');

    this.pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this._setupPcListeners();

    // Host creates the data channel
    this.dataChannel = this.pc.createDataChannel('rga-remote-sync', { ordered: true });
    this._setupDataChannelListeners(this.dataChannel);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    // Wait for complete ICE gathering (Vanilla ICE) so all candidates are in the SDP
    await this._waitForIceGathering(this.pc);

    return JSON.stringify({
      type: this.pc.localDescription.type,
      sdp: this.pc.localDescription.sdp,
    });
  }

  /**
   * Step 2 (Guest): Accepts the Host's offer, creates the SDP Answer,
   * waits for complete ICE gathering, and returns the Answer JSON string.
   *
   * @param {string | object} offerInput - Host's serialized offer JSON.
   * @returns {Promise<string>} Serialized answer JSON with complete ICE candidates.
   */
  async acceptOfferAndCreateAnswer(offerInput) {
    this.destroy();
    this._setStatus('connecting');

    const offerObj = typeof offerInput === 'string' ? JSON.parse(offerInput) : offerInput;

    this.pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this._setupPcListeners();

    // Guest receives the data channel from Host
    this.pc.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this._setupDataChannelListeners(this.dataChannel);
    };

    await this.pc.setRemoteDescription(new RTCSessionDescription(offerObj));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    await this._waitForIceGathering(this.pc);

    return JSON.stringify({
      type: this.pc.localDescription.type,
      sdp: this.pc.localDescription.sdp,
    });
  }

  /**
   * Step 3 (Host): Accepts the Guest's answer to complete the P2P connection.
   *
   * @param {string | object} answerInput - Guest's serialized answer JSON.
   * @returns {Promise<void>}
   */
  async acceptAnswer(answerInput) {
    if (!this.pc) {
      throw new Error('Cannot accept answer: RTCPeerConnection not initialized (call createOffer first)');
    }

    const answerObj = typeof answerInput === 'string' ? JSON.parse(answerInput) : answerInput;
    await this.pc.setRemoteDescription(new RTCSessionDescription(answerObj));
  }

  /**
   * Broadcasts an operation over the WebRTC data channel if open.
   * @param {object} op - CRDT operation
   */
  broadcastOp(op) {
    if (!op) return;
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      try {
        this.dataChannel.send(JSON.stringify({
          type: 'op',
          op,
          senderSiteId: this.siteId,
        }));
      } catch (err) {
        console.error('Error sending op over WebRTC data channel:', err);
      }
    }
  }

  /**
   * Sends the full operation log in response to a sync-request.
   * @param {object[]} ops
   */
  sendSyncResponse(ops) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      try {
        this.dataChannel.send(JSON.stringify({
          type: 'sync-response',
          ops,
          senderSiteId: this.siteId,
        }));
      } catch (err) {
        console.error('Error sending sync-response over WebRTC:', err);
      }
    }
  }

  /**
   * Registers a callback for remote operations received over WebRTC.
   * @param {(op: object) => void} callback
   * @returns {() => void}
   */
  onRemoteOp(callback) {
    this.opCallbacks.add(callback);
    return () => this.opCallbacks.delete(callback);
  }

  /**
   * Registers a callback for connection status changes.
   * @param {(status: string) => void} callback
   * @returns {() => void}
   */
  onStatusChange(callback) {
    this.statusCallbacks.add(callback);
    return () => this.statusCallbacks.delete(callback);
  }

  /**
   * Registers a callback when the remote peer requests current document state.
   * @param {(requesterSiteId: string) => void} callback
   * @returns {() => void}
   */
  onSyncRequest(callback) {
    this.syncRequestCallbacks.add(callback);
    return () => this.syncRequestCallbacks.delete(callback);
  }

  /**
   * Registers a callback when historical operations arrive via sync-response.
   * @param {(ops: object[]) => void} callback
   * @returns {() => void}
   */
  onSyncResponse(callback) {
    this.syncResponseCallbacks.add(callback);
    return () => this.syncResponseCallbacks.delete(callback);
  }

  /**
   * Broadcasts ephemeral presence data over the WebRTC data channel.
   * @param {object} presenceData - { siteId, cursorIndex, selectionEnd, label }
   */
  broadcastPresence(presenceData) {
    if (!presenceData) return;
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      try {
        this.dataChannel.send(JSON.stringify({
          type: 'presence',
          presence: presenceData,
          senderSiteId: this.siteId,
        }));
      } catch (err) {
        // Presence is ephemeral — silently drop on send failure
      }
    }
  }

  /**
   * Registers a callback for remote presence data received over WebRTC.
   * @param {(presence: object) => void} callback
   * @returns {() => void}
   */
  onPresence(callback) {
    this.presenceCallbacks.add(callback);
    return () => this.presenceCallbacks.delete(callback);
  }

  /**
   * Waits for complete ICE gathering before serializing SDP.
   * @private
   * @param {RTCPeerConnection} pc
   * @param {number} [timeoutMs=2500]
   * @returns {Promise<void>}
   */
  _waitForIceGathering(pc, timeoutMs = 2500) {
    if (pc.iceGatheringState === 'complete') {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let resolved = false;

      const finish = () => {
        if (!resolved) {
          resolved = true;
          pc.removeEventListener('icegatheringstatechange', check);
          clearTimeout(timer);
          resolve();
        }
      };

      const check = () => {
        if (pc.iceGatheringState === 'complete') {
          finish();
        }
      };

      pc.addEventListener('icegatheringstatechange', check);
      const timer = setTimeout(finish, timeoutMs);
    });
  }

  /**
   * Sets up peer connection state listeners.
   * @private
   */
  _setupPcListeners() {
    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (state === 'connected') {
        this._setStatus('connected');
      } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this._setStatus('disconnected');
      }
    };
  }

  /**
   * Sets up RTCDataChannel message and lifecycle listeners.
   * @private
   * @param {RTCDataChannel} dc
   */
  _setupDataChannelListeners(dc) {
    dc.onopen = () => {
      this._setStatus('connected');
      // Ask peer for initial document state
      try {
        dc.send(JSON.stringify({
          type: 'sync-request',
          senderSiteId: this.siteId,
        }));
      } catch (e) {
        console.error('Failed to send sync-request on data channel open:', e);
      }
    };

    dc.onclose = () => {
      this._setStatus('disconnected');
    };

    dc.onerror = (err) => {
      console.error('WebRTC DataChannel error:', err);
      this._setStatus('disconnected');
    };

    dc.onmessage = (event) => {
      this._handleDataChannelMessage(event.data);
    };
  }

  /**
   * Dispatches incoming DataChannel messages.
   * @private
   */
  _handleDataChannelMessage(raw) {
    try {
      const data = JSON.parse(raw);
      if (!data || data.senderSiteId === this.siteId) return;

      if (data.type === 'op' && data.op) {
        for (const cb of this.opCallbacks) {
          cb(data.op);
        }
      } else if (data.type === 'sync-request') {
        for (const cb of this.syncRequestCallbacks) {
          cb(data.senderSiteId);
        }
      } else if (data.type === 'sync-response' && Array.isArray(data.ops)) {
        for (const cb of this.syncResponseCallbacks) {
          cb(data.ops);
        }
      } else if (data.type === 'presence' && data.presence) {
        for (const cb of this.presenceCallbacks) {
          cb(data.presence);
        }
      }
    } catch (err) {
      console.error('Failed to parse WebRTC DataChannel message:', err);
    }
  }

  /**
   * Updates status and notifies listeners.
   * @private
   */
  _setStatus(newStatus) {
    if (this.status !== newStatus) {
      this.status = newStatus;
      for (const cb of this.statusCallbacks) {
        cb(newStatus);
      }
    }
  }

  /**
   * Closes data channel and peer connection.
   */
  destroy() {
    if (this.dataChannel) {
      try { this.dataChannel.close(); } catch (_) {}
      this.dataChannel = null;
    }
    if (this.pc) {
      try { this.pc.close(); } catch (_) {}
      this.pc = null;
    }
    this._setStatus('disconnected');
  }
}
