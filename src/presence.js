/**
 * src/presence.js — Collaborative Cursor Presence System
 *
 * Broadcasts the local user's cursor position as ephemeral presence data
 * over all active transports (BroadcastChannel, WebRTC), and renders
 * remote peers' cursors as colored marker overlays on the textarea.
 *
 * Presence is NOT part of the CRDT operation log — it is ephemeral,
 * not persisted, and not replayed on sync. Stale cursors are cleaned
 * up after a configurable timeout (default 5 seconds).
 *
 * Zero external dependencies.
 */

// ============================================================================
// 1. COLOR PALETTE — Deterministic per-site color assignment
// ============================================================================

/**
 * High-contrast cursor colors that work on the dark slate background (#0f172a).
 * Hash of siteId selects one deterministically.
 */
const CURSOR_COLORS = [
  '#f472b6', // Pink
  '#a78bfa', // Violet
  '#34d399', // Emerald
  '#fbbf24', // Amber
  '#f87171', // Red
  '#60a5fa', // Blue
];

/**
 * Returns a deterministic color for a given siteId.
 * @param {string} siteId
 * @returns {string} CSS color value
 */
export function getColorForSite(siteId) {
  let hash = 0;
  for (let i = 0; i < siteId.length; i++) {
    hash += siteId.charCodeAt(i);
  }
  return CURSOR_COLORS[hash % CURSOR_COLORS.length];
}

// ============================================================================
// 2. THROTTLE UTILITY
// ============================================================================

/**
 * Creates a simple throttle wrapper. Calls fn at most once per intervalMs.
 * Leading call is immediate; trailing calls within the interval are collapsed.
 *
 * @param {Function} fn - Function to throttle
 * @param {number} intervalMs - Minimum interval between calls
 * @returns {Function} Throttled function
 */
export function throttle(fn, intervalMs) {
  let lastCall = 0;
  let timer = null;

  const throttled = (...args) => {
    const now = Date.now();
    const elapsed = now - lastCall;

    if (elapsed >= intervalMs) {
      lastCall = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        lastCall = Date.now();
        timer = null;
        fn(...args);
      }, intervalMs - elapsed);
    }
  };

  throttled.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return throttled;
}

// ============================================================================
// 3. PRESENCE MANAGER
// ============================================================================

/**
 * Manages collaborative cursor presence — broadcasting local cursor state
 * and rendering remote peers' cursors as colored overlay markers.
 */
export class PresenceManager {
  /**
   * @param {string} siteId - Local site identifier
   * @param {HTMLTextAreaElement} textarea - The editor textarea element
   * @param {HTMLElement} editorContainer - Container wrapping the textarea (position: relative)
   * @param {Object} [options]
   * @param {number} [options.throttleMs=50] - Broadcast throttle interval
   * @param {number} [options.staleTimeoutMs=5000] - Remove stale cursors after this many ms
   */
  constructor(siteId, textarea, editorContainer, options = {}) {
    this.siteId = siteId;
    this.textarea = textarea;
    this.editorContainer = editorContainer;
    this.throttleMs = options.throttleMs ?? 50;
    this.staleTimeoutMs = options.staleTimeoutMs ?? 5000;
    this.label = siteId.slice(0, 10);

    /** @type {Map<string, { cursorIndex: number, selectionEnd: number, label: string, color: string, lastSeen: number }>} */
    this.peers = new Map();

    /** @type {Array<{ transport: object, unsubscribe: () => void }>} */
    this._transportBindings = [];

    // Create overlay elements
    this._createOverlay();
    this._createMirror();

    // Throttled broadcast function
    this._throttledBroadcast = throttle(() => this._doBroadcast(), this.throttleMs);

    // Listen for local cursor changes
    this._onSelectionChange = () => this._throttledBroadcast();
    this.textarea.addEventListener('keyup', this._onSelectionChange);
    this.textarea.addEventListener('click', this._onSelectionChange);
    this.textarea.addEventListener('input', this._onSelectionChange);
    this.textarea.addEventListener('select', this._onSelectionChange);

    // Sync overlay scroll with textarea scroll
    this._onScroll = () => this._renderAllCursors();
    this.textarea.addEventListener('scroll', this._onScroll);

    // Staleness cleanup timer
    this._cleanupInterval = setInterval(() => this._cleanupStalePeers(), this.staleTimeoutMs);
  }

