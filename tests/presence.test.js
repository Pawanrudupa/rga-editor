/**
 * Tests for the presence cursor system (src/presence.js).
 * Tests the non-DOM utility functions: color hashing, throttle behavior.
 * Uses Node's built-in node:test and node:assert/strict.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getColorForSite, throttle } from '../src/presence.js';

describe('Presence Utility Tests', () => {

  describe('1. Color assignment (getColorForSite)', () => {

    it('returns a valid CSS color string for any siteId', () => {
      const color = getColorForSite('site-abc123');
      assert.ok(color.startsWith('#'), `Expected hex color, got: ${color}`);
      assert.equal(color.length, 7, 'Expected 7-char hex color (#RRGGBB)');
    });

    it('returns the same color for the same siteId (deterministic)', () => {
      const c1 = getColorForSite('site-xyz');
      const c2 = getColorForSite('site-xyz');
      assert.equal(c1, c2);
    });

    it('returns different colors for different siteIds (with high probability)', () => {
      // Generate several site IDs and check we get at least 2 distinct colors
      const colors = new Set();
      for (let i = 0; i < 20; i++) {
        colors.add(getColorForSite(`site-${i}`));
      }
      assert.ok(colors.size >= 2, `Expected at least 2 distinct colors, got ${colors.size}`);
    });

    it('handles empty string without crashing', () => {
      const color = getColorForSite('');
      assert.ok(color.startsWith('#'));
    });
  });

  describe('2. Throttle function', () => {

    it('executes immediately on first call', () => {
      let callCount = 0;
      const fn = throttle(() => callCount++, 1000);
      fn();
      assert.equal(callCount, 1, 'Should fire immediately on first call');
      fn.cancel();
    });

    it('collapses rapid calls within the throttle interval', async () => {
      let callCount = 0;
      const fn = throttle(() => callCount++, 50);

      fn(); // immediate
      fn(); // collapsed (schedules trailing)
      fn(); // collapsed (same trailing timer)
      fn(); // collapsed

      assert.equal(callCount, 1, 'Only the leading call fires immediately');

      // Wait for the trailing call to fire
      await new Promise(r => setTimeout(r, 80));

      assert.equal(callCount, 2, 'Trailing call fires after interval');
      fn.cancel();
    });

    it('allows calls after the interval has elapsed', async () => {
      let callCount = 0;
      const fn = throttle(() => callCount++, 30);

      fn(); // immediate
      assert.equal(callCount, 1);

      await new Promise(r => setTimeout(r, 50));

      fn(); // should fire immediately (interval elapsed)
      assert.equal(callCount, 2);
      fn.cancel();
    });

    it('cancel() prevents pending trailing call', async () => {
      let callCount = 0;
      const fn = throttle(() => callCount++, 50);

      fn(); // immediate
      fn(); // schedules trailing

      fn.cancel(); // cancel the trailing call

      await new Promise(r => setTimeout(r, 80));

      assert.equal(callCount, 1, 'Cancelled trailing call should not fire');
    });
  });
});
