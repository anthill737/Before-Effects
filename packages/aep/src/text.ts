/**
 * Text documents: the `LIST:btdk` blob of a Source Text property is a PDF-style "COS" object
 * tree (the format Adobe's text engine uses). Keys are numbers written as names (`/0`, `/1` …).
 *
 * File-format knowledge from py_aep (MIT, © 2023 Fortiche production, https://github.com/forticheprod/py-aep)
 * and aftereffects-aep-parser (MIT, © 2020 Boltframe); the COS layout is also documented by
 * lottie-docs (https://github.com/hunger-zh/lottie-docs/blob/main/docs/aep.md#list-btdk).
 *
 * Layout used here:
 *   root/0/1/0           fonts: entry/0/0/0 is the PostScript name
 *   root/1/1             documents, one per Source Text keyframe:
 *     doc/0/0            text (UTF-16, "\r" between paragraphs and as terminator)
 *     doc/0/5/0[0]/0/0/5 first paragraph style   (0 = justification)
 *     doc/0/6/0[0]/0/0/6 first character style   (0 font index, 1 size, 2/3 faux bold/italic,
 *                        4 auto leading, 5 leading, 8 tracking, 12 caps, 53/54 fill/stroke paint,
 *                        56/57 apply fill/stroke, 63 stroke width)
 *   root/0/8/0[0]/0/1/0  box-text outline (absent for point text)
 */

import type { AeJsonTextDocument } from "@be/core";

export type Cos = number | boolean | string | null | Uint8Array | CosName | Cos[] | { [key: string]: Cos };
export class CosName {
  constructor(readonly name: string) {}
}

const utf8 = new TextDecoder("utf-8");
const utf16be = new TextDecoder("utf-16be");
const utf16le = new TextDecoder("utf-16le");

const enum T {
  Eof,
  Name,
  Num,
  Str,
  Hex,
  Bool,
  Null,
  DictStart,
  DictEnd,
  ArrStart,
  ArrEnd,
  Obj,
  EndObj,
  Ref,
  Stream,
}

interface Tok {
  t: T;
  v?: unknown;
}

const isSpace = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isAlpha = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isHex = (c: number) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

class CosLexer {
  pos: number;
  constructor(
    readonly b: Uint8Array,
    start: number,
    readonly end: number,
  ) {
    this.pos = start;
  }

  next(): Tok {
    const b = this.b;
    let c = -1;
    while (this.pos < this.end) {
      c = b[this.pos++]!;
      if (c === 0x25) {
        // % comment to end of line
        while (this.pos < this.end && b[this.pos] !== 0x0a) this.pos++;
        c = -1;
        continue;
      }
      if (!isSpace(c)) break;
      c = -1;
    }
    if (c === -1) return { t: T.Eof };
    if (c === 0x3c) {
      const d = b[this.pos];
      if (d === 0x3c) {
        this.pos++;
        return { t: T.DictStart };
      }
      return this.hex();
    }
    if (c === 0x3e) {
      if (b[this.pos] === 0x3e) this.pos++;
      return { t: T.DictEnd };
    }
    if (c === 0x5b) return { t: T.ArrStart };
    if (c === 0x5d) return { t: T.ArrEnd };
    if (c === 0x2f) return this.name();
    if (c === 0x28) return this.string();
    if (isAlpha(c)) return this.keyword(c);
    if (isDigit(c) || c === 0x2e || c === 0x2b || c === 0x2d) return this.number(c);
    throw new Error(`Unexpected COS byte ${c}`);
  }

  private name(): Tok {
    const b = this.b;
    let s = "";
    while (this.pos < this.end) {
      const c = b[this.pos]!;
      if (c < 0x21 || c > 0x7e || c === 0x28 || c === 0x29 || c === 0x5b || c === 0x5d || c === 0x3c || c === 0x3e || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25) break;
      this.pos++;
      if (c === 0x23 && this.pos + 1 < this.end) {
        s += String.fromCharCode(parseInt(String.fromCharCode(b[this.pos]!, b[this.pos + 1]!), 16));
        this.pos += 2;
      } else s += String.fromCharCode(c);
    }
    return { t: T.Name, v: s };
  }

