/**
 * Tests for OfflineStore persistence and replay queue.
 * Uses Node's built-in node:test and node:assert/strict. Zero dependencies.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { OfflineStore } from '../src/persistence.js';
import { CRDT } from '../src/crdt.js';

describe('OfflineStore Persistence and Replay Tests', () => {
  let store;

  beforeEach(() => {
    store = new OfflineStore('test-crdt-db');
  });

  it('queues offline operations and retrieves them in order', async () => {
    const op1 = { type: 'insert', id: { siteId: 'site-A', counter: 1 }, char: 'X', afterId: null };
    const op2 = { type: 'insert', id: { siteId: 'site-A', counter: 2 }, char: 'Y', afterId: op1.id };

    await store.queueOp(op1);
    await store.queueOp(op2);

    const queued = await store.getQueuedOps();
    assert.equal(queued.length, 2);
    assert.deepEqual(queued[0], op1);
    assert.deepEqual(queued[1], op2);
  });

  it('deduplicates queue entries with the same op ID', async () => {
    const op = { type: 'insert', id: { siteId: 'site-A', counter: 1 }, char: 'A', afterId: null };

    await store.queueOp(op);
    await store.queueOp(op); // Duplicate queue attempt

    const queued = await store.getQueuedOps();
    assert.equal(queued.length, 1);
  });

  it('removes individual operations and clears queue', async () => {
    const op1 = { type: 'insert', id: { siteId: 'site-A', counter: 1 }, char: '1', afterId: null };
    const op2 = { type: 'insert', id: { siteId: 'site-A', counter: 2 }, char: '2', afterId: op1.id };

    await store.queueOp(op1);
    await store.queueOp(op2);

    await store.removeQueuedOp(op1.id);
    let queued = await store.getQueuedOps();
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0], op2);

    await store.clearQueue();
    queued = await store.getQueuedOps();
    assert.equal(queued.length, 0);
  });

  it('replays queue with deduplication against CRDT and broadcasts ops', async () => {
    const crdt = new CRDT('site-A');

    // Pre-apply op1 directly to CRDT (simulating op that was already inserted locally)
    const op1 = { type: 'insert', id: { siteId: 'site-A', counter: 1 }, char: 'A', afterId: null };
    crdt.applyRemoteOp(op1);

    // Both op1 and op2 are in the offline queue (e.g. op1 was queued before network dropped)
    const op2 = { type: 'insert', id: { siteId: 'site-A', counter: 2 }, char: 'B', afterId: op1.id };
    await store.queueOp(op1);
    await store.queueOp(op2);

    const broadcasted = [];
    const broadcastFn = (op) => broadcasted.push(op);

    // Replay queue
    const count = await store.replayQueue(crdt, [broadcastFn]);

    // Both ops were broadcasted to network
    assert.equal(count, 2);
    assert.equal(broadcasted.length, 2);

    // CRDT converged cleanly to "AB" without double-applying op1
    assert.equal(crdt.toString(), 'AB');

    // Queue is cleared after replay
    const remaining = await store.getQueuedOps();
    assert.equal(remaining.length, 0);
  });

  it('queues exactly 1 op per character for a 20-char offline edit and merges cleanly without duplication', async () => {
    const { EditorBinding } = await import('../src/editor.js');

    const crdtA = new CRDT('site-A');
    const crdtB = new CRDT('site-B'); // Peer replica

    const mockTextarea = {
      value: '',
      selectionStart: 0,
      selectionEnd: 0,
      listeners: {},
      addEventListener(e, fn) { this.listeners[e] = fn; },
      removeEventListener(e, fn) { delete this.listeners[e]; },
      setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; }
    };

    const bindingA = new EditorBinding(mockTextarea, crdtA, [], { offlineStore: store });
    await bindingA.setOffline(true);

    const testString = '[offline edit 12345]'; // Exactly 20 characters
    assert.equal(testString.length, 20);

    // Simulate typing 20 characters one by one
    for (let i = 0; i < testString.length; i++) {
      mockTextarea.value += testString[i];
      mockTextarea.selectionStart = mockTextarea.value.length;
      mockTextarea.selectionEnd = mockTextarea.value.length;
      mockTextarea.listeners['input']();
    }

    // Wait for async queue operations to complete
    await new Promise(r => setTimeout(r, 50));

    // Assert BEFORE count: exactly 20 ops in queue, not 60!
    const queuedBefore = await store.getQueuedOps();
    assert.equal(queuedBefore.length, 20, `Queue must have exactly 20 ops for 20 characters, found ${queuedBefore.length}`);
    assert.equal(crdtA.toString(), testString);

    // Peer starts empty
    assert.equal(crdtB.toString(), '');

    // Replay queue onto peer B
    const broadcastedOps = [];
    const count = await store.replayQueue(crdtA, [
      (op) => {
        broadcastedOps.push(op);
        crdtB.applyRemoteOp(op);
      }
    ]);

    // Assert replayed count
    assert.equal(count, 20);
    assert.equal(broadcastedOps.length, 20);

    // Assert AFTER count: queue is drained to 0
    const queuedAfter = await store.getQueuedOps();
    assert.equal(queuedAfter.length, 0);

    // Assert peer document has exact 20-character string with NO duplication or tripling
    assert.equal(crdtB.toString(), testString);
    assert.equal(crdtB.toString().length, 20);
    assert.equal(crdtA.toString(), crdtB.toString());

    bindingA.destroy();
  });
});
