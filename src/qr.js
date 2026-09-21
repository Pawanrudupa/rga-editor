/**
 * src/qr.js — Zero-Dependency QR Code Generator
 *
 * Implements ISO/IEC 18004 QR Code encoding for Versions 1–5,
 * Error Correction Level L, single-block payloads only.
 *
 * Maximum capacity: 106 bytes (Version 5-L, Byte Mode).
 *
 * Hand-written from scratch:
 *   - Galois Field GF(2^8) arithmetic (primitive polynomial 0x11D)
 *   - Reed-Solomon error correction via synthetic polynomial division
 *   - QR matrix layout: finder, separator, timing, alignment, dark module
 *   - Format information BCH(15,5) encoding
 *   - 8-mask penalty evaluation (Rules 1–4)
 *   - Zig-zag data module placement
 *   - HTML Canvas pixel rendering
 *
 * Zero npm packages. Zero external dependencies. Pure ES6 JavaScript.
 */

// ============================================================================
// 1. GALOIS FIELD GF(2^8) ARITHMETIC
// ============================================================================
//
// All QR Reed-Solomon computation operates over GF(2^8) with primitive
// polynomial P(x) = x^8 + x^4 + x^3 + x^2 + 1  (binary: 0x11D).
//
// The primitive element α = 2 generates all 255 non-zero elements.
// We precompute EXP (power) and LOG (discrete logarithm) lookup tables
// so that multiplication reduces to table lookups and addition mod 255.

/** @type {Uint8Array} EXP[i] = α^i mod P(x). Double-sized to avoid mod 255. */
const GF_EXP = new Uint8Array(512);

/** @type {Uint8Array} LOG[x] = i such that α^i = x. LOG[0] is undefined. */
const GF_LOG = new Uint8Array(256);

// Build the lookup tables at module load time
{
  let x = 1; // α^0 = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    // Multiply by α (= 2), reducing modulo P(x) when degree overflows
    x = (x << 1) ^ (x & 0x80 ? 0x11D : 0);
  }
  // Double the table for convenient index arithmetic without % 255:
  // max index = LOG[a] + LOG[b] ≤ 254 + 254 = 508 < 512
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
}

/**
 * Multiplies two elements in GF(2^8).
 * @param {number} a - Field element (0–255)
 * @param {number} b - Field element (0–255)
 * @returns {number} a × b in GF(2^8)
 */
export function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

// ============================================================================
// 2. REED-SOLOMON ERROR CORRECTION
// ============================================================================
//
// QR codes use systematic Reed-Solomon codes. The generator polynomial
// G(x) = ∏(x − α^i) for i = 0 .. ecCount−1 is computed iteratively by
// multiplying linear factors. The EC codewords are the remainder of
// dividing the message polynomial M(x)·x^ecCount by G(x) over GF(2^8).

/**
 * Computes the RS generator polynomial of the given degree.
 * Returns coefficients [g0, g1, ..., g_ecCount] where g0 = 1 (monic),
 * representing g0·x^ecCount + g1·x^(ecCount−1) + ... + g_ecCount.
 *
 * @param {number} ecCount - Number of error correction codewords (= polynomial degree)
 * @returns {number[]} Generator polynomial coefficients
 */
export function getGeneratorPoly(ecCount) {
  // Start with G(x) = 1  (the multiplicative identity polynomial)
  let gen = [1];

  for (let i = 0; i < ecCount; i++) {
    // Multiply current G(x) by (x + α^i) — note: in GF(2), + and − are XOR
    const newGen = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      newGen[j] ^= gen[j];                       // coefficient from gen[j] · x
      newGen[j + 1] ^= gfMul(gen[j], GF_EXP[i]); // coefficient from gen[j] · α^i
    }
    gen = newGen;
  }

  return gen;
}

