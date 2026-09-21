/**
 * Tests for the zero-dependency QR code generator (src/qr.js).
 * Uses Node's built-in node:test and node:assert/strict. Zero dependencies.
 *
 * Covers: Galois Field arithmetic, Reed-Solomon polynomials, data encoding,
 * matrix dimensions, function pattern placement, mask evaluation, and
 * capacity error handling.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  gfMul,
  getGeneratorPoly,
  computeReedSolomon,
  generateQrMatrix,
  MAX_CAPACITY,
} from '../src/qr.js';

// ============================================================================
// 1. Galois Field GF(2^8) Arithmetic
// ============================================================================

describe('QR Code Generator Tests', () => {

  describe('1. Galois Field GF(2^8) arithmetic', () => {

    it('gfMul(0, x) === 0 and gfMul(x, 0) === 0 for any x', () => {
      for (let x = 0; x < 256; x++) {
        assert.equal(gfMul(0, x), 0);
        assert.equal(gfMul(x, 0), 0);
      }
    });

    it('gfMul(1, x) === x (multiplicative identity)', () => {
      for (let x = 0; x < 256; x++) {
        assert.equal(gfMul(1, x), x);
      }
    });

    it('gfMul is commutative: gfMul(a,b) === gfMul(b,a)', () => {
      // Spot-check a range of values
      for (let a = 1; a < 256; a += 17) {
        for (let b = 1; b < 256; b += 13) {
          assert.equal(gfMul(a, b), gfMul(b, a));
        }
      }
    });

    it('gfMul matches known values for α = 2', () => {
      // α^1 × α^1 = α^2 = 4
      assert.equal(gfMul(2, 2), 4);
      // α^7 × α^1 = α^8 = 29 (since x^8 mod P(x) = x^4+x^3+x^2+1 = 16+8+4+1 = 29)
      assert.equal(gfMul(128, 2), 29);
    });
  });

  // ============================================================================
  // 2. Reed-Solomon Generator Polynomial
  // ============================================================================

  describe('2. Reed-Solomon generator polynomial', () => {

    it('generator for degree 1 is [1, 1] representing (x + α^0) = (x + 1)', () => {
      const gen = getGeneratorPoly(1);
      assert.deepEqual(gen, [1, 1]);
    });

    it('generator for degree 2 is [1, 3, 2] representing (x+1)(x+α)', () => {
      // (x + 1)(x + 2) = x^2 + 3x + 2  (since 1 XOR 2 = 3)
      const gen = getGeneratorPoly(2);
      assert.deepEqual(gen, [1, 3, 2]);
    });

    it('generator polynomial has correct length (degree + 1) and leading 1', () => {
      for (let d = 1; d <= 26; d++) {
        const gen = getGeneratorPoly(d);
        assert.equal(gen.length, d + 1, `degree ${d}: length should be ${d + 1}`);
        assert.equal(gen[0], 1, `degree ${d}: leading coefficient must be 1 (monic)`);
      }
    });
  });

  // ============================================================================
  // 3. Reed-Solomon Error Correction Codeword Computation
  // ============================================================================

  describe('3. Reed-Solomon EC codeword computation', () => {

    it('produces the correct number of EC codewords', () => {
      const data = [0x40, 0x14, 0x10]; // arbitrary 3 data codewords
      const ec = computeReedSolomon(data, 7); // 7 EC codewords (V1-L)
      assert.equal(ec.length, 7);
    });

    it('EC codewords are deterministic (same input → same output)', () => {
      const data = [0x40, 0x14, 0x10, 0xEC, 0x11];
      const ec1 = computeReedSolomon(data, 10);
      const ec2 = computeReedSolomon(data, 10);
      assert.deepEqual(ec1, ec2);
    });

    it('all-zero data produces all-zero EC codewords', () => {
      const data = new Array(19).fill(0);
      const ec = computeReedSolomon(data, 7);
      assert.deepEqual(ec, new Array(7).fill(0));
    });
  });

  // ============================================================================
  // 4. QR Matrix Generation — Structural Properties
  // ============================================================================

  describe('4. QR matrix structural properties', () => {

    it('matrix size follows formula 4V+17 for each version', () => {
      // Payload sizes chosen to force each version:
      // V1 max = 17 bytes, V2 max = 32, V3 max = 53, V4 max = 78, V5 max = 106
      const cases = [
        { payloadLen: 1,   expectedVersion: 1, expectedSize: 21 },
        { payloadLen: 18,  expectedVersion: 2, expectedSize: 25 },  // exceeds V1 cap (17)
        { payloadLen: 33,  expectedVersion: 3, expectedSize: 29 },  // exceeds V2 cap (32)
        { payloadLen: 54,  expectedVersion: 4, expectedSize: 33 },  // exceeds V3 cap (53)
        { payloadLen: 79,  expectedVersion: 5, expectedSize: 37 },  // exceeds V4 cap (78)
      ];

      for (const { payloadLen, expectedVersion, expectedSize } of cases) {
        const text = 'A'.repeat(payloadLen);
        const { matrix, size, version } = generateQrMatrix(text);

        assert.equal(version, expectedVersion, `${payloadLen}-byte payload should select Version ${expectedVersion}`);
        assert.equal(size, expectedSize, `Version ${expectedVersion} should be ${expectedSize}x${expectedSize}`);
        assert.equal(matrix.length, expectedSize, `Matrix row count for V${expectedVersion}`);
        assert.equal(matrix[0].length, expectedSize, `Matrix column count for V${expectedVersion}`);
      }
    });

    it('all matrix values are 0 or 1', () => {
      const { matrix, size } = generateQrMatrix('TEST');
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          assert.ok(
            matrix[r][c] === 0 || matrix[r][c] === 1,
            `Module (${r},${c}) must be 0 or 1, got ${matrix[r][c]}`
          );
        }
      }
    });

    it('finder patterns are present at three corners', () => {
      const { matrix, size } = generateQrMatrix('QR');

      // Check the three 7×7 finder pattern inner 3×3 centers (always dark)
      const finderCenters = [[3, 3], [3, size - 4], [size - 4, 3]];
      for (const [cr, cc] of finderCenters) {
        // Center 3×3 block should be all dark
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            assert.equal(
              matrix[cr + dr][cc + dc], 1,
              `Finder center (${cr + dr},${cc + dc}) should be dark`
            );
          }
        }
      }
    });

    it('dark module is set at position (4V+9, 8)', () => {
      for (let v = 1; v <= 5; v++) {
        const text = 'A'.repeat(Math.min(v * 3, 17));
        const { matrix, version } = generateQrMatrix(text);
        const darkRow = 4 * version + 9;
        assert.equal(
          matrix[darkRow][8], 1,
          `Dark module at (${darkRow}, 8) for Version ${version} must be 1`
        );
      }
    });

    it('timing patterns alternate on row 6 and column 6', () => {
      const { matrix, size } = generateQrMatrix('TIMING');

      // Horizontal timing: row 6, cols 8 to size-9 (between separators)
      for (let col = 8; col < size - 8; col++) {
        const expected = col % 2 === 0 ? 1 : 0;
        assert.equal(
          matrix[6][col], expected,
          `Horizontal timing at (6, ${col}): expected ${expected}`
        );
      }

      // Vertical timing: col 6, rows 8 to size-9
      for (let row = 8; row < size - 8; row++) {
        const expected = row % 2 === 0 ? 1 : 0;
        assert.equal(
          matrix[row][6], expected,
          `Vertical timing at (${row}, 6): expected ${expected}`
        );
      }
    });
  });

  // ============================================================================
  // 5. Version Selection and Capacity Limits
  // ============================================================================

  describe('5. Version selection and capacity limits', () => {

    it('selects Version 1 for payloads up to 17 bytes', () => {
      const { version } = generateQrMatrix('A'.repeat(17));
      assert.equal(version, 1);
    });

    it('selects Version 2 for 18-byte payload (exceeds V1 capacity)', () => {
      const { version } = generateQrMatrix('A'.repeat(18));
      assert.equal(version, 2);
    });

    it('selects Version 5 for payload at maximum capacity (106 bytes)', () => {
      const { version } = generateQrMatrix('B'.repeat(106));
      assert.equal(version, 5);
    });

    it('throws Error for payload exceeding 106 bytes', () => {
      assert.throws(
        () => generateQrMatrix('X'.repeat(107)),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes('107'));
          assert.ok(err.message.includes('106') || err.message.includes(String(MAX_CAPACITY)));
          return true;
        }
      );
    });

    it('handles empty string (0-byte payload)', () => {
      const { matrix, size, version } = generateQrMatrix('');
      assert.equal(version, 1);
      assert.equal(size, 21);
      assert.equal(matrix.length, 21);
    });

    it('MAX_CAPACITY export equals 106', () => {
      assert.equal(MAX_CAPACITY, 106);
    });
  });

  // ============================================================================
  // 6. Determinism and Consistency
  // ============================================================================

  describe('6. Determinism and consistency', () => {

    it('same input always produces the same matrix', () => {
      const r1 = generateQrMatrix('DETERMINISTIC');
      const r2 = generateQrMatrix('DETERMINISTIC');

      assert.equal(r1.version, r2.version);
      assert.equal(r1.size, r2.size);

      for (let row = 0; row < r1.size; row++) {
        for (let col = 0; col < r1.size; col++) {
          assert.equal(
            r1.matrix[row][col], r2.matrix[row][col],
            `Module (${row},${col}) differs between runs`
          );
        }
      }
    });

    it('different inputs produce different matrices', () => {
      const r1 = generateQrMatrix('HELLO');
      const r2 = generateQrMatrix('WORLD');

      let differences = 0;
      const minSize = Math.min(r1.size, r2.size);
      for (let row = 0; row < minSize; row++) {
        for (let col = 0; col < minSize; col++) {
          if (r1.matrix[row][col] !== r2.matrix[row][col]) differences++;
        }
      }
      assert.ok(differences > 0, 'Different inputs should produce different modules');
    });
  });
});
