/**
 * Big-endian field access over the file bytes.
 *
 * File-format knowledge from py_aep (MIT, © 2023 Fortiche production, https://github.com/forticheprod/py-aep)
 * and aftereffects-aep-parser (MIT, © 2020 Boltframe).
 */

import type { Chunk } from "./riff.ts";

const utf8Decoder = new TextDecoder("utf-8");

export class Bin {
  readonly dv: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(o: number): number {
    return this.bytes[o] ?? 0;
  }
  u16(o: number): number {
    return this.dv.getUint16(o, false);
  }
  u32(o: number): number {
    return this.dv.getUint32(o, false);
  }
  s32(o: number): number {
    return this.dv.getInt32(o, false);
  }
  f32(o: number): number {
    return this.dv.getFloat32(o, false);
  }
  f64(o: number, littleEndian = false): number {
    return this.dv.getFloat64(o, littleEndian);
  }

  /** Field of a chunk body, or `fallback` when the body is too short (older files write shorter chunks). */
  cu8(c: Chunk, off: number, fallback = 0): number {
    return c.start + off + 1 <= c.end ? this.u8(c.start + off) : fallback;
  }
  cu16(c: Chunk, off: number, fallback = 0): number {
    return c.start + off + 2 <= c.end ? this.u16(c.start + off) : fallback;
  }
  cu32(c: Chunk, off: number, fallback = 0): number {
    return c.start + off + 4 <= c.end ? this.u32(c.start + off) : fallback;
  }
  cs32(c: Chunk, off: number, fallback = 0): number {
    return c.start + off + 4 <= c.end ? this.s32(c.start + off) : fallback;
  }
  cf32(c: Chunk, off: number, fallback = 0): number {
    return c.start + off + 4 <= c.end ? this.f32(c.start + off) : fallback;
  }
  cf64(c: Chunk, off: number, fallback = 0): number {
    return c.start + off + 8 <= c.end ? this.f64(c.start + off) : fallback;
  }
  /** Whether the body has at least `n` bytes. */
  has(c: Chunk, n: number): boolean {
    return c.end - c.start >= n;
  }

  /** UTF-8 text of a whole chunk body (Utf8, alas, tdmn …), cut at the first NUL. */
  text(c: Chunk | undefined): string {
    if (!c) return "";
    return this.str(c.start, c.end);
  }
  /** UTF-8 text in [start, end), cut at the first NUL. */
  str(start: number, end: number): string {
    let e = start;
    while (e < end && this.bytes[e] !== 0) e++;
    return utf8Decoder.decode(this.bytes.subarray(start, e));
  }
  /** Fixed-width NUL-padded UTF-8 field inside a chunk body. */
  cstr(c: Chunk, off: number, len: number): string {
    const s = c.start + off;
    if (s >= c.end) return "";
    return this.str(s, Math.min(c.end, s + len));
  }
  /** Big-endian doubles filling a chunk body (cdat, otda …). */
  doubles(c: Chunk, littleEndian = false): number[] {
    const n = Math.floor((c.end - c.start) / 8);
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = this.f64(c.start + i * 8, littleEndian);
    return out;
  }
  slice(c: Chunk): Uint8Array {
    return this.bytes.subarray(c.start, c.end);
  }
}

/** A ratio AE stores as dividend / divisor (times, durations, aspect ratios). */
export const ratio = (dividend: number, divisor: number): number => (divisor === 0 ? 0 : dividend / divisor);