/**
 * Computes Reed-Solomon error correction codewords for the given data.
 * Uses polynomial long division of M(x)·x^ecCount by G(x).
 *
 * @param {number[]} data - Data codewords (bytes)
 * @param {number} ecCount - Number of EC codewords to generate
 * @returns {number[]} EC codewords (length = ecCount)
 */
export function computeReedSolomon(data, ecCount) {
  const gen = getGeneratorPoly(ecCount);

  // Working buffer: data padded with ecCount zeros on the right
  // After division, the rightmost ecCount positions hold the remainder
  const work = new Uint8Array(data.length + ecCount);
  for (let i = 0; i < data.length; i++) work[i] = data[i];

  for (let i = 0; i < data.length; i++) {
    const lead = work[i]; // Leading coefficient of current dividend
    if (lead !== 0) {
      for (let j = 0; j < gen.length; j++) {
        work[i + j] ^= gfMul(gen[j], lead);
      }
      // work[i] is now 0 (since gen[0]=1, gfMul(1,lead)=lead, lead^lead=0)
    }
  }

  return Array.from(work.slice(data.length));
}

// ============================================================================
// 3. VERSION TABLE (Versions 1–5, Error Correction Level L, Single Block)
// ============================================================================

/**
 * @typedef {Object} VersionInfo
 * @property {number} size           - Matrix dimension (4V+17)
 * @property {number} dataCodewords  - Number of data codewords
 * @property {number} ecCodewords    - Number of error correction codewords
 * @property {number[]} alignPos     - Alignment pattern position coordinates
 * @property {number} remainderBits  - Remainder bits after all codewords placed
 */

/** @type {Object<number, VersionInfo>} */
const VERSION_TABLE = {
  1: { size: 21, dataCodewords: 19,  ecCodewords: 7,  alignPos: [],       remainderBits: 0 },
  2: { size: 25, dataCodewords: 34,  ecCodewords: 10, alignPos: [6, 18],  remainderBits: 7 },
  3: { size: 29, dataCodewords: 55,  ecCodewords: 15, alignPos: [6, 22],  remainderBits: 7 },
  4: { size: 33, dataCodewords: 80,  ecCodewords: 20, alignPos: [6, 26],  remainderBits: 7 },
  5: { size: 37, dataCodewords: 108, ecCodewords: 26, alignPos: [6, 30],  remainderBits: 7 },
};

/** Maximum byte-mode payload for Version 5-L (single block). */
export const MAX_CAPACITY = 106;

// ============================================================================
// 4. DATA ENCODING (Byte Mode, ISO/IEC 8859-1)
// ============================================================================

/**
 * Selects the smallest QR version (1–5) that can hold the payload.
 * @param {number} byteLength - Payload size in bytes
 * @returns {number|null} Version number, or null if too large
 */
function selectVersion(byteLength) {
  for (let v = 1; v <= 5; v++) {
    const info = VERSION_TABLE[v];
    // Available data bits = dataCodewords*8 minus mode(4) and count(8) overhead
    const maxBytes = Math.floor((info.dataCodewords * 8 - 12) / 8);
    if (byteLength <= maxBytes) return v;
  }
  return null;
}

/**
 * Encodes a byte array into QR data codewords using Byte Mode (0100).
 *
 * Bit layout: [mode 4b] [count 8b] [data N×8b] [terminator ≤4b] [pad 0s] [0xEC/0x11 fill]
 *
 * @param {number[]} bytes - Payload bytes (0–255 each)
 * @param {number} version - QR version (1–5)
 * @returns {number[]} Data codewords array
 */
