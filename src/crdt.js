/**
 * Replicated Growable Array (RGA) Text CRDT implementation.
 * Zero external dependencies, zero DOM/network/storage awareness.
 */

import { LamportClock, compareIds, idKey } from './clock.js';

/**
 * A Node in the RGA document sequence.
 * Stored both in a doubly-linked list (for linear traversal) and in a tree structure
 * (for deterministic sibling ordering based on afterId).
 */
export class Node {
  /**
   * @param {{ siteId: string, counter: number } | null} id - Globally unique Lamport timestamp.
   * @param {string | null} char - Character content (null for root sentinel).
   * @param {{ siteId: string, counter: number } | null} afterId - Predecessor node ID.
   */
  constructor(id, char, afterId) {
    this.id = id;
    this.char = char;
    this.afterId = afterId;
    this.deleted = false;
    this.prev = null;
    this.next = null;
    /** @type {Node[]} Sibling children inserted after this node, kept in descending ID order */
    this.children = [];
  }
}

/**
 * Pure RGA Conflict-free Replicated Data Type for text editing.
 */
export class CRDT {
  /**
   * @param {string} siteId - Unique replica identifier.
   */
  constructor(siteId) {
    if (!siteId) {
      throw new Error('CRDT requires a valid siteId');
    }
    this.siteId = siteId;
    this.clock = new LamportClock(siteId);

    // Sentinel root node representing the beginning of the document
    this.root = new Node(null, null, null);

    /** @type {Map<string, Node>} Fast lookup by Lamport ID string key */
    this.nodesById = new Map();
    this.nodesById.set(idKey(null), this.root);

    /** @type {Array<{ type: string, id: object, char?: string, afterId?: object }>} Operation log */
    this.ops = [];

    /** @type {Array<object>} Buffered operations waiting for dependencies */
    this.pendingOps = [];

    /** @type {Set<string>} Tombstone markers for deletes that arrived before the insert */
    this.pendingDeletes = new Set();
  }

  /**
   * Inserts a character immediately after afterId.
   * Generates a fresh Lamport timestamp and records the insert operation in the op log.
   *
   * @param {{ siteId: string, counter: number } | null} afterId - ID of character to insert after (null for start of doc).
   * @param {string} char - The character to insert.
   * @returns {Node} The newly created and inserted node.
   */
  insert(afterId, char) {
    if (typeof char !== 'string' || char.length === 0) {
      throw new Error('insert expects a non-empty string character');
    }

    const id = this.clock.tick();
    const node = new Node(id, char, afterId);
    this._insertNode(node);

    const op = { type: 'insert', id, char, afterId };
    this.ops.push(op);

    return node;
  }

  /**
   * Marks a character as deleted (tombstone).
   * Never physically removes the node to preserve convergence for concurrent inserts.
   * Idempotent if called multiple times on the same ID.
   *
   * @param {{ siteId: string, counter: number }} id - ID of the character to delete.
   */
  delete(id) {
    if (!id) {
      throw new Error('delete requires a valid node id');
    }

    const key = idKey(id);
    const node = this.nodesById.get(key);
    if (node) {
      node.deleted = true;
    } else {
      this.pendingDeletes.add(key);
    }

    const op = { type: 'delete', id };
    this.ops.push(op);
  }

  /**
   * Returns the visible document text (excluding tombstones).
   * @returns {string}
   */
  toString() {
    let result = '';
    let curr = this.root.next;
    while (curr) {
      if (!curr.deleted && curr.char !== null) {
        result += curr.char;
      }
      curr = curr.next;
    }
    return result;
  }

  /**
   * Applies a remote operation received from another replica.
   * Ensures deterministic merge and idempotency.
   *
   * @param {{ type: string, id: object, char?: string, afterId?: object }} op
   */
  applyRemoteOp(op) {
    if (!op || !op.type) return;

    if (op.type === 'insert') {
      const key = idKey(op.id);

      // Idempotency: skip if already applied
      if (this.nodesById.has(key)) {
        return;
      }

      // Lamport clock update: maintain causal ordering
      if (op.id && typeof op.id.counter === 'number') {
        this.clock.update(op.id.counter);
      }

      // Check causal readiness: parent must exist
      const parentKey = idKey(op.afterId ?? null);
      if (!this.nodesById.has(parentKey)) {
        this.pendingOps.push(op);
        return;
      }

      const node = new Node(op.id, op.char, op.afterId ?? null);

      // Check if a delete for this node arrived earlier
      if (this.pendingDeletes.has(key)) {
        node.deleted = true;
        this.pendingDeletes.delete(key);
      }

      this._insertNode(node);
      this.ops.push(op);

      // Flush any pending operations that were waiting for this node
      this._flushPendingOps();

    } else if (op.type === 'delete') {
      const key = idKey(op.id);
      const node = this.nodesById.get(key);
      if (node) {
        node.deleted = true;
      } else {
        this.pendingDeletes.add(key);
      }
      this.ops.push(op);
    }
  }

  /**
   * Returns a shallow copy of the operation log.
   * @returns {Array<object>}
   */
  getOps() {
    return [...this.ops];
  }

