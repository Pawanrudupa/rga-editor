/**
 * Tests for LocalSync (BroadcastChannel transport).
 * Uses Node's built-in node:test and node:assert/strict. Zero dependencies.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LocalSync } from '../src/sync-local.js';

describe('LocalSync BroadcastChannel Transport Tests', () => {

  it('broadcasts and receives operations between peer replicas on the same channel', async () => {
    const channelName = 'test-sync-channel-1';
    const peerA = new LocalSync('site-A', channelName);
    const peerB = new LocalSync('site-B', channelName);

    const receivedByB = [];
    peerB.onRemoteOp((op) => {
      receivedByB.push(op);
    });

    const testOp = {
      type: 'insert',
      id: { siteId: 'site-A', counter: 1 },
      char: 'H',
      afterId: null,
    };

    peerA.broadcastOp(testOp);

    // Wait briefly for BroadcastChannel event loop dispatch
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(receivedByB.length, 1);
    assert.deepEqual(receivedByB[0], testOp);

    peerA.destroy();
    peerB.destroy();
  });

  it('handles sync-request and sync-response for new tab catch-up', async () => {
    const channelName = 'test-sync-channel-2';
    const existingPeer = new LocalSync('existing-site', channelName);

    const existingOps = [
      { type: 'insert', id: { siteId: 'existing-site', counter: 1 }, char: 'A', afterId: null },
      { type: 'insert', id: { siteId: 'existing-site', counter: 2 }, char: 'B', afterId: null },
    ];

    // Existing peer listens for sync requests and responds
    existingPeer.onSyncRequest((requesterSiteId) => {
      existingPeer.sendSyncResponse(existingOps, requesterSiteId);
    });

    // New peer joins and requests sync
    const newPeer = new LocalSync('new-site', channelName);
    let receivedBatch = null;

    newPeer.onSyncResponse((ops) => {
      receivedBatch = ops;
    });

    newPeer.requestSync();

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(receivedBatch, 'New peer should have received the op batch');
    assert.equal(receivedBatch.length, 2);
    assert.deepEqual(receivedBatch, existingOps);

    existingPeer.destroy();
    newPeer.destroy();
  });

  it('cleans up channel and event handlers on destroy()', async () => {
    const channelName = 'test-sync-channel-3';
    const peerA = new LocalSync('site-A', channelName);
    const peerB = new LocalSync('site-B', channelName);

    let callCount = 0;
    peerB.onRemoteOp(() => {
      callCount++;
    });

    peerB.destroy();

    peerA.broadcastOp({ type: 'insert', id: { siteId: 'site-A', counter: 1 }, char: 'X' });

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(callCount, 0, 'Destroyed peer should not receive ops');

    peerA.destroy();
  });
});