function encodeData(bytes, version) {
  const info = VERSION_TABLE[version];
  const totalBits = info.dataCodewords * 8;
  const bits = [];

  // Helper: push `count` bits of `value` (MSB first)
  const pushBits = (value, count) => {
    for (let i = count - 1; i >= 0; i--) {
      bits.push((value >> i) & 1);
    }
  };

  // 1. Mode indicator: Byte mode = 0100
  pushBits(0b0100, 4);

  // 2. Character count indicator (8 bits for versions 1–9)
  pushBits(bytes.length, 8);

  // 3. Data bytes
  for (const b of bytes) {
    pushBits(b, 8);
  }

  // 4. Terminator: up to 4 zero bits (never exceed total capacity)
  const terminatorLen = Math.min(4, totalBits - bits.length);
  for (let i = 0; i < terminatorLen; i++) bits.push(0);

  // 5. Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  // 6. Fill remaining capacity with alternating pad codewords (0xEC, 0x11)
  const pads = [0xEC, 0x11];
  let padIdx = 0;
  while (bits.length < totalBits) {
    pushBits(pads[padIdx % 2], 8);
    padIdx++;
  }

  // 7. Convert bit array to byte array
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }

  return codewords;
}

// ============================================================================
// 5. MATRIX CONSTRUCTION — Function Patterns
// ============================================================================

/**
 * Places the three 7×7 finder patterns at the top-left, top-right,
 * and bottom-left corners of the matrix.
 *
 * Finder pattern (7×7):
 *   ■ ■ ■ ■ ■ ■ ■
 *   ■ □ □ □ □ □ ■
 *   ■ □ ■ ■ ■ □ ■
 *   ■ □ ■ ■ ■ □ ■
 *   ■ □ ■ ■ ■ □ ■
 *   ■ □ □ □ □ □ ■
 *   ■ ■ ■ ■ ■ ■ ■
 */
function placeFinderPatterns(matrix, reserved, size) {
  const corners = [[0, 0], [0, size - 7], [size - 7, 0]];

  for (const [sr, sc] of corners) {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const isDark =
          r === 0 || r === 6 || c === 0 || c === 6 ||  // outer ring
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);       // inner 3×3
        matrix[sr + r][sc + c] = isDark ? 1 : 0;
        reserved[sr + r][sc + c] = 1;
      }
    }
  }
}

/**
 * Places 1-module-wide white separators around the inner edges of each
 * finder pattern. Each separator forms an L-shape of 15 modules.
 */
function placeSeparators(matrix, reserved, size) {
  const setWhite = (r, c) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      matrix[r][c] = 0;
      reserved[r][c] = 1;
    }
  };

  // Top-left: bottom edge (row 7, cols 0–7) + right edge (col 7, rows 0–6)
  for (let i = 0; i <= 7; i++) setWhite(7, i);
  for (let i = 0; i <= 6; i++) setWhite(i, 7);

  // Top-right: bottom edge (row 7, cols size−8 to size−1) + left edge (col size−8, rows 0–6)
  for (let i = 0; i <= 7; i++) setWhite(7, size - 8 + i);
  for (let i = 0; i <= 6; i++) setWhite(i, size - 8);

  // Bottom-left: top edge (row size−8, cols 0–7) + right edge (col 7, rows size−7 to size−1)
  for (let i = 0; i <= 7; i++) setWhite(size - 8, i);
  for (let i = size - 7; i <= size - 1; i++) setWhite(i, 7);
}

/**
 * Places horizontal (row 6) and vertical (col 6) timing patterns.
 * Timing patterns are alternating dark/light modules between the
 * finder patterns, starting and ending with dark.
 */
function placeTimingPatterns(matrix, reserved, size) {
  for (let i = 8; i < size - 8; i++) {
    const isDark = (i % 2 === 0) ? 1 : 0;

    // Horizontal timing: row 6, cols 8 to size−9
    if (!reserved[6][i]) {
      matrix[6][i] = isDark;
      reserved[6][i] = 1;
    }

    // Vertical timing: col 6, rows 8 to size−9
    if (!reserved[i][6]) {
      matrix[i][6] = isDark;
      reserved[i][6] = 1;
    }
  }
}

/**
 * Returns alignment pattern center coordinates for the given version,
 * filtering out positions that would overlap with finder+separator blocks.
 *
 * For versions 2–5 with a 2-element position list, exactly one center
 * survives (the bottom-right intersection).
 *
 * @param {number} version
 * @param {number} size
 * @returns {Array<[number, number]>}
 */