  // --------------------------------------------------------------------------
  // Transport management
  // --------------------------------------------------------------------------

  /**
   * Registers a transport (LocalSync or RemoteSync) for presence messages.
   * @param {object} transport - Must have broadcastPresence() and onPresence()
   */
  addTransport(transport) {
    if (!transport || typeof transport.broadcastPresence !== 'function') return;

    const unsubscribe = transport.onPresence((presence) => {
      this._handleRemotePresence(presence);
    });

    this._transportBindings.push({ transport, unsubscribe });
  }

  /**
   * Removes a transport.
   * @param {object} transport
   */
  removeTransport(transport) {
    const idx = this._transportBindings.findIndex(b => b.transport === transport);
    if (idx !== -1) {
      this._transportBindings[idx].unsubscribe();
      this._transportBindings.splice(idx, 1);
    }
  }

  // --------------------------------------------------------------------------
  // Broadcasting
  // --------------------------------------------------------------------------

  /** @private */
  _doBroadcast() {
    const data = {
      siteId: this.siteId,
      cursorIndex: this.textarea.selectionStart,
      selectionEnd: this.textarea.selectionEnd,
      label: this.label,
    };

    for (const { transport } of this._transportBindings) {
      transport.broadcastPresence(data);
    }
  }

  // --------------------------------------------------------------------------
  // Receiving
  // --------------------------------------------------------------------------

  /** @private */
  _handleRemotePresence(presence) {
    if (!presence || presence.siteId === this.siteId) return;

    this.peers.set(presence.siteId, {
      cursorIndex: presence.cursorIndex,
      selectionEnd: presence.selectionEnd,
      label: presence.label || presence.siteId.slice(0, 10),
      color: getColorForSite(presence.siteId),
      lastSeen: Date.now(),
    });

    this._renderAllCursors();
  }

  // --------------------------------------------------------------------------
  // Staleness cleanup
  // --------------------------------------------------------------------------

  /** @private */
  _cleanupStalePeers() {
    const now = Date.now();
    let changed = false;
    for (const [siteId, peer] of this.peers) {
      if (now - peer.lastSeen > this.staleTimeoutMs) {
        this.peers.delete(siteId);
        changed = true;
      }
    }
    if (changed) this._renderAllCursors();
  }

  // --------------------------------------------------------------------------
  // Overlay DOM creation
  // --------------------------------------------------------------------------