  /**
   * Retrieves a node by its Lamport ID.
   * Returns the root sentinel if id is null.
   *
   * @param {{ siteId: string, counter: number } | null} id
   * @returns {Node | null}
   */
  getNode(id) {
    return this.nodesById.get(idKey(id)) || null;
  }

  /**
   * Returns the Lamport ID of the visible character at the given 0-based index,
   * or null if index is out of bounds.
   *
   * @param {number} visibleIndex
   * @returns {{ siteId: string, counter: number } | null}
   */
  idAt(visibleIndex) {
    if (visibleIndex < 0) return null;
    let count = 0;
    let curr = this.root.next;
    while (curr) {
      if (!curr.deleted && curr.char !== null) {
        if (count === visibleIndex) {
          return curr.id;
        }
        count++;
      }
      curr = curr.next;
    }
    return null;
  }

  /**
   * Returns the visible 0-based character index of a given Lamport ID,
   * or -1 if the node is deleted or not found.
   *
   * @param {{ siteId: string, counter: number } | null} id
   * @returns {number}
   */
  indexOfId(id) {
    if (!id) return -1;
    let index = 0;
    let curr = this.root.next;
    while (curr) {
      if (curr.id && curr.id.siteId === id.siteId && curr.id.counter === id.counter) {
        return curr.deleted ? -1 : index;
      }
      if (!curr.deleted && curr.char !== null) {
        index++;
      }
      curr = curr.next;
    }
    return -1;
  }

  /**
   * Finds the nearest preceding non-deleted node in the sequence starting backwards from `id`.
   * Used for "sticky cursor" positioning when an anchor character is deleted by a remote edit.
   * Returns null if no preceding visible character exists (i.e. start of document).
   *
   * @param {{ siteId: string, counter: number } | null} id
   * @returns {{ siteId: string, counter: number } | null}
   */
  findPrecedingVisibleNode(id) {
    if (!id) return null;
    let node = this.getNode(id);
    if (!node) return null;

    let curr = node.prev;
    while (curr && curr !== this.root) {
      if (!curr.deleted && curr.char !== null) {
        return curr.id;
      }
      curr = curr.prev;
    }
    return null;
  }

  /**
   * Internal method: splices a node into the RGA data structure.
   * Maintains both the linked list and the sorted child tree.
   *
   * Sibling resolution rule:
   * When multiple nodes share the same afterId, they are ordered descending by Lamport ID
   * (higher timestamp wins, appearing further left).
   *
   * @private
   * @param {Node} node
   */
  _insertNode(node) {
    const parent = this.getNode(node.afterId);
    if (!parent) {
      throw new Error(`Cannot insert node: predecessor ${idKey(node.afterId)} not found`);
    }

    // Find insertion index among parent's children (sorted descending by ID)
    let insertIndex = -1;
    for (let i = 0; i < parent.children.length; i++) {
      if (compareIds(node.id, parent.children[i].id) > 0) {
        insertIndex = i;
        break;
      }
    }

    if (insertIndex !== -1) {
      // Sibling with lower ID exists: insert immediately before that sibling's subtree
      const nextSibling = parent.children[insertIndex];
      // In the linked list, nextSibling is the root and first element of its subtree
      this._spliceBefore(node, nextSibling);
      parent.children.splice(insertIndex, 0, node);
    } else {
      // Node has lowest ID among parent's children so far:
      // Must be placed after the entire existing subtree of parent
      const lastDescendant = this._getLastDescendant(parent);
      this._spliceAfter(node, lastDescendant);
      parent.children.push(node);
    }

    this.nodesById.set(idKey(node.id), node);
  }

  /**
   * Splices `newNode` immediately before `targetNode` in the doubly linked list.
   * @private
   */
  _spliceBefore(newNode, targetNode) {
    const prevNode = targetNode.prev;
    newNode.prev = prevNode;
    newNode.next = targetNode;
    if (prevNode) {
      prevNode.next = newNode;
    }
    targetNode.prev = newNode;
  }

  /**
   * Splices `newNode` immediately after `targetNode` in the doubly linked list.
   * @private
   */
  _spliceAfter(newNode, targetNode) {
    const nextNode = targetNode.next;
    newNode.prev = targetNode;
    newNode.next = nextNode;
    if (nextNode) {
      nextNode.prev = newNode;
    }
    targetNode.next = newNode;
  }

  /**
   * Finds the last node in the pre-order traversal of `node`'s subtree.
   * @private
   * @param {Node} node
   * @returns {Node}
   */
  _getLastDescendant(node) {
    let curr = node;
    while (curr.children.length > 0) {
      curr = curr.children[curr.children.length - 1];
    }
    return curr;
  }

  /**
   * Checks if any pending operations can now be applied.
   * @private
   */
  _flushPendingOps() {
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = 0; i < this.pendingOps.length; i++) {
        const op = this.pendingOps[i];
        const parentKey = idKey(op.afterId ?? null);
        if (this.nodesById.has(parentKey)) {
          this.pendingOps.splice(i, 1);
          this.applyRemoteOp(op);
          progress = true;
          break;
        }
      }
    }
  }
}
