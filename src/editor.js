/**
 * Editor binding connecting a DOM <textarea> to the RGA CRDT and LocalSync transport.
 * Captures user input, translates to CRDT ops, broadcasts to peers,
 * and renders remote ops while preserving local cursor position.
 */

/**
 * Computes the minimal diff between old and new text, utilizing prior selection
 * information when available to break ties for repeated adjacent characters.
 *
 * @param {string} oldText
 * @param {string} newText
 * @param {number} [selStart] - Selection start before edit
 * @param {number} [selEnd] - Selection end before edit
 * @returns {{ deleteIndex: number, deleteCount: number, insertedText: string, insertAfterIndex: number }}
 */
export function computeDiff(oldText, newText, selStart = 0, selEnd = 0) {
  // Case 1: Prior selection was replaced or deleted
  if (selStart < selEnd) {
    const selLen = selEnd - selStart;
    const insertLen = newText.length - (oldText.length - selLen);
    if (
      insertLen >= 0 &&
      newText.slice(0, selStart) === oldText.slice(0, selStart) &&
      newText.slice(selStart + insertLen) === oldText.slice(selEnd)
    ) {
      return {
        deleteIndex: selStart,
        deleteCount: selLen,
        insertedText: newText.slice(selStart, selStart + insertLen),
        insertAfterIndex: selStart - 1,
      };
    }
  }

  // Case 2: Simple insert at prior cursor without selection
  if (selStart === selEnd && newText.length > oldText.length) {
    const insertLen = newText.length - oldText.length;
    if (
      newText.slice(0, selStart) === oldText.slice(0, selStart) &&
      newText.slice(selStart + insertLen) === oldText.slice(selStart)
    ) {
      return {
        deleteIndex: selStart,
        deleteCount: 0,
        insertedText: newText.slice(selStart, selStart + insertLen),
        insertAfterIndex: selStart - 1,
      };
    }
  }

  // Case 3: Simple backspace (1 char deleted before cursor)
  if (selStart === selEnd && selStart > 0 && newText.length === oldText.length - 1) {
    if (
      newText.slice(0, selStart - 1) === oldText.slice(0, selStart - 1) &&
      newText.slice(selStart - 1) === oldText.slice(selStart)
    ) {
      return {
        deleteIndex: selStart - 1,
        deleteCount: 1,
        insertedText: '',
        insertAfterIndex: -1,
      };
    }
  }

  // Case 4: Simple forward delete (1 char deleted at cursor)
  if (selStart === selEnd && newText.length === oldText.length - 1) {
    if (
      newText.slice(0, selStart) === oldText.slice(0, selStart) &&
      newText.slice(selStart) === oldText.slice(selStart + 1)
    ) {
      return {
        deleteIndex: selStart,
        deleteCount: 1,
        insertedText: '',
        insertAfterIndex: -1,
      };
    }
  }

  // Fallback: Universal common prefix/suffix diff
  let prefix = 0;
  while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) {
    prefix++;
  }

  let oldEnd = oldText.length - 1;
  let newEnd = newText.length - 1;
  while (oldEnd >= prefix && newEnd >= prefix && oldText[oldEnd] === newText[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  const deleteIndex = prefix;
  const deleteCount = Math.max(0, oldEnd - prefix + 1);
  const insertedText = newText.slice(prefix, newEnd + 1);
  const insertAfterIndex = prefix - 1;

  return { deleteIndex, deleteCount, insertedText, insertAfterIndex };
}

/**
 * Connects an HTML `<textarea>` to an RGA CRDT instance and LocalSync transport.
 */
export class EditorBinding {
  /**
   * @param {HTMLTextAreaElement} textarea - The textarea element to bind.
   * @param {import('./crdt.js').CRDT} crdt - The CRDT document.
   * @param {import('./sync-local.js').LocalSync} sync - The BroadcastChannel sync transport.
   * @param {object} [options]
   * @param {() => void} [options.onUpdate] - Optional callback fired when text or stats change.
   */
  constructor(textarea, crdt, sync, options = {}) {
    if (!textarea) throw new Error('EditorBinding requires a textarea element');
    if (!crdt) throw new Error('EditorBinding requires a CRDT instance');
    if (!sync) throw new Error('EditorBinding requires a LocalSync instance');

    this.textarea = textarea;
    this.crdt = crdt;
    this.sync = sync;
    this.onUpdate = options.onUpdate || (() => {});

    this.isApplyingRemote = false;
    this.lastValue = this.crdt.toString();
    this.textarea.value = this.lastValue;

    this.lastSelectionStart = this.textarea.selectionStart || 0;
    this.lastSelectionEnd = this.textarea.selectionEnd || 0;

    // Attach DOM event listeners
    this._boundHandleInput = this._handleInput.bind(this);
    this._boundTrackSelection = this._trackSelection.bind(this);

    this.textarea.addEventListener('input', this._boundHandleInput);
    this.textarea.addEventListener('keydown', this._boundTrackSelection);
    this.textarea.addEventListener('keyup', this._boundTrackSelection);
    this.textarea.addEventListener('select', this._boundTrackSelection);
    this.textarea.addEventListener('pointerup', this._boundTrackSelection);
    this.textarea.addEventListener('click', this._boundTrackSelection);

    // Attach sync transport listeners
    this._unsubscribeRemoteOp = this.sync.onRemoteOp((op) => this.handleRemoteOp(op));
    this._unsubscribeSyncRequest = this.sync.onSyncRequest((requesterId) => {
      this.sync.sendSyncResponse(this.crdt.getOps(), requesterId);
    });
    this._unsubscribeSyncResponse = this.sync.onSyncResponse((ops) => {
      this.handleBulkRemoteOps(ops);
    });

    // Ask existing tabs for the current document
    this.sync.requestSync();
  }

  /**
   * Tracks current selection bounds before edits occur.
   * @private
   */
  _trackSelection() {
    if (this.isApplyingRemote) return;
    this.lastSelectionStart = this.textarea.selectionStart;
    this.lastSelectionEnd = this.textarea.selectionEnd;
  }

  /**
   * Handles user input from the textarea and generates corresponding CRDT ops.
   * @private
   */
  _handleInput() {
    if (this.isApplyingRemote) return;

    const oldText = this.lastValue;
    const newText = this.textarea.value;

    const { deleteIndex, deleteCount, insertedText, insertAfterIndex } = computeDiff(
      oldText,
      newText,
      this.lastSelectionStart,
      this.lastSelectionEnd
    );

    // 1. Delete characters
    if (deleteCount > 0) {
      const idsToDelete = [];
      for (let i = 0; i < deleteCount; i++) {
        const id = this.crdt.idAt(deleteIndex + i);
        if (id) idsToDelete.push(id);
      }
      for (const id of idsToDelete) {
        this.crdt.delete(id);
        this.sync.broadcastOp({ type: 'delete', id });
      }
    }

    // 2. Insert characters
    if (insertedText.length > 0) {
      let prevId = insertAfterIndex >= 0 ? this.crdt.idAt(insertAfterIndex) : null;
      for (let i = 0; i < insertedText.length; i++) {
        const char = insertedText[i];
        const node = this.crdt.insert(prevId, char);
        prevId = node.id;
        this.sync.broadcastOp({
          type: 'insert',
          id: node.id,
          char: node.char,
          afterId: node.afterId,
        });
      }
    }

    this.lastValue = this.crdt.toString();
    this.lastSelectionStart = this.textarea.selectionStart;
    this.lastSelectionEnd = this.textarea.selectionEnd;

    this.onUpdate();
  }

  /**
   * Applies a single remote operation while preserving local cursor position.
   * @param {object} op
   */
  handleRemoteOp(op) {
    this._applyWithCursorPreservation(() => {
      this.crdt.applyRemoteOp(op);
    });
  }

  /**
   * Applies an array of historical operations from another tab on initial sync.
   * @param {object[]} ops
   */
  handleBulkRemoteOps(ops) {
    if (!Array.isArray(ops) || ops.length === 0) return;
    this._applyWithCursorPreservation(() => {
      for (const op of ops) {
        this.crdt.applyRemoteOp(op);
      }
    });
  }

  /**
   * Executes a mutation callback and updates textarea text and cursor position
   * using relative Lamport ID anchors ("sticky cursors").
   * @private
   * @param {() => void} mutationFn
   */
  _applyWithCursorPreservation(mutationFn) {
    const selStart = this.textarea.selectionStart;
    const selEnd = this.textarea.selectionEnd;

    // Anchor cursor to preceding character Lamport IDs
    const startAnchor = this._getAnchor(selStart);
    const endAnchor = this._getAnchor(selEnd);

    this.isApplyingRemote = true;
    try {
      mutationFn();

      const newText = this.crdt.toString();
      this.lastValue = newText;
      this.textarea.value = newText;

      // Restore cursor positions from anchors
      const newStart = this._resolveAnchor(startAnchor);
      const newEnd = this._resolveAnchor(endAnchor);

      this.textarea.setSelectionRange(newStart, newEnd);
      this.lastSelectionStart = newStart;
      this.lastSelectionEnd = newEnd;
    } finally {
      this.isApplyingRemote = false;
    }

    this.onUpdate();
  }

  /**
   * Returns the Lamport ID of the character immediately preceding the given visible index,
   * or null if the index is at the document start.
   * @private
   * @param {number} visibleIndex
   * @returns {{ siteId: string, counter: number } | null}
   */
  _getAnchor(visibleIndex) {
    if (visibleIndex <= 0) return null;
    return this.crdt.idAt(visibleIndex - 1);
  }

  /**
   * Resolves a Lamport ID anchor to its updated visible character position.
   * If the anchor was deleted by a concurrent remote edit, falls back to the nearest
   * preceding visible character in the RGA sequence.
   *
   * @private
   * @param {{ siteId: string, counter: number } | null} anchorId
   * @returns {number}
   */
  _resolveAnchor(anchorId) {
    if (!anchorId) return 0;

    const idx = this.crdt.indexOfId(anchorId);
    if (idx !== -1) {
      return idx + 1;
    }

    // Anchor node was deleted: find closest preceding visible node
    const fallbackId = this.crdt.findPrecedingVisibleNode(anchorId);
    if (fallbackId) {
      const fallbackIdx = this.crdt.indexOfId(fallbackId);
      if (fallbackIdx !== -1) {
        return fallbackIdx + 1;
      }
    }

    return 0;
  }

  /**
   * Cleans up event listeners and sync subscriptions.
   */
  destroy() {
    this.textarea.removeEventListener('input', this._boundHandleInput);
    this.textarea.removeEventListener('keydown', this._boundTrackSelection);
    this.textarea.removeEventListener('keyup', this._boundTrackSelection);
    this.textarea.removeEventListener('select', this._boundTrackSelection);
    this.textarea.removeEventListener('pointerup', this._boundTrackSelection);
    this.textarea.removeEventListener('click', this._boundTrackSelection);

    if (this._unsubscribeRemoteOp) this._unsubscribeRemoteOp();
    if (this._unsubscribeSyncRequest) this._unsubscribeSyncRequest();
    if (this._unsubscribeSyncResponse) this._unsubscribeSyncResponse();
  }
}