  /** @private */
  _createOverlay() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'presence-overlay';
    this.overlay.style.cssText = `
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      pointer-events: none;
      overflow: hidden;
      z-index: 5;
    `;
    this.editorContainer.appendChild(this.overlay);
  }

  /** @private */
  _createMirror() {
    this.mirror = document.createElement('div');
    this.mirror.className = 'presence-mirror';
    this.mirror.setAttribute('aria-hidden', 'true');
    this.mirror.style.cssText = `
      position: absolute;
      top: 0; left: 0;
      visibility: hidden;
      white-space: pre-wrap;
      overflow-wrap: break-word;
      word-wrap: break-word;
    `;
    this.editorContainer.appendChild(this.mirror);
  }

  /**
   * Syncs the mirror div's CSS properties with the textarea so character
   * positions are measured accurately.
   * @private
   */
  _syncMirrorStyle() {
    const cs = window.getComputedStyle(this.textarea);
    const props = [
      'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
      'lineHeight', 'letterSpacing', 'wordSpacing',
      'textIndent', 'textTransform',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
      'boxSizing',
    ];
    for (const prop of props) {
      this.mirror.style[prop] = cs[prop];
    }
    // Width must match textarea's content width (including padding, excluding scrollbar)
    this.mirror.style.width = cs.width;
  }

  // --------------------------------------------------------------------------
  // Cursor position measurement (mirror div probe)
  // --------------------------------------------------------------------------

  /**
   * Measures the pixel position of a character index within the textarea
   * using the mirror div probe technique.
   *
   * @private
   * @param {number} charIndex - 0-based character index
   * @returns {{ top: number, left: number } | null} Position relative to overlay, or null if off-screen
   */
  _measureCursorPosition(charIndex) {
    this._syncMirrorStyle();

    const text = this.textarea.value;
    const before = text.slice(0, charIndex);
    const after = text.slice(charIndex);

    // Build mirror content with a probe span at the cursor position
    // Escape HTML entities to prevent tag injection
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    this.mirror.innerHTML =
      esc(before) +
      '<span id="presence-probe" style="display:inline;font-size:inherit;line-height:inherit;">|</span>' +
      esc(after);

    const probe = this.mirror.querySelector('#presence-probe');
    if (!probe) return null;

    const top = probe.offsetTop - this.textarea.scrollTop;
    const left = probe.offsetLeft - this.textarea.scrollLeft;

    // Clamp: hide if cursor is scrolled out of the visible textarea area
    const taRect = this.textarea.getBoundingClientRect();
    const containerRect = this.editorContainer.getBoundingClientRect();

    // Offset relative to container
    const offsetTop = this.textarea.offsetTop;
    const offsetLeft = this.textarea.offsetLeft;

    const finalTop = top + offsetTop;
    const finalLeft = left + offsetLeft;

    // Check visibility bounds
    if (finalTop < offsetTop - 2 || finalTop > offsetTop + this.textarea.clientHeight) {
      return null; // Cursor is scrolled out of view
    }

    return { top: finalTop, left: finalLeft };
  }

  // --------------------------------------------------------------------------
  // Rendering
  // --------------------------------------------------------------------------

  /**
   * Re-renders all remote peer cursor markers in the overlay.
   * @private
   */
  _renderAllCursors() {
    // Clear existing markers
    this.overlay.innerHTML = '';

    for (const [siteId, peer] of this.peers) {
      const pos = this._measureCursorPosition(peer.cursorIndex);
      if (!pos) continue;

      // Create cursor bar
      const cursor = document.createElement('div');
      cursor.className = 'presence-cursor';
      cursor.style.cssText = `
        position: absolute;
        top: ${pos.top}px;
        left: ${pos.left}px;
        width: 2px;
        height: 1.3em;
        background: ${peer.color};
        border-radius: 1px;
        transition: top 0.08s ease, left 0.08s ease;
        z-index: 6;
      `;

      // Create label flag
      const label = document.createElement('div');
      label.className = 'presence-label';
      label.textContent = peer.label;
      label.style.cssText = `
        position: absolute;
        top: -18px;
        left: -2px;
        background: ${peer.color};
        color: #0f172a;
        font-size: 10px;
        font-weight: 600;
        padding: 1px 4px;
        border-radius: 3px 3px 3px 0;
        white-space: nowrap;
        line-height: 14px;
        pointer-events: none;
      `;

      cursor.appendChild(label);
      this.overlay.appendChild(cursor);
    }
  }

  // --------------------------------------------------------------------------
  // Public: force re-render (called after remote ops change text layout)
  // --------------------------------------------------------------------------

  /**
   * Forces a re-render of all remote cursors. Call after remote ops change
   * the text content, since cursor positions may have shifted.
   */
  update() {
    this._renderAllCursors();
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Cleans up all DOM elements, event listeners, timers, and transport bindings.
   */
  destroy() {
    this._throttledBroadcast.cancel();
    clearInterval(this._cleanupInterval);

    this.textarea.removeEventListener('keyup', this._onSelectionChange);
    this.textarea.removeEventListener('click', this._onSelectionChange);
    this.textarea.removeEventListener('input', this._onSelectionChange);
    this.textarea.removeEventListener('select', this._onSelectionChange);
    this.textarea.removeEventListener('scroll', this._onScroll);

    for (const { unsubscribe } of this._transportBindings) {
      unsubscribe();
    }
    this._transportBindings = [];
    this.peers.clear();

    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
    if (this.mirror && this.mirror.parentNode) {
      this.mirror.parentNode.removeChild(this.mirror);
    }
  }
}