  private number(first: number): Tok {
    const b = this.b;
    let s = String.fromCharCode(first);
    let isFloat = first === 0x2e;
    while (this.pos < this.end) {
      const c = b[this.pos]!;
      if (isDigit(c)) s += String.fromCharCode(c);
      else if (c === 0x2e && !isFloat) {
        isFloat = true;
        s += ".";
      } else break;
      this.pos++;
    }
    const v = isFloat ? parseFloat(s) : parseInt(s, 10);
    return { t: T.Num, v: Number.isNaN(v) ? 0 : v };
  }

  private keyword(first: number): Tok {
    const b = this.b;
    let s = String.fromCharCode(first);
    while (this.pos < this.end && isAlpha(b[this.pos]!)) s += String.fromCharCode(b[this.pos++]!);
    switch (s) {
      case "true":
        return { t: T.Bool, v: true };
      case "false":
        return { t: T.Bool, v: false };
      case "null":
        return { t: T.Null, v: null };
      case "obj":
        return { t: T.Obj };
      case "endobj":
        return { t: T.EndObj };
      case "R":
        return { t: T.Ref };
      case "xref":
        return { t: T.Eof };
      case "stream": {
        if (b[this.pos] === 0x0d) this.pos++;
        if (b[this.pos] === 0x0a) this.pos++;
        const start = this.pos;
        const marker = [0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]; // "endstream"
        for (let i = start; i + marker.length <= this.end; i++) {
          let ok = true;
          for (let k = 0; k < marker.length; k++)
            if (b[i + k] !== marker[k]) {
              ok = false;
              break;
            }
          if (ok) {
            this.pos = i + marker.length;
            return { t: T.Stream, v: b.subarray(start, i) };
          }
        }
        throw new Error("Unterminated COS stream");
      }
      default:
        throw new Error(`Unknown COS keyword ${s}`);
    }
  }

  private hex(): Tok {
    const b = this.b;
    let s = "";
    while (this.pos < this.end) {
      const c = b[this.pos++]!;
      if (c === 0x3e) break;
      if (isHex(c)) s += String.fromCharCode(c);
    }
    if (s.length % 2) s += "0";
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return { t: T.Hex, v: out };
  }

  private string(): Tok {
    const b = this.b;
    const bytes: number[] = [];
    while (this.pos < this.end) {
      const c = b[this.pos++]!;
      if (c === 0x29) break;
      if (c === 0x5c) {
        const e = b[this.pos++];
        if (e === undefined) break;
        if (e === 0x6e) bytes.push(0x0a);
        else if (e === 0x72) bytes.push(0x0d);
        else if (e === 0x74) bytes.push(0x09);
        else if (e === 0x62) bytes.push(0x08);
        else if (e === 0x66) bytes.push(0x0c);
        else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let k = 0; k < 2; k++) {
            const d = b[this.pos];
            if (d === undefined || d < 0x30 || d > 0x37) break;
            v = v * 8 + (d - 0x30);
            this.pos++;
          }
          bytes.push(v & 0xff);
        } else bytes.push(e); // \( \) \\ and anything else: the byte itself
      } else {
        // Strings are raw UTF-16, so an unescaped "(" byte is data, not nesting.
        bytes.push(c);
      }
    }
    const raw = Uint8Array.from(bytes);
    let v: string;
    if (raw[0] === 0xfe && raw[1] === 0xff) v = utf16be.decode(raw.subarray(2));
    else if (raw[0] === 0xff && raw[1] === 0xfe) v = utf16le.decode(raw.subarray(2));
    else if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) v = utf8.decode(raw.subarray(3));
    else v = utf8.decode(raw);
    return { t: T.Str, v };
  }
}

