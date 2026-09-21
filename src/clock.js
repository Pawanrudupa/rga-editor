/**
 * Lamport logical clock and identifier comparison utilities for RGA CRDT.
 * Zero dependencies.
 */

/**
 * A Lamport logical clock for generating monotonically increasing timestamps
 * with causal ordering guarantees across distributed replicas.
 */
export class LamportClock {
  /**
   * @param {string} siteId - Globally unique replica/site identifier.
   * @param {number} [initialCounter=0] - Initial logical clock value.
   */
  constructor(siteId, initialCounter = 0) {
    if (!siteId) {
      throw new Error('LamportClock requires a non-empty siteId');
    }
    this.siteId = siteId;
    this.counter = initialCounter;
  }

  /**
   * Increments the local clock and returns a new Lamport timestamp ID.
   * @returns {{ siteId: string, counter: number }}
   */
  tick() {
    this.counter += 1;
    return { siteId: this.siteId, counter: this.counter };
  }

  /**
   * Updates the local clock to be greater than any observed remote counter value.
   * @param {number} remoteCounter
   */
  update(remoteCounter) {
    if (typeof remoteCounter === 'number' && Number.isFinite(remoteCounter)) {
      this.counter = Math.max(this.counter, remoteCounter);
    }
  }

  /**
   * Returns the current counter value without incrementing.
   * @returns {number}
   */
  peek() {
    return this.counter;
  }
}

/**
 * Compares two Lamport timestamp IDs establishing a strict total ordering.
 * Comparison precedence:
 * 1. counter (higher counter is greater)
 * 2. siteId tie-breaker (lexicographically greater siteId is greater)
 *
 * `null` is treated as the root sentinel (less than any valid ID).
 *
 * @param {{ siteId: string, counter: number } | null} a
 * @param {{ siteId: string, counter: number } | null} b
 * @returns {number} Negative if a < b, positive if a > b, 0 if equal
 */
export function compareIds(a, b) {
  if (a === b) return 0;
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;

  if (a.counter !== b.counter) {
    return a.counter - b.counter;
  }

  if (a.siteId < b.siteId) return -1;
  if (a.siteId > b.siteId) return 1;
  return 0;
}

/**
 * Generates a unique, stable string key for a Lamport ID to use in Maps and Sets.
 * @param {{ siteId: string, counter: number } | null} id
 * @returns {string}
 */
export function idKey(id) {
  if (!id) return 'ROOT';
  return `${id.siteId}:${id.counter}`;
}

/**
 * Generates a pseudo-random site identifier for convenience.
 * @returns {string}
 */
export function generateSiteId() {
  return 'site-' + Math.random().toString(36).substring(2, 10);
}