function getAlignmentCenters(version, size) {
  const positions = VERSION_TABLE[version].alignPos;
  if (positions.length === 0) return [];

  const centers = [];
  for (const r of positions) {
    for (const c of positions) {
      // Skip if the 5×5 alignment pattern overlaps any 8×8 finder+separator block
      const overlapTL = (r <= 9 && c <= 9);
      const overlapTR = (r <= 9 && c >= size - 10);
      const overlapBL = (r >= size - 10 && c <= 9);
      if (!overlapTL && !overlapTR && !overlapBL) {
        centers.push([r, c]);
      }
    }
  }
  return centers;
}

/**
 * Places 5×5 alignment patterns at the computed center positions.
 *
 * Alignment pattern (5×5):
 *   ■ ■ ■ ■ ■
 *   ■ □ □ □ ■
 *   ■ □ ■ □ ■
 *   ■ □ □ □ ■
 *   ■ ■ ■ ■ ■
 */
function placeAlignmentPatterns(matrix, reserved, version, size) {
  const centers = getAlignmentCenters(version, size);

  for (const [cr, cc] of centers) {
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const isDark =
          Math.abs(dr) === 2 || Math.abs(dc) === 2 ||  // outer ring
          (dr === 0 && dc === 0);                        // center dot
        matrix[cr + dr][cc + dc] = isDark ? 1 : 0;
        reserved[cr + dr][cc + dc] = 1;
      }
    }
  }
}

/**
 * Sets the fixed dark module at position (4V+9, 8) = (size−8, 8).
 * This module is always dark in every QR code.
 */
function placeDarkModule(matrix, reserved, version) {
  const row = 4 * version + 9;
  matrix[row][8] = 1;
  reserved[row][8] = 1;
}

/**
 * Reserves the 30 modules used for format information (two copies of 15 bits).
 * Values are written later after mask selection.
 */
function reserveFormatInfoAreas(reserved, size) {
  // Copy 1: around top-left finder
  const copy1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];

  // Copy 2: near bottom-left and top-right finders
  const copy2 = [];
  for (let i = 0; i < 7; i++) copy2.push([size - 1 - i, 8]);
  for (let i = 0; i < 8; i++) copy2.push([8, size - 8 + i]);

  for (const [r, c] of copy1) reserved[r][c] = 1;
  for (const [r, c] of copy2) reserved[r][c] = 1;
}

// ============================================================================
// 6. DATA PLACEMENT — Zig-Zag Module Positioning
// ============================================================================

/**
 * Returns the ordered list of data module positions in the standard
 * QR zig-zag pattern: 2-column strips from right to left, alternating
 * upward and downward, skipping column 6 (vertical timing pattern).
 *
 * Within each 2-column strip at a given row, the right module is
 * placed before the left module.
 *
 * @param {Uint8Array[]} reserved - Reserved module map
 * @param {number} size - Matrix dimension
 * @returns {Array<[number, number]>} Ordered (row, col) positions
 */
function getDataModulePositions(reserved, size) {
  const positions = [];
  let goingUp = true;

  let col = size - 1;
  while (col > 0) {
    // Skip the vertical timing pattern column
    if (col === 6) col--;

    for (let i = 0; i < size; i++) {
      const row = goingUp ? (size - 1 - i) : i;

      // Right module of the 2-column strip
      if (!reserved[row][col]) {
        positions.push([row, col]);
      }
      // Left module of the 2-column strip
      if (col - 1 >= 0 && !reserved[row][col - 1]) {
        positions.push([row, col - 1]);
      }
    }

    col -= 2;
    goingUp = !goingUp;
  }

  return positions;
}

/**
 * Places the codeword bitstream into data modules using the zig-zag order.
 * Any remaining module positions beyond the bitstream length are set to 0
 * (remainder bits per the QR specification).
 */
