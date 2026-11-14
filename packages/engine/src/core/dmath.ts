/**
 * Deterministic transcendental functions (docs/MODEL.md §0, §1.1).
 *
 * ECMAScript does not require Math.log/sin/cos to be correctly rounded, so different JS engines
 * may return different last bits. These ports of fdlibm use only IEEE-754 arithmetic and exact
 * bit reinterpretation, so every engine returns identical results.
 */

const buf = new DataView(new ArrayBuffer(8));

function hi(x: number): number {
  buf.setFloat64(0, x, true);
  return buf.getInt32(4, true);
}
function lo(x: number): number {
  buf.setFloat64(0, x, true);
  return buf.getUint32(0, true);
}
function withHi(x: number, h: number): number {
  buf.setFloat64(0, x, true);
  buf.setInt32(4, h, true);
  return buf.getFloat64(0, true);
}

const LN2_HI = 6.93147180369123816490e-1;
const LN2_LO = 1.90821492927058770002e-10;
const TWO54 = 1.8014398509481984e16;
const LG1 = 6.666666666666735130e-1;
const LG2 = 3.999999999940941908e-1;
const LG3 = 2.857142874366239149e-1;
const LG4 = 2.222219843214978396e-1;
const LG5 = 1.818357216161805012e-1;
const LG6 = 1.531383769920937332e-1;
const LG7 = 1.479819860511658591e-1;

/** Natural logarithm, a port of fdlibm __ieee754_log (error < 1 ulp). */
export function dln(x: number): number {
  let hx = hi(x);
  const lx = lo(x);
  let k = 0;
  if (hx < 0x00100000) {
    // x < 2^-1022: zero, negative, or subnormal
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
    if (hx < 0) return NaN;
    k -= 54;
    x *= TWO54;
    hx = hi(x);
  }
  if (hx >= 0x7ff00000) return x + x; // Inf or NaN
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i0 = (hx + 0x95f64) & 0x100000;
  x = withHi(x, hx | (i0 ^ 0x3ff00000)); // normalise x or x/2
  k += i0 >> 20;
  const f = x - 1.0;
  const dk = k;
  if ((0x000fffff & (2 + hx)) < 3) {
    // |f| < 2^-20
    if (f === 0) return k === 0 ? 0 : dk * LN2_HI + dk * LN2_LO;
    const R = f * f * (0.5 - 0.33333333333333333 * f);
    return k === 0 ? f - R : dk * LN2_HI - (R - dk * LN2_LO - f);
  }
  const s = f / (2.0 + f);
  const z = s * s;
  let i = hx - 0x6147a;
  const w = z * z;
  const j = 0x6b851 - hx;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  i |= j;
  const R = t2 + t1;
  if (i > 0) {
    const hfsq = 0.5 * f * f;
    return k === 0 ? f - (hfsq - s * (hfsq + R)) : dk * LN2_HI - (hfsq - (s * (hfsq + R) + dk * LN2_LO) - f);
  }
  return k === 0 ? f - s * (f - R) : dk * LN2_HI - (s * (f - R) - dk * LN2_LO - f);
}

/* ---------- sin / cos (fdlibm kernels, Cody–Waite reduction for |x| < 1e5) ---------- */

const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.08757232129817482790e-9;
const C6 = -1.13596475577881948265e-11;
const INVPIO2 = 6.36619772367581382433e-1;
const PIO2_1 = 1.57079632673412561417;
const PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_2T = 2.02226624879595063154e-21;

function kSin(x: number, y: number): number {
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x - (z * (0.5 * y - v * r) - y - v * S1);
}

function kCos(x: number, y: number): number {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  const hz = 0.5 * z;
  const w = 1.0 - hz;
  return w + (1.0 - w - hz + (z * r - x * y));
}

/** Reduce x to r = x − n·π/2 as a double-double (r, rr); returns n mod 4. */
function reduce(x: number): [number, number, number] {
  const n = Math.floor(x * INVPIO2 + 0.5);
  // Two-step Cody–Waite reduction (π/2 split into 33+33+... bits): exact products for |n| < 2^20.
  let r = x - n * PIO2_1;
  let w = n * PIO2_1T;
  const t = r;
  w = n * PIO2_2;
  r = t - w;
  w = n * PIO2_2T - (t - r - w);
  const y0 = r - w;
  const y1 = r - y0 - w;
  return [y0, y1, ((n % 4) + 4) % 4];
}

/** Deterministic sine for |x| < 1e5 (geometry only). */
export function dsin(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  if (Math.abs(x) <= 0.7853981633974483) return kSin(x, 0);
  const [y0, y1, q] = reduce(x);
  switch (q) {
    case 0:
      return kSin(y0, y1);
    case 1:
      return kCos(y0, y1);
    case 2:
      return -kSin(y0, y1);
    default:
      return -kCos(y0, y1);
  }
}

/** Deterministic cosine for |x| < 1e5 (geometry only). */
export function dcos(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  if (Math.abs(x) <= 0.7853981633974483) return kCos(x, 0);
  const [y0, y1, q] = reduce(x);
  switch (q) {
    case 0:
      return kCos(y0, y1);
    case 1:
      return -kSin(y0, y1);
    case 2:
      return -kCos(y0, y1);
    default:
      return kSin(y0, y1);
  }
}

export const DPI = 3.141592653589793;
