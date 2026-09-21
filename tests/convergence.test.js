/**
 * Convergence and correctness tests for RGA CRDT.
 * Uses Node's built-in node:test and node:assert/strict. Zero dependencies.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CRDT } from '../src/crdt.js';
import { compareIds } from '../src/clock.js';

describe('RGA CRDT Convergence Tests', () => {

  // =========================================================================
  // Requirement 1: Two replicas apply the same ops in different orders
  // =========================================================================
  describe('1. Out-of-order operation application convergence', () => {

    it('converges when replicas apply independent edit operations in different orders', () => {
      const siteA = new CRDT('site-A');
      const siteB = new CRDT('site-B');

      // Site A inserts "ABC"
      const nA1 = siteA.insert(null, 'A');
      const nA2 = siteA.insert(nA1.id, 'B');
      siteA.insert(nA2.id, 'C');

      // Site B inserts "XYZ"
      const nB1 = siteB.insert(null, 'X');
      const nB2 = siteB.insert(nB1.id, 'Y');
      siteB.insert(nB2.id, 'Z');

      const opsA = siteA.getOps();
      const opsB = siteB.getOps();

      // Replica 1 applies opsA then opsB
      const r1 = new CRDT('replica-1');
      for (const op of opsA) r1.applyRemoteOp(op);
      for (const op of opsB) r1.applyRemoteOp(op);

      // Replica 2 applies opsB then opsA
      const r2 = new CRDT('replica-2');
      for (const op of opsB) r2.applyRemoteOp(op);
      for (const op of opsA) r2.applyRemoteOp(op);

      // Replica 3 applies interleaved ops
      const r3 = new CRDT('replica-3');
      const interleaved = [opsA[0], opsB[0], opsA[1], opsB[1], opsA[2], opsB[2]];
      for (const op of interleaved) r3.applyRemoteOp(op);

      assert.equal(r1.toString(), r2.toString(), 'r1 and r2 must produce identical visible text');
      assert.equal(r1.toString(), r3.toString(), 'r1 and r3 must produce identical visible text');
    });

    it('converges across multiple random permutations of valid causal operations', () => {
      const doc = new CRDT('author');
      let prevId = null;
      for (const ch of 'CONVERGENCE') {
        const node = doc.insert(prevId, ch);
        prevId = node.id;
      }

      // Delete two characters
      const secondCharId = doc.idAt(1); // 'O'
      const fifthCharId = doc.idAt(4);  // 'E'
      doc.delete(secondCharId);
      doc.delete(fifthCharId);

      const allOps = doc.getOps();

      // Generate 5 distinct permutations of the ops while preserving intra-character causality
      // (parent insert arrives before child insert)
      const results = [];
      for (let run = 0; run < 10; run++) {
        const replica = new CRDT(`test-replica-${run}`);
        // Simple deterministic shuffle of ops that may arrive out of order
        // Note: Our RGA implementation buffers out-of-order ops automatically!
        const shuffled = [...allOps].sort(() => ((run * 7 + 13) % 5) - 2);
        for (const op of shuffled) {
          replica.applyRemoteOp(op);
        }
        results.push(replica.toString());
      }

      const expected = doc.toString();
      for (const res of results) {
        assert.equal(res, expected, 'Every permuted replica must converge to expected text');
      }
    });
  });

  // =========================================================================
  // Requirement 2: Concurrent insert-at-same-position from two sites
  // =========================================================================
  describe('2. Concurrent insert-at-same-position deterministic tie-breaking', () => {

    it('resolves concurrent inserts at document start (afterId: null) deterministically', () => {
      // Both replicas start empty
      const site1 = new CRDT('site-1');
      const site2 = new CRDT('site-2');

      // Concurrently insert at null
      const n1 = site1.insert(null, 'A');
      const n2 = site2.insert(null, 'B');

      // Determine expected winner by comparing IDs
      const cmp = compareIds(n1.id, n2.id);
      assert.notEqual(cmp, 0, 'IDs from different sites must never be equal');
      // Higher ID is placed to the left (wins tie)
      const expected = cmp > 0 ? 'AB' : 'BA';

      // Cross-apply operations
      site1.applyRemoteOp(site2.getOps()[0]);
      site2.applyRemoteOp(site1.getOps()[0]);

      assert.equal(site1.toString(), expected, 'site1 must match deterministic tie-breaker');
      assert.equal(site2.toString(), expected, 'site2 must match deterministic tie-breaker');
      assert.equal(site1.toString(), site2.toString(), 'site1 and site2 must converge');
    });

    it('resolves concurrent inserts at the same middle position deterministically', () => {
      // Initial shared base document: "XZ"
      const base = new CRDT('init');
      const xNode = base.insert(null, 'X');
      base.insert(xNode.id, 'Z');
      const initialOps = base.getOps();

      const siteAlpha = new CRDT('alpha');
      const siteBeta = new CRDT('beta');

      for (const op of initialOps) {
        siteAlpha.applyRemoteOp(op);
        siteBeta.applyRemoteOp(op);
      }

      assert.equal(siteAlpha.toString(), 'XZ');
      assert.equal(siteBeta.toString(), 'XZ');

      // Both sites concurrently insert immediately after 'X'
      const nodeA = siteAlpha.insert(xNode.id, '1'); // Alpha inserts '1' after 'X'
      const nodeB = siteBeta.insert(xNode.id, '2');  // Beta inserts '2' after 'X'

      // Exchange the concurrent ops
      siteAlpha.applyRemoteOp(siteBeta.getOps()[initialOps.length]);
      siteBeta.applyRemoteOp(siteAlpha.getOps()[initialOps.length]);

      const higherIsAlpha = compareIds(nodeA.id, nodeB.id) > 0;
      const expectedMiddle = higherIsAlpha ? '12' : '21';
      const expectedText = `X${expectedMiddle}Z`;

      assert.equal(siteAlpha.toString(), expectedText, 'siteAlpha converges correctly');
      assert.equal(siteBeta.toString(), expectedText, 'siteBeta converges correctly');
      assert.equal(siteAlpha.toString(), siteBeta.toString(), 'Alpha and Beta have identical text');
    });

    it('resolves 3 concurrent inserts after the same predecessor with full ID comparison', () => {
      // Create 3 sites
      const sites = ['site-A', 'site-B', 'site-C'].map(id => new CRDT(id));

      // Each inserts a character after null
      const nodes = [
        sites[0].insert(null, 'A'),
        sites[1].insert(null, 'B'),
        sites[2].insert(null, 'C'),
      ];

      // Cross apply all ops to all sites
      const allOps = sites.flatMap(s => s.getOps());
      for (const site of sites) {
        for (const op of allOps) {
          site.applyRemoteOp(op);
        }
      }

      // Expected order is sorted descending by ID
      const sortedNodes = [...nodes].sort((a, b) => compareIds(b.id, a.id));
      const expectedText = sortedNodes.map(n => n.char).join('');

      assert.equal(sites[0].toString(), expectedText);
      assert.equal(sites[1].toString(), expectedText);
      assert.equal(sites[2].toString(), expectedText);
    });
  });

  // =========================================================================
  // Requirement 3: Concurrent delete + insert-after-deleted-char
  // =========================================================================
  describe('3. Concurrent delete and insert-after-deleted-char (tombstone preservation)', () => {

    it('preserves an insert occurring concurrently after a deleted character', () => {
      // Shared starting state: "cat"
      const init = new CRDT('setup');
      const c = init.insert(null, 'c');
      const a = init.insert(c.id, 'a');
      init.insert(a.id, 't');

      const site1 = new CRDT('replica-1');
      const site2 = new CRDT('replica-2');

      for (const op of init.getOps()) {
        site1.applyRemoteOp(op);
        site2.applyRemoteOp(op);
      }

      assert.equal(site1.toString(), 'cat');
      assert.equal(site2.toString(), 'cat');

      // Site 1 deletes 'a' -> should be "ct" locally
      site1.delete(a.id);
      assert.equal(site1.toString(), 'ct', 'Site 1 sees "ct" after deleting "a"');

      // Site 2 concurrently inserts 'r' after 'a' -> should be "cart" locally
      site2.insert(a.id, 'r');
      assert.equal(site2.toString(), 'cart', 'Site 2 sees "cart" after inserting "r" after "a"');

      // Exchange concurrent ops:
      // Site 1 receives insert 'r' after 'a'
      const insertROp = site2.getOps().find(op => op.char === 'r');
      site1.applyRemoteOp(insertROp);

      // Site 2 receives delete 'a'
      const deleteAOp = site1.getOps().find(op => op.type === 'delete' && op.id === a.id);
      site2.applyRemoteOp(deleteAOp);

      // Both replicas must converge to "crt":
      // 'a' is tombstoned (hidden), 'r' was inserted after 'a', so 'r' remains between 'c' and 't'
      assert.equal(site1.toString(), 'crt', 'Site 1 converges to "crt"');
      assert.equal(site2.toString(), 'crt', 'Site 2 converges to "crt"');
      assert.equal(site1.toString(), site2.toString(), 'Both replicas match');

      // Verify tombstone integrity: node 'a' is physically present but deleted = true
      const aNodeSite1 = site1.getNode(a.id);
      const aNodeSite2 = site2.getNode(a.id);
      assert.ok(aNodeSite1, 'Node a must still exist in memory on site1');
      assert.ok(aNodeSite2, 'Node a must still exist in memory on site2');
      assert.equal(aNodeSite1.deleted, true, 'Node a is marked deleted on site1');
      assert.equal(aNodeSite2.deleted, true, 'Node a is marked deleted on site2');
    });
  });

  // =========================================================================
  // Requirement 4: Duplicate delete of the same id is idempotent
  // =========================================================================
  describe('4. Delete idempotence', () => {

    it('handles duplicate local and remote deletes idempotently without error', () => {
      const doc = new CRDT('site-test');
      const node = doc.insert(null, 'X');
      assert.equal(doc.toString(), 'X');

      // First delete
      doc.delete(node.id);
      assert.equal(doc.toString(), '');

      // Duplicate local delete
      assert.doesNotThrow(() => {
        doc.delete(node.id);
      }, 'Duplicate local delete must not throw');
      assert.equal(doc.toString(), '');

      // Duplicate remote delete applied multiple times
      const deleteOp = { type: 'delete', id: node.id };
      assert.doesNotThrow(() => {
        doc.applyRemoteOp(deleteOp);
        doc.applyRemoteOp(deleteOp);
      }, 'Duplicate remote delete must not throw');

      assert.equal(doc.toString(), '');
      assert.equal(doc.getNode(node.id).deleted, true);
    });
  });

  // =========================================================================
  // Extra: Out-of-order delivery and causal dependency resolution
  // =========================================================================
  describe('5. Out-of-order delivery tolerance (causal buffering)', () => {

    it('buffers a child insert if received before its parent, then resolves cleanly', () => {
      const parentOp = {
        type: 'insert',
        id: { siteId: 'source', counter: 1 },
        char: 'P',
        afterId: null,
      };

      const childOp = {
        type: 'insert',
        id: { siteId: 'source', counter: 2 },
        char: 'C',
        afterId: { siteId: 'source', counter: 1 },
      };

      const replica = new CRDT('receiver');

      // Child arrives before parent!
      replica.applyRemoteOp(childOp);
      assert.equal(replica.toString(), '', 'Child should not be visible before parent arrives');

      // Parent arrives now
      replica.applyRemoteOp(parentOp);
      assert.equal(replica.toString(), 'PC', 'Both parent and buffered child must now be visible in order');
    });

    it('buffers a delete operation that arrives before the insert operation', () => {
      const insertOp = {
        type: 'insert',
        id: { siteId: 'source', counter: 1 },
        char: 'Z',
        afterId: null,
      };

      const deleteOp = {
        type: 'delete',
        id: { siteId: 'source', counter: 1 },
      };

      const replica = new CRDT('receiver');

      // Delete arrives first!
      replica.applyRemoteOp(deleteOp);
      assert.equal(replica.toString(), '');

      // Insert arrives second -> node should immediately be tombstoned
      replica.applyRemoteOp(insertOp);
      assert.equal(replica.toString(), '', 'Node should be immediately tombstoned upon insert');
      assert.equal(replica.getNode(insertOp.id).deleted, true);
    });
  });
});