function placeDataBits(matrix, reserved, bitstream, size) {
  const positions = getDataModulePositions(reserved, size);

  for (let i = 0; i < positions.length; i++) {
    const [row, col] = positions[i];
    matrix[row][col] = i < bitstream.length ? bitstream[i] : 0;
  }
}

// ============================================================================
// 7. MASKING
// ============================================================================

/**
 * The 8 standard QR mask pattern conditions.
 * A data module is inverted if the condition evaluates to true.
 *
 * @param {number} pattern - Mask pattern index (0–7)
 * @param {number} row
 * @param {number} col
 * @returns {boolean}
 */
function getMaskBit(pattern, row, col) {
  switch (pattern) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return (row * col) % 2 + (row * col) % 3 === 0;
    case 6: return ((row * col) % 2 + (row * col) % 3) % 2 === 0;
    case 7: return ((row + col) % 2 + (row * col) % 3) % 2 === 0;
    default: return false;
  }
}

/**
 * Applies (or un-applies) a mask pattern to all data (non-reserved) modules.
 * Since the operation is XOR, calling it twice with the same pattern undoes it.
 */
function applyMask(matrix, reserved, maskPattern, size) {
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!reserved[row][col] && getMaskBit(maskPattern, row, col)) {
        matrix[row][col] ^= 1;
      }
    }
  }
}

// ============================================================================
// 8. PENALTY EVALUATION (Rules 1–4)
// ============================================================================

/**
 * Evaluates the total penalty score for a masked QR matrix.
 * Lower penalty = better mask choice.
 *
 * @param {Uint8Array[]} matrix
 * @param {number} size
 * @returns {number} Total penalty score
 */
function evaluatePenalty(matrix, size) {
  let penalty = 0;

  // --- Rule 1: Adjacent modules in same row/column ---
  // For each consecutive run of ≥5 same-color modules, add (runLength − 2)
  for (let row = 0; row < size; row++) {
    let run = 1;
    for (let col = 1; col < size; col++) {
      if (matrix[row][col] === matrix[row][col - 1]) {
        run++;
      } else {
        if (run >= 5) penalty += run - 2;
        run = 1;
      }
    }
    if (run >= 5) penalty += run - 2;
  }

  for (let col = 0; col < size; col++) {
    let run = 1;
    for (let row = 1; row < size; row++) {
      if (matrix[row][col] === matrix[row - 1][col]) {
        run++;
      } else {
        if (run >= 5) penalty += run - 2;
        run = 1;
      }
    }
    if (run >= 5) penalty += run - 2;
  }

  // --- Rule 2: 2×2 blocks of same color ---
  // For each 2×2 block of uniform color, add 3
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const v = matrix[row][col];
      if (v === matrix[row][col + 1] &&
          v === matrix[row + 1][col] &&
          v === matrix[row + 1][col + 1]) {
        penalty += 3;
      }
    }
  }

  // --- Rule 3: Finder-like patterns ---
  // Look for 1,0,1,1,1,0,1 flanked by 4 light modules on either side
  const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]; // pattern + 4 light on right
  const p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]; // 4 light on left + pattern

  const matchPattern = (getModule) => {
    let m1 = true, m2 = true;
    for (let k = 0; k < 11; k++) {
      const v = getModule(k);
      if (v !== p1[k]) m1 = false;
      if (v !== p2[k]) m2 = false;
      if (!m1 && !m2) return 0;
    }
    return (m1 ? 40 : 0) + (m2 ? 40 : 0);
  };

  for (let row = 0; row < size; row++) {
    for (let col = 0; col <= size - 11; col++) {
      penalty += matchPattern(k => matrix[row][col + k]);
    }
  }
  for (let col = 0; col < size; col++) {
    for (let row = 0; row <= size - 11; row++) {
      penalty += matchPattern(k => matrix[row + k][col]);
    }
  }

  // --- Rule 4: Dark module ratio ---
  // Penalty for deviation from 50% dark modules
  let darkCount = 0;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (matrix[row][col]) darkCount++;
    }
  }
  const percent = (darkCount * 100) / (size * size);
  const prev5 = Math.floor(percent / 5) * 5;
  const next5 = prev5 + 5;
  penalty += Math.min(
    Math.abs(prev5 - 50) / 5,
    Math.abs(next5 - 50) / 5
  ) * 10;

  return penalty;
}

