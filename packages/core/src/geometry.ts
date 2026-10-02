/**
 * Geometry helpers: 4x4 layer transforms (column-major, as WGSL expects) and planar homographies
 * for projector alignment.
 */
import type { Vec2, Vec3 } from "./model.ts";

export type Mat4 = Float64Array; // column-major, length 16
export type Mat3 = Float64Array; // column-major, length 9

export const mat4Identity = (): Mat4 => {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
};

export const mat4Mul = (a: Mat4, b: Mat4): Mat4 => {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      o[c * 4 + r] = s;
    }
  }
  return o;
};

export const mat4Translate = (x: number, y: number, z: number): Mat4 => {
  const m = mat4Identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
};

export const mat4Scale = (x: number, y: number, z: number): Mat4 => {
  const m = mat4Identity();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
};

export const mat4RotX = (rad: number): Mat4 => {
  const m = mat4Identity();
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
};
export const mat4RotY = (rad: number): Mat4 => {
  const m = mat4Identity();
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
};
export const mat4RotZ = (rad: number): Mat4 => {
  const m = mat4Identity();
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
  return m;
};

const DEG = Math.PI / 180;

/**
 * After Effects layer transform: translate(position) · rotX · rotY · rotZ · scale · translate(-anchor).
 * In y-down composition space a positive Z rotation turns clockwise on screen, matching AE.
 */
export const layerMatrix = (anchor: Vec3, position: Vec3, scalePct: Vec3, rotationDeg: Vec3): Mat4 => {
  let m = mat4Translate(position[0], position[1], position[2]);
  if (rotationDeg[0]) m = mat4Mul(m, mat4RotX(rotationDeg[0] * DEG));
  if (rotationDeg[1]) m = mat4Mul(m, mat4RotY(rotationDeg[1] * DEG));
  if (rotationDeg[2]) m = mat4Mul(m, mat4RotZ(rotationDeg[2] * DEG));
  m = mat4Mul(m, mat4Scale(scalePct[0] / 100, scalePct[1] / 100, scalePct[2] / 100));
  return mat4Mul(m, mat4Translate(-anchor[0], -anchor[1], -anchor[2]));
};

export const mat4TransformPoint = (m: Mat4, x: number, y: number, z = 0): Vec3 => {
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  return [
    (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w,
    (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w,
    (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) / w,
  ];
};

export const mat4ToF32 = (m: Mat4): Float32Array => Float32Array.from(m);

// ---------------------------------------------------------------------------------------------
// Homography (planar projective transform), used for corner-pin alignment and the Corner Pin effect.

export const mat3Identity = (): Mat3 => Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);

export const applyHomography = (h: Mat3, p: Vec2): Vec2 => {
  const x = p[0];
  const y = p[1];
  const w = h[2]! * x + h[5]! * y + h[8]!;
  return [(h[0]! * x + h[3]! * y + h[6]!) / w, (h[1]! * x + h[4]! * y + h[7]!) / w];
};

export const mat3Invert = (m: Mat3): Mat3 | null => {
  const [a, b, c, d, e, f, g, h, i] = m as unknown as number[];
  const A = e! * i! - f! * h!;
  const B = -(d! * i! - f! * g!);
  const C = d! * h! - e! * g!;
  const det = a! * A + b! * B + c! * C;
  if (Math.abs(det) < 1e-14) return null;
  const inv = Float64Array.from([
    A, -(b! * i! - c! * h!), b! * f! - c! * e!,
    B, a! * i! - c! * g!, -(a! * f! - c! * d!),
    C, -(a! * h! - b! * g!), a! * e! - b! * d!,
  ]);
  for (let k = 0; k < 9; k++) inv[k]! /= det;
  return inv;
};

/** Solve a dense linear system Ax = b (n x n) with partial pivoting. Returns null when singular. */
export const solveLinear = (A: number[][], b: number[]): number[] | null => {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]! / M[col]![col]!;
      if (f === 0) continue;
      for (let k = col; k <= n; k++) M[r]![k]! -= f * M[col]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
};

const normalizer = (pts: readonly Vec2[]) => {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const md = pts.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / pts.length || 1;
  const s = Math.SQRT2 / md;
  return { T: Float64Array.from([s, 0, 0, 0, s, 0, -s * cx, -s * cy, 1]) as Mat3, apply: (p: Vec2): Vec2 => [(p[0] - cx) * s, (p[1] - cy) * s] };
};

const mat3Mul = (a: Mat3, b: Mat3): Mat3 => {
  const o = new Float64Array(9);
  for (let c = 0; c < 3; c++)
    for (let r = 0; r < 3; r++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[k * 3 + r]! * b[c * 3 + k]!;
      o[c * 3 + r] = s;
    }
  return o;
};

/**
 * Homography mapping src[i] → dst[i]. Four points give an exact solve; more points give a
 * least-squares fit (normalised DLT with h33 = 1) so the residuals measure alignment quality.
 */
export const solveHomography = (src: readonly Vec2[], dst: readonly Vec2[]): Mat3 | null => {
  if (src.length !== dst.length || src.length < 4) return null;
  const ns = normalizer(src);
  const nd = normalizer(dst);
  // Normal equations for the 8 unknowns.
  const AtA = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const Atb = new Array<number>(8).fill(0);
  const addRow = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      Atb[i]! += row[i]! * rhs;
      for (let j = 0; j < 8; j++) AtA[i]![j]! += row[i]! * row[j]!;
    }
  };
  for (let i = 0; i < src.length; i++) {
    const [x, y] = ns.apply(src[i]!);
    const [u, v] = nd.apply(dst[i]!);
    addRow([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    addRow([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solveLinear(AtA, Atb);
  if (!h) return null;
  // Row-major h → column-major Mat3.
  const Hn = Float64Array.from([h[0]!, h[3]!, h[6]!, h[1]!, h[4]!, h[7]!, h[2]!, h[5]!, 1]);
  const ndInv = mat3Invert(nd.T);
  if (!ndInv) return null;
  const H = mat3Mul(mat3Mul(ndInv, Hn), ns.T);
  const s = H[8]!;
  if (Math.abs(s) < 1e-14) return null;
  for (let k = 0; k < 9; k++) H[k]! /= s;
  return H;
};

/** Per-point alignment error in output pixels (how far each point lands from where it should). */
export const homographyResiduals = (H: Mat3, src: readonly Vec2[], dst: readonly Vec2[]): number[] =>
  src.map((p, i) => {
    const q = applyHomography(H, p);
    return Math.hypot(q[0] - dst[i]![0], q[1] - dst[i]![1]);
  });

/** Signed area test: false when the quad folds over itself (a common alignment mistake to flag). */
export const isConvexQuad = (q: readonly Vec2[]): boolean => {
  if (q.length !== 4) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const c = q[(i + 2) % 4]!;
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (z === 0) continue;
    if (sign === 0) sign = Math.sign(z);
    else if (Math.sign(z) !== sign) return false;
  }
  return true;
};