class CosParser {
  private look: Tok;
  constructor(private readonly lx: CosLexer) {
    this.look = lx.next();
  }
  private advance(): void {
    this.look = this.lx.next();
  }
  private peek(): T {
    return this.look.t;
  }

  parse(): Cos {
    if (this.look.t === T.Name) return this.dictContent();
    const v = this.value();
    if (this.look.t === T.Eof) return v;
    const rest = this.arrayContent();
    return [v, ...rest];
  }

  private value(): Cos {
    const tok = this.look;
    switch (tok.t) {
      case T.Name:
        this.advance();
        return new CosName(tok.v as string);
      case T.Str:
      case T.Hex:
      case T.Bool:
      case T.Null:
      case T.Stream:
        this.advance();
        return tok.v as Cos;
      case T.Num: {
        this.advance();
        if (this.look.t === T.Num) {
          // `n g obj … endobj` or `n g R`
          const savePos = this.lx.pos;
          const saveLook = this.look;
          this.advance();
          if (this.peek() === T.Obj) {
            this.advance();
            const data = this.value();
            if (this.peek() === T.EndObj) this.advance();
            return data;
          }
          if (this.peek() === T.Ref) {
            this.advance();
            return null;
          }
          this.lx.pos = savePos;
          this.look = saveLook;
        }
        return tok.v as number;
      }
      case T.DictStart: {
        this.advance();
        const d = this.dictContent();
        if (this.peek() !== T.DictEnd) throw new Error("Unterminated COS dictionary");
        this.advance();
        if (this.peek() === T.Stream) this.advance();
        return d;
      }
      case T.ArrStart: {
        this.advance();
        const a = this.arrayContent();
        if (this.peek() !== T.ArrEnd) throw new Error("Unterminated COS array");
        this.advance();
        return a;
      }
      default:
        throw new Error(`Unexpected COS token ${tok.t}`);
    }
  }

  private dictContent(): { [key: string]: Cos } {
    const out: { [key: string]: Cos } = {};
    while (this.look.t !== T.Eof && this.look.t !== T.DictEnd) {
      if (this.look.t !== T.Name) throw new Error("Expected COS key");
      const key = this.look.v as string;
      this.advance();
      out[key] = this.value();
    }
    return out;
  }

  private arrayContent(): Cos[] {
    const out: Cos[] = [];
    while (this.look.t !== T.Eof && this.look.t !== T.ArrEnd) out.push(this.value());
    return out;
  }
}

export function parseCos(bytes: Uint8Array, start = 0, end = bytes.length): Cos {
  return new CosParser(new CosLexer(bytes, start, end)).parse();
}

/** Walk a COS tree by dictionary keys / array indices; undefined when any step is missing. */
export function cosGet(data: Cos | undefined, ...keys: (string | number)[]): Cos | undefined {
  let cur: Cos | undefined = data;
  for (const k of keys) {
    if (cur === undefined || cur === null) return undefined;
    if (Array.isArray(cur)) cur = cur[typeof k === "number" ? k : parseInt(k, 10)];
    else if (typeof cur === "object" && !(cur instanceof Uint8Array) && !(cur instanceof CosName)) cur = (cur as { [key: string]: Cos })[String(k)];
    else return undefined;
  }
  return cur;
}

const num = (v: Cos | undefined): number | undefined => (typeof v === "number" ? v : undefined);
const bool = (v: Cos | undefined): boolean | undefined => (typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : undefined);
const dict = (v: Cos | undefined): { [key: string]: Cos } | undefined =>
  v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array) && !(v instanceof CosName) ? (v as { [key: string]: Cos }) : undefined;

function paint(v: Cos | undefined): number[] | undefined {
  const argb = cosGet(v, "0", "1");
  if (Array.isArray(argb) && argb.length >= 4 && argb.every((x) => typeof x === "number")) return [argb[1] as number, argb[2] as number, argb[3] as number];
  return undefined;
}

