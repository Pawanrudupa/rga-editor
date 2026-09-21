/**
 * Tests for editor binding logic and cursor anchor math.
 * Uses Node's built-in node:test and node:assert/strict. Zero dependencies.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CRDT } from '../src/crdt.js';
import { computeDiff, EditorBinding } from '../src/editor.js';

describe('Editor Diffing and Cursor Math Tests', () => {

  describe('1. computeDiff text diffing algorithm', () => {

    it('detects single character insertion at cursor', () => {
      const oldText = 'Hello world';
      const newText = 'Hello! world';
      // Cursor was at index 5 before typing '!'
      const diff = computeDiff(oldText, newText, 5, 5);

      assert.equal(diff.deleteCount, 0);
      assert.equal(diff.insertedText, '!');
      assert.equal(diff.insertAfterIndex, 4); // After 'o'
    });

    it('disambiguates inserting a repeated character using cursor position', () => {
      const oldText = 'aaa';
      const newText = 'aaaa';
      // User typed 'a' at index 1
      const diff = computeDiff(oldText, newText, 1, 1);

      assert.equal(diff.deleteCount, 0);
      assert.equal(diff.insertedText, 'a');
      assert.equal(diff.insertAfterIndex, 0); // After first 'a'
    });

    it('detects backspace of a single character', () => {
      const oldText = 'Hello';
      const newText = 'Helo';
      // Cursor was at index 3 (after second 'l') before backspacing
      const diff = computeDiff(oldText, newText, 3, 3);

      assert.equal(diff.deleteCount, 1);
      assert.equal(diff.deleteIndex, 2); // Deleted char at index 2
      assert.equal(diff.insertedText, '');
    });

    it('detects forward delete of a single character', () => {
      const oldText = 'Hello';
      const newText = 'Helo';
      // Cursor was at index 2 (before second 'l') and pressed Delete key
      const diff = computeDiff(oldText, newText, 2, 2);

      assert.equal(diff.deleteCount, 1);
      assert.equal(diff.deleteIndex, 2);
      assert.equal(diff.insertedText, '');
    });

    it('detects selection replacement', () => {
      const oldText = 'Hello world';
      const newText = 'Hello there';
      // Selected "world" (indices 6 to 11) and typed "there"
      const diff = computeDiff(oldText, newText, 6, 11);

      assert.equal(diff.deleteCount, 5);
      assert.equal(diff.deleteIndex, 6);
      assert.equal(diff.insertedText, 'there');
      assert.equal(diff.insertAfterIndex, 5); // After space
    });

    it('detects bulk paste at document start', () => {
      const oldText = 'world';
      const newText = 'Hello world';
      const diff = computeDiff(oldText, newText, 0, 0);

      assert.equal(diff.deleteCount, 0);
      assert.equal(diff.insertedText, 'Hello ');
      assert.equal(diff.insertAfterIndex, -1);
    });
  });

  describe('2. Sticky cursor anchor math on remote operations', () => {

    /**
     * Helper creating a mock textarea element for testing EditorBinding in Node.js
     */
    function createMockTextarea(initialValue = '') {
      return {
        value: initialValue,
        selectionStart: 0,
        selectionEnd: 0,
        listeners: {},
        addEventListener(event, fn) {
          if (!this.listeners[event]) this.listeners[event] = [];
          this.listeners[event].push(fn);
        },
        removeEventListener(event, fn) {
          if (this.listeners[event]) {
            this.listeners[event] = this.listeners[event].filter(f => f !== fn);
          }
        },
        setSelectionRange(start, end) {
          this.selectionStart = start;
          this.selectionEnd = end;
        },
      };
    }

    /** Mock sync */
    function createMockSync() {
      return {
        broadcastOp() {},
        onRemoteOp(fn) { this._remoteOpFn = fn; return () => {}; },
        requestSync() {},
        onSyncRequest() { return () => {}; },
        onSyncResponse() { return () => {}; },
        sendSyncResponse() {},
        triggerRemoteOp(op) { if (this._remoteOpFn) this._remoteOpFn(op); },
      };
    }

    it('preserves cursor position when remote op inserts AFTER the cursor', () => {
      const crdt = new CRDT('local-site');
      // Document: "Hello"
      let prev = null;
      for (const ch of 'Hello') {
        const n = crdt.insert(prev, ch);
        prev = n.id;
      }

      const textarea = createMockTextarea('Hello');
      const sync = createMockSync();
      const binding = new EditorBinding(textarea, crdt, sync);

      // Local cursor is at index 2 (between 'e' and 'l')
      textarea.setSelectionRange(2, 2);

      // Remote peer inserts '!' at the end (after 5th char 'o')
      const lastCharId = crdt.idAt(4);
      sync.triggerRemoteOp({
        type: 'insert',
        id: { siteId: 'remote-site', counter: 10 },
        char: '!',
        afterId: lastCharId,
      });

      assert.equal(textarea.value, 'Hello!');
      assert.equal(textarea.selectionStart, 2, 'Cursor should remain at index 2');
      assert.equal(textarea.selectionEnd, 2, 'Cursor should remain at index 2');

      binding.destroy();
    });

    it('shifts cursor forward when remote op inserts BEFORE the cursor', () => {
      const crdt = new CRDT('local-site');
      // Document: "World"
      let prev = null;
      for (const ch of 'World') {
        const n = crdt.insert(prev, ch);
        prev = n.id;
      }

      const textarea = createMockTextarea('World');
      const sync = createMockSync();
      const binding = new EditorBinding(textarea, crdt, sync);

      // Local cursor is at index 3 (between 'r' and 'l')
      textarea.setSelectionRange(3, 3);

      // Remote peer inserts "AB" at the beginning (afterId: null)
      // Insert 'A'
      sync.triggerRemoteOp({
        type: 'insert',
        id: { siteId: 'remote-site', counter: 1 },
        char: 'A',
        afterId: null,
      });
      // Insert 'B'
      sync.triggerRemoteOp({
        type: 'insert',
        id: { siteId: 'remote-site', counter: 2 },
        char: 'B',
        afterId: { siteId: 'remote-site', counter: 1 },
      });

      // Text is now "ABWorld". Original 'r' (index 2) is now at index 4.
      // Cursor should be right after 'r', at index 5!
      assert.equal(textarea.value, 'ABWorld');
      assert.equal(textarea.selectionStart, 5, 'Cursor should shift forward by 2');
      assert.equal(textarea.selectionEnd, 5);

      binding.destroy();
    });

    it('shifts cursor backward when remote op deletes character BEFORE the cursor', () => {
      const crdt = new CRDT('local-site');
      // Document: "ABCDE"
      let prev = null;
      for (const ch of 'ABCDE') {
        const n = crdt.insert(prev, ch);
        prev = n.id;
      }

      const textarea = createMockTextarea('ABCDE');
      const sync = createMockSync();
      const binding = new EditorBinding(textarea, crdt, sync);

      // Cursor is at index 3 (after 'C')
      textarea.setSelectionRange(3, 3);

      // Remote peer deletes 'B' (index 1)
      const bId = crdt.idAt(1);
      sync.triggerRemoteOp({
        type: 'delete',
        id: bId,
      });

      // Text is now "ACDE". 'C' is now at index 1. Cursor after 'C' should be at index 2!
      assert.equal(textarea.value, 'ACDE');
      assert.equal(textarea.selectionStart, 2, 'Cursor should shift backward by 1');
      assert.equal(textarea.selectionEnd, 2);

      binding.destroy();
    });

    it('snaps cursor to nearest visible predecessor when preceding character is deleted remotely', () => {
      const crdt = new CRDT('local-site');
      // Document: "ABCDE"
      let prev = null;
      for (const ch of 'ABCDE') {
        const n = crdt.insert(prev, ch);
        prev = n.id;
      }

      const textarea = createMockTextarea('ABCDE');
      const sync = createMockSync();
      const binding = new EditorBinding(textarea, crdt, sync);

      // Cursor is at index 3 (after 'C'). Anchor is 'C'.
      textarea.setSelectionRange(3, 3);

      // Remote peer deletes 'C' itself!
      const cId = crdt.idAt(2);
      sync.triggerRemoteOp({
        type: 'delete',
        id: cId,
      });

      // Text is now "ABDE". 'C' is gone. Nearest predecessor is 'B' (index 1).
      // Cursor should snap after 'B', at index 2!
      assert.equal(textarea.value, 'ABDE');
      assert.equal(textarea.selectionStart, 2, 'Cursor snaps to after B');
      assert.equal(textarea.selectionEnd, 2);

      binding.destroy();
    });
  });
});