// ============================================================================
// 9. FORMAT INFORMATION — BCH(15,5) Encoding
// ============================================================================

/**
 * Computes the 15-bit format information for EC Level L and the given mask.
 *
 * Format information = BCH(15,5) encoding of (EC_level << 3 | mask),
 * XORed with mask pattern 0x5412 to ensure the result is never all-zero.
 *
 * EC Level L = 01 (binary)
 *
 * @param {number} maskPattern - Mask pattern index (0–7)
 * @returns {number} 15-bit format information value
 */
function computeFormatInfo(maskPattern) {
  const data = (0b01 << 3) | maskPattern; // 5 bits: EC level L (01) + mask (3 bits)

  // BCH(15,5) generator: x^10 + x^8 + x^5 + x^4 + x^2 + x + 1 = 0b10100110111
  const GEN = 0b10100110111;

  // Polynomial division: find remainder of (data << 10) / GEN
  let remainder = data << 10;
  for (let i = 4; i >= 0; i--) {
    if (remainder & (1 << (i + 10))) {
      remainder ^= GEN << i;
    }
  }

  // Combine data bits and check bits, then XOR with mask
  return ((data << 10) | remainder) ^ 0x5412;
}

/**
 * Places format information bits into the two designated areas of the matrix.
 *
 * Copy 1: L-shaped strip around the top-left finder pattern
 *   - Row 8, cols 0–5 and 7–8
 *   - Col 8, rows 7, 5–0
 *
 * Copy 2: Split between bottom-left (vertical) and top-right (horizontal)
 *   - Col 8, rows N−1 down to N−7
 *   - Row 8, cols N−8 through N−1
 *
 * @param {Uint8Array[]} matrix
 * @param {number} formatBits - 15-bit format information
 * @param {number} size - Matrix dimension
 */
function placeFormatInfo(matrix, formatBits, size) {
  // Copy 1 positions (bit 0 = MSB at index 0)
  const copy1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];

  // Copy 2 positions
  const copy2 = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8],
    [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5],
    [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ];

  for (let i = 0; i < 15; i++) {
    const bit = (formatBits >> (14 - i)) & 1;

    const [r1, c1] = copy1[i];
    matrix[r1][c1] = bit;

    const [r2, c2] = copy2[i];
    matrix[r2][c2] = bit;
  }
}

// ============================================================================
// 10. MAIN API — generateQrMatrix
// ============================================================================

/**
 * Generates a QR code matrix for the given text payload.
 *
 * Workflow:
 *   1. Select smallest version (1–5) that fits the payload
 *   2. Encode data into codewords (Byte Mode)
 *   3. Compute Reed-Solomon EC codewords
 *   4. Build codeword bitstream
 *   5. Construct matrix with all function patterns
 *   6. Place data bits in zig-zag order
 *   7. Evaluate all 8 mask patterns, select lowest penalty
 *   8. Apply optimal mask and place format information
 *
 * @param {string} text - Text payload to encode (max 106 bytes)
 * @returns {{ matrix: Uint8Array[], size: number, version: number }}
 * @throws {Error} If payload exceeds single-block capacity (106 bytes)
 */
