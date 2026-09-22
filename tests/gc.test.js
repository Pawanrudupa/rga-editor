/**
 * Tests for tombstone garbage collection (CRDT.gcTombstones).
 * Uses Node's built-in node:test and node:assert/strict.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CRDT } from '../src/crdt.js';

describe('Tombstone Garbage Collection Tests', () => {

  /**
   * Helper: insert "hello" into a CRDT, returning nodes for reference.
   */
  function buildHello(crdt) {
    const nodes = [];
    let afterId = null;
    for (const ch of 'hello') {
      const node = crdt.insert(afterId, ch);
      nodes.push(node);
      afterId = node.id;
    }
    return nodes;
  }

  it('collects a leaf tombstone when all sites have advanced past it', () => {
    const crdt = new CRDT('site-A');
    const nodes = buildHello(crdt);

    // Delete 'o' (last node, index 4) — it's a leaf (no children inserted after it)
    crdt.delete(nodes[4].id);

    assert.equal(crdt.toString(), 'hell');

    // All sites advanced past counter 5 (the 'o' node's counter)
    const result = crdt.gcTombstones({ 'site-A': crdt.clock.peek() });

    assert.equal(result.collected, 1, 'should collect the deleted "o" leaf node');
    assert.equal(result.remaining, 0, 'no remaining tombstones');
    assert.equal(crdt.toString(), 'hell', 'visible text unchanged after GC');

    // Node should be removed from nodesById
    assert.equal(crdt.getNode(nodes[4].id), null, 'collected node no longer in nodesById');
  });

  it('does NOT collect a tombstone that has children', () => {
    const crdt = new CRDT('site-A');
    const nodes = buildHello(crdt);

    // Insert a character after 'e' (nodes[1]), then delete 'e'
    // This makes 'e' a parent with a child — not a leaf
    const childNode = crdt.insert(nodes[1].id, 'X');
    crdt.delete(nodes[1].id);

    assert.equal(crdt.toString(), 'hXllo');

    const result = crdt.gcTombstones({ 'site-A': crdt.clock.peek() });

    assert.equal(result.collected, 0, 'should NOT collect tombstone with children');
    assert.equal(result.remaining, 1, 'one non-leaf tombstone remains');
    assert.equal(crdt.toString(), 'hXllo', 'text unchanged');
  });

  it('does NOT collect a tombstone when a site counter is below its timestamp', () => {
    const crdt = new CRDT('site-A');
    const nodes = buildHello(crdt);

    // Delete 'o' (last node, counter=5)
    crdt.delete(nodes[4].id);

    assert.equal(crdt.toString(), 'hell');

    // site-B has only seen up to counter 3 — hasn't seen the 'o' insert yet
    const result = crdt.gcTombstones({
      'site-A': crdt.clock.peek(),
      'site-B': 3,
    });

    assert.equal(result.collected, 0, 'should NOT collect: site-B counter too low');
    assert.equal(result.remaining, 1, 'one tombstone remains');
  });

  it('correctly unlinks nodes — toString output and linked list remain intact', () => {
    const crdt = new CRDT('site-A');
    const nodes = buildHello(crdt);

    // Insert two trailing characters (both are leaves since nothing is inserted after them)
    const x = crdt.insert(nodes[4].id, 'X');
    const y = crdt.insert(x.id, 'Y');

    assert.equal(crdt.toString(), 'helloXY');

    // Delete both trailing characters — they are leaf tombstones
    crdt.delete(x.id); // x still has child y, so x is NOT a leaf yet
    crdt.delete(y.id); // y is a leaf

    assert.equal(crdt.toString(), 'hello');

    const counter = crdt.clock.peek();

    // First GC pass: only 'Y' is a leaf tombstone
    const result1 = crdt.gcTombstones({ 'site-A': counter });
    assert.equal(result1.collected, 1, 'first pass collects Y (the leaf)');
    assert.equal(crdt.toString(), 'hello', 'text unchanged');

    // Second GC pass: now 'X' has become a leaf (Y was removed)
    const result2 = crdt.gcTombstones({ 'site-A': counter });
    assert.equal(result2.collected, 1, 'second pass collects X (now a leaf)');
    assert.equal(crdt.toString(), 'hello', 'text unchanged');

    // Verify linked list integrity by traversing forward
    let text = '';
    let curr = crdt.root.next;
    while (curr) {
      if (!curr.deleted && curr.char) text += curr.char;
      curr = curr.next;
    }
    assert.equal(text, 'hello', 'forward traversal intact');

    // Verify backward traversal
    let backText = '';
    curr = crdt.root.next;
    while (curr && curr.next) curr = curr.next; // go to end
    while (curr && curr !== crdt.root) {
      if (!curr.deleted && curr.char) backText = curr.char + backText;
      curr = curr.prev;
    }
    assert.equal(backText, 'hello', 'backward traversal intact');
  });

  it('returns accurate collected/remaining counts', () => {
    const crdt = new CRDT('site-A');
    const nodes = buildHello(crdt);

    // Delete h, e, l (3 tombstones: 2 are leaves, 'h' has 'e' as child via afterId)
    // Actually in the RGA tree structure, 'e' was inserted afterId='h', so 'h' is parent of 'e'
    // Delete 'e' first: 'e' is parent of first 'l', so 'e' has a child → NOT a leaf
    // Delete first 'l': first 'l' is parent of second 'l' → NOT a leaf
    // Delete second 'l': second 'l' is parent of 'o' → NOT a leaf
    // So only the very last node can be a childless tombstone.
    // Let's delete 'o' (the last one, which has no children)
    crdt.delete(nodes[4].id); // 'o' - leaf tombstone

    // Also insert+delete a trailing character to create another leaf tombstone
    const extra = crdt.insert(nodes[3].id, 'Z');
    crdt.delete(extra.id); // 'Z' - leaf tombstone

    const counter = crdt.clock.peek();
    const result = crdt.gcTombstones({ 'site-A': counter });

    assert.equal(result.collected, 2, 'two leaf tombstones collected');
    assert.equal(result.remaining, 0, 'no remaining tombstones');
    assert.equal(crdt.toString(), 'hell');
  });

  it('is idempotent — running twice produces the same result', () => {
    const crdt = new CRDT('site-A');
    const nodes = buildHello(crdt);

    crdt.delete(nodes[4].id); // delete 'o'

    const counter = crdt.clock.peek();
    const first = crdt.gcTombstones({ 'site-A': counter });
    assert.equal(first.collected, 1);

    const second = crdt.gcTombstones({ 'site-A': counter });
    assert.equal(second.collected, 0, 'nothing to collect on second run');
    assert.equal(second.remaining, 0);

    assert.equal(crdt.toString(), 'hell');
  });
});