/** The text documents (one per Source Text keyframe) stored in a btdk blob. */
export function textDocuments(cos: Cos, mixedStyles?: Set<AeJsonTextDocument>): AeJsonTextDocument[] {
  const fontArray = cosGet(cos, "0", "1", "0");
  const fonts: string[] = Array.isArray(fontArray) ? fontArray.map((e) => String(cosGet(e, "0", "0", "0") ?? "")) : [];
  const docs = cosGet(cos, "1", "1");
  if (!Array.isArray(docs)) return [];

  const frame = dict(cosGet(cos, "0", "8", "0", 0, "0"));
  const outline = frame ? cosGet(frame, "1", "0") : undefined;
  const boxText = !!frame && !!dict(frame["1"]);
  const boxTextSize =
    boxText && Array.isArray(outline) && outline.length >= 14 && typeof outline[0] === "number"
      ? [Math.abs((outline[12] as number) - (outline[0] as number)), Math.abs((outline[13] as number) - (outline[1] as number))]
      : undefined;

  return docs.map((doc) => {
    let text = cosGet(doc, "0", "0");
    let s = typeof text === "string" ? text : "";
    if (s.endsWith("\r")) s = s.slice(0, -1);
    text = s;
    const cs = dict(cosGet(doc, "0", "6", "0", 0, "0", "0", "6"));
    const ps = dict(cosGet(doc, "0", "5", "0", 0, "0", "0", "5"));
    const out: { -readonly [K in keyof AeJsonTextDocument]: AeJsonTextDocument[K] } = { text: s };
    if (cs) {
      const fi = num(cs["0"]);
      if (fi !== undefined && fi >= 0 && fi < fonts.length) out.font = fonts[fi];
      const size = num(cs["1"]);
      if (size !== undefined) out.fontSize = size;
      const fb = bool(cs["2"]);
      if (fb !== undefined) out.fauxBold = fb;
      const fit = bool(cs["3"]);
      if (fit !== undefined) out.fauxItalic = fit;
      const autoLeading = bool(cs["4"]) ?? true;
      const lead = num(cs["5"]);
      if (lead !== undefined) out.leading = autoLeading && size !== undefined ? size * (num(ps?.["7"]) ?? 1.2) : lead;
      const tr = num(cs["8"]);
      if (tr !== undefined) out.tracking = Math.trunc(tr);
      const caps = num(cs["12"]);
      if (caps !== undefined) out.allCaps = caps === 2;
      const fill = paint(cs["53"]);
      if (fill) out.fillColor = fill;
      const stroke = paint(cs["54"]);
      if (stroke) out.strokeColor = stroke;
      const af = bool(cs["56"]);
      if (af !== undefined) out.applyFill = af;
      out.applyStroke = bool(cs["57"]) ?? false;
      out.strokeWidth = num(cs["63"]) ?? 1;
    }
    const j = num(ps?.["0"]);
    if (j !== undefined) {
      // Paragraphs with different alignments report MULTIPLE_JUSTIFICATIONS.
      const runs = cosGet(doc, "0", "5", "0");
      const all = Array.isArray(runs) ? runs.map((r) => num(cosGet(r, "0", "0", "5", "0"))).filter((x): x is number => x !== undefined) : [];
      out.justification = all.some((x) => x !== j) ? 7412 : 7413 + j;
    }
    out.boxText = boxText;
    if (boxTextSize) out.boxTextSize = boxTextSize;
    if (mixedStyles) {
      // Character runs that differ in font, size or colour (the contract holds one style).
      const runs = cosGet(doc, "0", "6", "0");
      const key = (r: Cos) => {
        const st = dict(cosGet(r, "0", "0", "6"));
        return st ? JSON.stringify([st["0"], st["1"], paint(st["53"]), st["56"], paint(st["54"]), st["57"]]) : "";
      };
      if (Array.isArray(runs) && runs.length > 1 && new Set(runs.map(key)).size > 1) mixedStyles.add(out);
    }
    return out;
  });
}
