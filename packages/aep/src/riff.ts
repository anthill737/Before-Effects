/**
 * RIFX chunk tree of an After Effects project (.aep).
 *
 * File-format knowledge from py_aep (MIT, © 2023 Fortiche production, https://github.com/forticheprod/py-aep)
 * and aftereffects-aep-parser (MIT, © 2020 Boltframe).
 *
 * An .aep file is one big-endian RIFF ("RIFX") container: 4-byte type, u32 body size, body, and
 * a pad byte when the size is odd. LIST chunks start with a 4-byte list type and hold child
 * chunks. A handful of plain chunks (tdsn, fnam, pdnm, RCom, vfdn) also hold children, without a
 * list type. `LIST:btdk` (text document data) holds raw bytes rather than children.
 */

export class AepReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AepReadError";
  }
}

export const NOT_AEP = "This file isn't an After Effects project (.aep).";
export const DAMAGED = "This After Effects project file looks damaged or incomplete, so it couldn't be read.";
export const AEPX =
  "This is an After Effects XML project (.aepx), which can't be read directly. Save it as an .aep project in After Effects, or export it with the Before Effects exporter script.";

export interface Chunk {
  /** Four-character chunk type ("LIST", "tdmn", …). */
  readonly type: string;
  /** For LIST/RIFX chunks: the four-character list type ("Item", "Layr", "tdgp", …). */
  readonly list: string;
  /** Absolute offset of the chunk body (after the list type for LIST chunks). */
  readonly start: number;
  /** Absolute end of the chunk body. */
  readonly end: number;
  readonly children: readonly Chunk[];
}

/** Plain chunks whose body is a run of child chunks (no list type). */
const CONTAINERS = new Set(["tdsn", "fnam", "pdnm", "RCom", "vfdn"]);
const NO_CHILDREN: readonly Chunk[] = Object.freeze([]);

const fourCC = (b: Uint8Array, o: number): string => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

function readChildren(b: Uint8Array, dv: DataView, start: number, end: number, depth: number): Chunk[] {
  if (depth > 64) throw new AepReadError(DAMAGED);
  const out: Chunk[] = [];
  let p = start;
  while (p + 8 <= end) {
    const type = fourCC(b, p);
    const size = dv.getUint32(p + 4, false);
    const body = p + 8;
    const bodyEnd = body + size;
    if (bodyEnd > end) throw new AepReadError(DAMAGED);
    if (type === "LIST") {
      if (size < 4) throw new AepReadError(DAMAGED);
      const list = fourCC(b, body);
      const kids = list === "btdk" ? NO_CHILDREN : readChildren(b, dv, body + 4, bodyEnd, depth + 1);
      out.push({ type, list, start: body + 4, end: bodyEnd, children: kids });
    } else if (CONTAINERS.has(type)) {
      out.push({ type, list: "", start: body, end: bodyEnd, children: readChildren(b, dv, body, bodyEnd, depth + 1) });
    } else {
      out.push({ type, list: "", start: body, end: bodyEnd, children: NO_CHILDREN });
    }
    p = bodyEnd + (size & 1);
  }
  // A trailing pad byte at the very end of a list is tolerated; anything bigger is damage.
  if (end - p > 1) throw new AepReadError(DAMAGED);
  return out;
}

/** Parse the RIFX root. Throws AepReadError for anything that isn't an .aep. */
export function parseRifx(bytes: Uint8Array): Chunk {
  if (looksLikeAepx(bytes)) throw new AepReadError(AEPX);
  if (bytes.length < 12) throw new AepReadError(NOT_AEP);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (fourCC(bytes, 0) !== "RIFX") throw new AepReadError(NOT_AEP);
  const list = fourCC(bytes, 8);
  if (list !== "Egg!") throw new AepReadError(NOT_AEP);
  const size = dv.getUint32(4, false);
  // The XMP metadata packet follows the RIFX body; a truncated body means a damaged file.
  if (8 + size > bytes.length) throw new AepReadError(DAMAGED);
  return { type: "RIFX", list, start: 12, end: 8 + size, children: readChildren(bytes, dv, 12, 8 + size, 0) };
}

function looksLikeAepx(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 1024));
  return head.includes("<AfterEffectsProject");
}

// ---- tree helpers ------------------------------------------------------------------------------

export const find = (chunks: readonly Chunk[], type: string): Chunk | undefined => chunks.find((c) => c.type === type);
export const findList = (chunks: readonly Chunk[], list: string): Chunk | undefined => chunks.find((c) => c.type === "LIST" && c.list === list);
export const filter = (chunks: readonly Chunk[], type: string): Chunk[] => chunks.filter((c) => c.type === type);
export const filterList = (chunks: readonly Chunk[], list: string): Chunk[] => chunks.filter((c) => c.type === "LIST" && c.list === list);
export const isList = (c: Chunk | undefined, list?: string): boolean => !!c && c.type === "LIST" && (list === undefined || c.list === list);