export function generateQrMatrix(text) {
  // Convert string to byte array (ISO 8859-1 / Latin-1)
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 255) {
      throw new Error(`Character at index ${i} (U+${code.toString(16).toUpperCase()}) exceeds byte mode range (0–255)`);
    }
    bytes.push(code);
  }

  // 1. Select version
  const version = selectVersion(bytes.length);
  if (version === null) {
    throw new Error(
      `Payload too large: ${bytes.length} bytes exceeds single-block QR capacity ` +
      `(max ${MAX_CAPACITY} bytes for Version 5-L). Use manual copy/paste instead.`
    );
  }

  const info = VERSION_TABLE[version];
  const size = info.size;

  // 2. Encode data into codewords
  const dataCodewords = encodeData(bytes, version);

  // 3. Compute Reed-Solomon EC codewords
  const ecCodewords = computeReedSolomon(dataCodewords, info.ecCodewords);

  // 4. Build complete bitstream (data + EC codewords)
  const allCodewords = [...dataCodewords, ...ecCodewords];
  const bitstream = [];
  for (const cw of allCodewords) {
    for (let i = 7; i >= 0; i--) {
      bitstream.push((cw >> i) & 1);
    }
  }

  // 5. Construct matrix and reserved map
  const matrix = Array.from({ length: size }, () => new Uint8Array(size));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));

  // Place all function patterns
  placeFinderPatterns(matrix, reserved, size);
  placeSeparators(matrix, reserved, size);
  placeTimingPatterns(matrix, reserved, size);
  placeAlignmentPatterns(matrix, reserved, version, size);
  placeDarkModule(matrix, reserved, version);
  reserveFormatInfoAreas(reserved, size);

  // 6. Place data bits in zig-zag order
  placeDataBits(matrix, reserved, bitstream, size);

  // 7. Evaluate all 8 mask patterns, select the one with lowest penalty
  let bestMask = 0;
  let bestPenalty = Infinity;

  for (let m = 0; m < 8; m++) {
    // Apply mask (XOR on data modules)
    applyMask(matrix, reserved, m, size);

    // Place format info for this mask
    const fmtBits = computeFormatInfo(m);
    placeFormatInfo(matrix, fmtBits, size);

    // Evaluate penalty
    const p = evaluatePenalty(matrix, size);
    if (p < bestPenalty) {
      bestPenalty = p;
      bestMask = m;
    }

    // Undo mask (XOR again restores original data module values)
    applyMask(matrix, reserved, m, size);
  }

  // 8. Apply optimal mask permanently and place final format info
  applyMask(matrix, reserved, bestMask, size);
  const finalFormat = computeFormatInfo(bestMask);
  placeFormatInfo(matrix, finalFormat, size);

  return { matrix, size, version };
}

// ============================================================================
// 11. CANVAS RENDERING
// ============================================================================

/**
 * Renders a QR code matrix onto an HTML Canvas element.
 *
 * @param {HTMLCanvasElement} canvas - Target canvas element
 * @param {Uint8Array[]} matrix - 2D QR matrix (0 = light, 1 = dark)
 * @param {Object} [options]
 * @param {number} [options.cellSize=5]   - Pixel size of each module
 * @param {number} [options.margin=4]     - Quiet zone width in modules
 * @param {string} [options.darkColor='#0f172a']  - Dark module color
 * @param {string} [options.lightColor='#ffffff'] - Light module / quiet zone color
 */
export function renderToCanvas(canvas, matrix, options = {}) {
  const {
    cellSize = 5,
    margin = 4,
    darkColor = '#0f172a',
    lightColor = '#ffffff',
  } = options;

  const qrSize = matrix.length;
  const totalPx = (qrSize + 2 * margin) * cellSize;

  canvas.width = totalPx;
  canvas.height = totalPx;

  const ctx = canvas.getContext('2d');

  // Fill quiet zone (background)
  ctx.fillStyle = lightColor;
  ctx.fillRect(0, 0, totalPx, totalPx);

  // Draw dark modules
  ctx.fillStyle = darkColor;
  for (let row = 0; row < qrSize; row++) {
    for (let col = 0; col < qrSize; col++) {
      if (matrix[row][col]) {
        ctx.fillRect(
          (margin + col) * cellSize,
          (margin + row) * cellSize,
          cellSize,
          cellSize
        );
      }
    }
  }
}
