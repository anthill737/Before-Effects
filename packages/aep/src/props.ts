/**
 * Layer property trees: groups (`LIST:tdgp`), leaf properties (`LIST:tdbs`), keyframes
 * (`lhd3`/`ldat`), and the specialised wrappers for orientation (`otst`), paths (`om-s`), text
 * (`btds`), gradients (`GCst`), markers (`mrst`) and effects (`sspc`).
 *
 * File-format knowledge from py_aep (MIT, © 2023 Fortiche production, https://github.com/forticheprod/py-aep)
 * and aftereffects-aep-parser (MIT, © 2020 Boltframe).
 *
 * Values are converted to what ExtendScript reports: percentages (0–1 in the file, 0–100 in AE),
 * colours (ARGB 0–255 in the file, RGBA 0–1 in AE), layer-normalised points (effect points and
 * the anchor of a layer with a source) and keyframe times (ticks in the layer's own time in the
 * file, seconds of composition time in AE). Keyframe ease is reported the way AE's scripting
 * reports it, which derives some speeds instead of returning the stored ones (linear and hold
 * sides, auto-Bezier keys, the outer sides of the first and last key).
 */

import type { AeJsonKeyframe, AeJsonMarker, AeJsonProperty, AeJsonShape, AeJsonTextDocument } from "@be/core";
import { Bin } from "./bin.ts";
import { CT, type ParamDef, readParamDefs } from "./effects.ts";
import { type Chunk, filter, filterList, find, findList } from "./riff.ts";
import { readShap } from "./shape.ts";
import { type ChildSpec, GROUP_CHILDREN, MATCH_NAME_DISPLAY, MESH_TOP_LEVEL, NAME_OVERRIDES, TOP_LEVEL, TOP_LEVEL_SKIP, TRANSFORM_CHILDREN } from "./tables.generated.ts";
import { parseCos, textDocuments } from "./text.ts";

type Mut<T> = { -readonly [K in keyof T]: T[K] };
export type Prop = Mut<Omit<AeJsonProperty, "properties" | "keyframes">> & { properties?: Prop[]; keyframes?: AeJsonKeyframe[] };

/** PropertyValueType values. */
export const PVT = {
  NO_VALUE: 6412,
  ThreeD_SPATIAL: 6413,
  ThreeD: 6414,
  TwoD_SPATIAL: 6415,
  TwoD: 6416,
  OneD: 6417,
  COLOR: 6418,
  CUSTOM_VALUE: 6419,
  MARKER: 6420,
  LAYER_INDEX: 6421,
  MASK_INDEX: 6422,
  SHAPE: 6423,
  TEXT_DOCUMENT: 6424,
} as const;

const SENTINEL_NAME = "-_0_/-";
/** Value types AE reports that neither the file flags nor py_aep's default tables give. */
const PVT_FIX: Readonly<Record<string, number>> = {
  "ADBE Text Path": 6422,
  "ADBE Layer Source Alternate": 6412,
  "ADBE Vector Grad Colors": 6412,
  "ADBE FreePin3 Outlines": 6412,
};
const DEFAULT_INFLUENCE = 100 / 6;
const PERCENT = new Set(["ADBE Opacity", "ADBE Scale", "ADBE Mask Opacity"]);
const INDEXED_GROUPS = new Set(["ADBE Effect Parade", "ADBE Mask Parade", "ADBE Effect Mask Parade", "ADBE Text Animators", "ADBE Text Selectors", "ADBE Root Vectors Group", "ADBE Vectors Group"]);
const FOLLOWERS = ["ADBE Position_0", "ADBE Position_1", "ADBE Position_2"];
/** Sub-groups strokes gained in later AE versions; older files lack them but AE reports them. */
const STROKE_GROUPS = ["ADBE Vector Stroke Dashes", "ADBE Vector Stroke Taper", "ADBE Vector Stroke Wave"];
const TRAILING_GROUPS: Readonly<Record<string, readonly string[]>> = {
  "ADBE Vector Graphic - Stroke": STROKE_GROUPS,
  "ADBE Vector Graphic - G-Stroke": STROKE_GROUPS,
  "ADBE FreePin3 ARAP Group": ["ADBE FreePin3 Mesh Group"],
};
const TRAILING_NAMES: Readonly<Record<string, string>> = { "ADBE FreePin3 Mesh Group": "Mesh" };
/** Properties whose file flag disagrees with what AE reports for isSpatial (from py_aep). */
const SPATIAL_OVERRIDE = new Set([
  "ADBE Orientation",
  "ADBE Fill-0002",
  "ADBE Mask Shape",
  "ADBE Vector Shape",
  "ADBE Shadow Color",
  "ADBE Vector Fill Color",
  "ADBE Text Fill Color",
  "ADBE Text Stroke Color",
]);

export interface CompScope {
  /** Keyframe ticks per second at 100% stretch (cdta internal timebase). */
  readonly timebase: number;
  readonly width: number;
  readonly height: number;
  readonly pixelAspect: number;
  /** Layer id → 1-based index. */
  readonly idToIndex: ReadonlyMap<number, number>;
}

export interface LayerScope {
  readonly comp: CompScope;
  readonly startTime: number;
  /** Percent; 100 = normal speed. */
  readonly stretch: number;
  /** Source pixel size when the layer has a source with pixels (the anchor is stored normalised to it). */
  readonly sourceSize: readonly [number, number] | null;
  /** The layer's pixel size: its source's, else the composition's (effect points and masks are normalised to it). */
  readonly size: readonly [number, number];
  readonly is3D: boolean;
  readonly nullLayer: boolean;
  readonly kind: "av" | "text" | "shape" | "camera" | "light" | "model" | "mesh" | "other";
  readonly hasSource: boolean;
  /** "Comp › Layer" for notes. */
  readonly where: string;
}

export interface Scope {
  readonly bin: Bin;
  readonly aeMajor: number;
  readonly effectDefs: Map<string, ParamDef[]>;
  note(text: string): void;
}

// ---- raw keyframes -----------------------------------------------------------------------------

const enum K {
  Unknown,
  Color,
  Spatial3,
  Multi3,
  Spatial2,
  Multi2,
  One,
  NoValue,
  Orientation,
  Marker,
}

interface RawKey {
  readonly units: number;
  readonly inI: number;
  readonly outI: number;
  readonly flags: number;
  readonly kind: K;
  readonly value: number[] | null;
  readonly inSpeed: number[];
  readonly inInfl: number[];
  readonly outSpeed: number[];
  readonly outInfl: number[];
  readonly spatialFlags: number;
  readonly inTan: number[] | null;
  readonly outTan: number[] | null;
}

function keyKind(rawType: number, size: number, spatial: boolean): K {
  if (rawType !== 4) return K.Unknown;
  switch (size) {
    case 152:
      return K.Color;
    case 128:
      return spatial ? K.Spatial3 : K.Multi3;
    case 104:
      return K.Spatial2;
    case 88:
      return K.Multi2;
    case 80:
      return K.Orientation;
    case 64:
      return K.NoValue;
    case 48:
      return K.One;
    case 16:
      return K.Marker;
    default:
      return K.Unknown;
  }
}

function readRawKeys(bin: Bin, list: Chunk, tdb4Spatial: boolean): { keys: RawKey[]; unknown: boolean } {
  const lhd3 = find(list.children, "lhd3");
  const ldat = find(list.children, "ldat");
  if (!lhd3 || !ldat) return { keys: [], unknown: false };
  const count = bin.cu16(lhd3, 10);
  const size = bin.cu16(lhd3, 18);
  const rawType = bin.cu8(lhd3, 23);
  if (count === 0 || size === 0) return { keys: [], unknown: false };
  const kind = keyKind(rawType, size, tdb4Spatial);
  if (kind === K.Unknown) return { keys: [], unknown: true };
  const keys: RawKey[] = [];
  for (let i = 0; i < count; i++) {
    const o = ldat.start + i * size;
    if (o + size > ldat.end) break;
    const units = bin.s32(o);
    const inI = bin.u8(o + 4);
    const outI = bin.u8(o + 5);
    const flags = bin.u8(o + 7);
    const p = o + 8;
    const d = (k: number) => bin.f64(p + k * 8);
    let value: number[] | null = null;
    let inSpeed: number[] = [];
    let inInfl: number[] = [];
    let outSpeed: number[] = [];
    let outInfl: number[] = [];
    let spatialFlags = 0;
    let inTan: number[] | null = null;
    let outTan: number[] | null = null;
    switch (kind) {
      case K.Color:
        inSpeed = [d(2)];
        inInfl = [d(3)];
        outSpeed = [d(4)];
        outInfl = [d(5)];
        value = [d(6), d(7), d(8), d(9)];
        break;
      case K.NoValue:
      case K.Orientation:
        inSpeed = [d(2)];
        inInfl = [d(3)];
        outSpeed = [d(4)];
        outInfl = [d(5)];
        break;
      case K.Spatial2:
      case K.Spatial3: {
        const n = kind === K.Spatial2 ? 2 : 3;
        spatialFlags = bin.u8(p + 3);
        const q = (k: number) => bin.f64(p + 8 + k * 8);
        inSpeed = [q(1)];
        inInfl = [q(2)];
        outSpeed = [q(3)];
        outInfl = [q(4)];
        value = [];
        inTan = [];
        outTan = [];
        for (let j = 0; j < n; j++) {
          value.push(q(5 + j));
          inTan.push(q(5 + n + j));
          outTan.push(q(5 + 2 * n + j));
        }
        break;
      }
      case K.Multi2:
      case K.Multi3:
      case K.One: {
        const n = kind === K.One ? 1 : kind === K.Multi2 ? 2 : 3;
        value = [];
        for (let j = 0; j < n; j++) {
          value.push(d(j));
          inSpeed.push(d(n + j));
          inInfl.push(d(2 * n + j));
          outSpeed.push(d(3 * n + j));
          outInfl.push(d(4 * n + j));
        }
        break;
      }
      default:
        break;
    }
    keys.push({ units, inI, outI, flags, kind, value, inSpeed, inInfl, outSpeed, outInfl, spatialFlags, inTan, outTan });
  }
  return { keys, unknown: false };
}

// ---- value conversion --------------------------------------------------------------------------

interface ValueMode {
  readonly dims: number;
  readonly color: boolean;
  readonly percent: boolean;
  /** Per-component multiplier (normalised effect points / anchor). */
  readonly scale: readonly number[] | null;
  /** 2D layer: AE reports Scale Z as 100 whatever the file holds. */
  readonly scaleZ100: boolean;
}

function resolve(raw: readonly number[], m: ValueMode): number | number[] {
  let v = raw.slice(0, m.color ? 4 : Math.max(1, m.dims));
  if (m.percent) {
    v = v.map((x) => x * 100);
    if (m.scaleZ100 && v.length >= 3) v[2] = 100;
  }
  if (m.color && v.length === 4) {
    const [a, r, g, b] = v as [number, number, number, number];
    v = [r / 255, g / 255, b / 255, a / 255];
  }
  if (m.scale && v.length >= 2) v = v.map((x, i) => (m.scale![i] !== undefined ? x * m.scale![i]! : x));
  return v.length === 1 && !m.color && m.dims <= 1 ? v[0]! : v;
}

const scaleVec = (v: readonly number[], scale: readonly number[] | null): number[] => (scale ? v.map((x, i) => (scale[i] !== undefined ? x * scale[i]! : x)) : [...v]);

// ---- ExtendScript keyframe semantics -----------------------------------------------------------

type KeyValue = number | number[] | AeJsonShape | AeJsonTextDocument | null;

interface KeyContext {
  readonly layer: LayerScope;
  /** Multiplier from stored ease speed to reported speed (100 for percent properties, layer height for effect points). */
  readonly speedFactor: number;
  /** Spatial interpolation along a motion path (reported spatial, not a colour). */
  readonly motionPath: boolean;
  /** Colour: a linear side's speed is the RGBA distance in 0–255 units per second. */
  readonly color?: boolean;
  /** Orientation: AE reports zero spatial tangents for its keys. */
  readonly zeroSpatial?: boolean;
  /** AE reports a linear side's speed as 1 for paths and orientation (no scalar magnitude). */
  readonly linearSpeedOne: boolean;
  readonly scale: readonly number[] | null;
}

function layerTimebase(layer: LayerScope): number {
  const s = Math.abs(layer.stretch || 100) / 100;
  return Math.floor(layer.comp.timebase * Math.max(1, s)) || 1;
}

const asVector = (v: KeyValue): number[] | null => (typeof v === "number" ? [v] : Array.isArray(v) && v.every((x) => typeof x === "number") ? (v as number[]) : null);

function buildKeyframes(raw: readonly RawKey[], values: readonly KeyValue[], kc: KeyContext): AeJsonKeyframe[] {
  const layer = kc.layer;
  const tb = layerTimebase(layer);
  const stretch = layer.stretch ? layer.stretch / 100 : 1;
  const offset = stretch >= 0 ? layer.startTime : layer.startTime - Math.abs(stretch) / 3000;
  const layerTime = (i: number) => raw[i]!.units / tb;
  const n = raw.length;

  const segmentSpeed = (a: number, b: number): number[] => {
    const dt = layerTime(b) - layerTime(a);
    if (dt === 0) return [0];
    const va = values[a];
    const vb = values[b];
    if (typeof va === "number" && typeof vb === "number") return [(vb - va) / dt];
    const la = asVector(va ?? null);
    const lb = asVector(vb ?? null);
    if (!la || !lb || typeof va === "number" || typeof vb === "number") return [0];
    if (kc.color) {
      let s = 0;
      for (let i = 0; i < Math.min(la.length, lb.length); i++) s += (lb[i]! - la[i]!) ** 2;
      return [(Math.sqrt(s) * 255) / dt];
    }
    if (kc.motionPath) {
      let s = 0;
      for (let i = 0; i < Math.min(la.length, lb.length); i++) s += (lb[i]! - la[i]!) ** 2;
      return [Math.sqrt(s) / dt];
    }
    const out: number[] = [];
    for (let i = 0; i < Math.min(la.length, lb.length); i++) out.push((lb[i]! - la[i]!) / dt);
    return out;
  };

  const autoTemporal = (i: number): [number[], number[]] | null => {
    const idx: number[] = [];
    if (i > 0) idx.push(i - 1);
    idx.push(i);
    if (i < n - 1) idx.push(i + 1);
    const vecs = idx.map((k) => asVector(values[k] ?? null));
    if (vecs.some((v) => v === null)) return null;
    const vs = vecs as number[][];
    const ts = idx.map(layerTime);
    const at = i > 0 ? 1 : 0;
    const dim = vs[at]!.length;
    const zero = new Array<number>(dim).fill(0);
    if (vs.length < 2) return [zero, [...zero]];
    const slope = (lo: number, hi: number) => {
      const span = ts[hi]! - ts[lo]!;
      if (span <= 0) return new Array<number>(dim).fill(0);
      return vs[at]!.map((_, d) => (vs[hi]![d]! - vs[lo]![d]!) / span);
    };
    if (at === 0) return [zero, slope(0, 1)];
    if (at === vs.length - 1) return [slope(at - 1, at), zero];
    const through = slope(at - 1, at + 1);
    return [through, [...through]];
  };

  const ease = (i: number, dir: "in" | "out"): { speed: number; influence: number }[] => {
    const k = raw[i]!;
    const rawSpeed = dir === "in" ? k.inSpeed : k.outSpeed;
    const rawInfl = dir === "in" ? k.inInfl : k.outInfl;
    if (rawSpeed.length === 0) return [{ speed: 0, influence: 0 }];
    const fill = (speed: number) => rawSpeed.map(() => ({ speed, influence: DEFAULT_INFLUENCE }));
    if (k.flags & 0x10) {
      const auto = autoTemporal(i);
      if (auto) {
        const chosen = dir === "in" ? auto[0] : auto[1];
        if (chosen.length === rawSpeed.length) return chosen.map((speed) => ({ speed, influence: DEFAULT_INFLUENCE }));
      }
    }
    const interp = dir === "in" ? k.inI : k.outI;
    if (interp === 1) {
      const other = dir === "out" ? i + 1 : i - 1;
      if (other < 0 || other >= n) return fill(0);
      const adj = dir === "out" ? raw[other]!.inI : raw[other]!.outI;
      if (adj === 3) return fill(0);
      if (kc.linearSpeedOne) return fill(1);
      const speeds = dir === "out" ? segmentSpeed(i, other) : segmentSpeed(other, i);
      return speeds.map((speed) => ({ speed, influence: DEFAULT_INFLUENCE }));
    }
    if (interp === 3) return fill(0);
    if ((dir === "in" && i === 0) || (dir === "out" && i === n - 1)) return rawInfl.map((inf) => ({ speed: 0, influence: inf * 100 }));
    return rawSpeed.map((s, d) => ({ speed: s * kc.speedFactor, influence: (rawInfl[d] ?? 0) * 100 }));
  };

  const out: AeJsonKeyframe[] = [];
  for (let i = 0; i < n; i++) {
    const k = raw[i]!;
    const kf: Mut<AeJsonKeyframe> = {
      time: layerTime(i) * stretch + offset,
      value: values[i] ?? null,
      inInterpolationType: 6611 + (k.inI || 1),
      outInterpolationType: 6611 + (k.outI || 1),
      inTemporalEase: ease(i, "in"),
      outTemporalEase: ease(i, "out"),
      temporalAutoBezier: (k.flags & 0x10) !== 0,
      temporalContinuous: (k.flags & 0x18) !== 0,
    };
    if (kc.zeroSpatial) {
      kf.inSpatialTangent = [0, 0, 0];
      kf.outSpatialTangent = [0, 0, 0];
      kf.spatialAutoBezier = false;
      kf.spatialContinuous = false;
      kf.roving = false;
    }
    if (k.inTan && k.outTan && k.value) {
      const autoSpatial = (k.spatialFlags & 0x02) !== 0;
      let inTan = k.inTan;
      let outTan = k.outTan;
      if (autoSpatial) {
        const low = (i > 0 ? raw[i - 1]!.value : null) ?? k.value;
        const high = (i < n - 1 ? raw[i + 1]!.value : null) ?? k.value;
        if (n < 2) {
          outTan = k.value.map(() => 0);
          inTan = k.value.map(() => 0);
        } else {
          outTan = k.value.map((_, d) => ((high[d] ?? 0) - (low[d] ?? 0)) / 6);
          inTan = outTan.map((x) => -x);
        }
      }
      kf.inSpatialTangent = scaleVec(inTan, kc.scale);
      kf.outSpatialTangent = scaleVec(outTan, kc.scale);
      kf.spatialAutoBezier = autoSpatial;
      kf.spatialContinuous = (k.spatialFlags & 0x01) !== 0;
      kf.roving = (k.flags & 0x20) !== 0;
    }
    out.push(kf);
  }
  return out;
}

// ---- property-tree reader ----------------------------------------------------------------------

interface Entry {
  readonly matchName: string;
  readonly chunks: Chunk[];
}

/** Split a group body into (match name, payload chunks) entries, dropping group-end markers. */
function entries(bin: Bin, group: Chunk): Entry[] {
  const out: Entry[] = [];
  let cur: Entry | null = null;
  for (const c of group.children) {
    if (c.type === "tdmn") {
      const mn = bin.text(c);
      if (mn === "ADBE Group End") {
        cur = null;
        continue;
      }
      cur = { matchName: mn, chunks: [] };
      out.push(cur);
    } else if (cur && c.type !== "engv" && c.type !== "aRbs") cur.chunks.push(c);
  }
  return out;
}

const firstList = (chunks: readonly Chunk[]): Chunk | undefined => chunks.find((c) => c.type === "LIST");

interface EffectContext {
  readonly defs: ReadonlyMap<string, ParamDef>;
}

export class PropertyReader {
  /** Markers found while reading (`ADBE Marker`), in layer/comp `markers` form. */
  markers: AeJsonMarker[] | undefined;
  /** Time Remap is switched on (its tdb4 says animated). */
  private timeRemapFlag = false;
  /** Nodes made from defaults rather than read from the file. */
  private readonly synthesized = new WeakSet<Prop>();

  constructor(
    readonly scope: Scope,
    readonly layer: LayerScope,
  ) {}

  private get bin(): Bin {
    return this.scope.bin;
  }

  private storedName(container: Chunk): string | undefined {
    const tdsn = find(container.children, "tdsn");
    if (!tdsn) return undefined;
    const s = this.bin.text(find(tdsn.children, "Utf8"));
    return s && s !== SENTINEL_NAME ? s : undefined;
  }

  private displayName(mn: string): string | undefined {
    return NAME_OVERRIDES[mn] ?? MATCH_NAME_DISPLAY[mn];
  }

  /** Top-level properties of a layer (`LIST:tdgp` under `LIST:Layr`). */
  readLayer(root: Chunk): { properties: Prop[]; markers: AeJsonMarker[]; timeRemapEnabled: boolean } {
    // Markers are reported as `layer.markers`, not as a property (like the exporter script does).
    const props = this.readChildren(root, "", null).filter((p) => p.matchName !== "ADBE Marker");
    let timeRemapEnabled = false;
    for (const p of props) {
      if (p.matchName === "ADBE Transform Group") this.completeTransform(p);
      if (p.matchName === "ADBE Time Remapping") timeRemapEnabled = (p.keyframes?.length ?? 0) > 0 || this.timeRemapFlag;
    }
    const kind = this.layer.kind;
    if (kind === "other") return { properties: props, markers: this.markers ?? [], timeRemapEnabled };
    // AE always reports a fixed set of top-level groups per kind of layer, in a fixed order; the
    // file only stores the ones with content.
    const specs = kind === "mesh" ? MESH_TOP_LEVEL : TOP_LEVEL;
    const skip = new Set(TOP_LEVEL_SKIP[kind === "model" ? "av" : kind] ?? []);
    if (kind === "model") skip.add("ADBE Data Group");
    const byMn = new Map<string, Prop[]>();
    for (const p of props) byMn.set(p.matchName, [...(byMn.get(p.matchName) ?? []), p]);
    const out: Prop[] = [];
    const used = new Set<Prop>();
    for (const s of specs) {
      const have = byMn.get(s.m);
      if (have) {
        for (const h of have) {
          if (!h.name) h.name = s.n;
          out.push(h);
          used.add(h);
        }
        continue;
      }
      if (skip.has(s.m) || (s.mm !== undefined && s.mm > this.scope.aeMajor)) continue;
      if (s.m === "ADBE Time Remapping" || s.m === "ADBE Transform Group" || s.m === "ADBE Marker") continue;
      out.push(this.synthesize(s));
    }
    for (const p of props) if (!used.has(p)) out.push(p);
    return { properties: out, markers: this.markers ?? [], timeRemapEnabled };
  }

  readChildren(group: Chunk, parentMn: string, fx: EffectContext | null): Prop[] {
    const out: Prop[] = [];
    let maskCount = 0;
    for (const e of entries(this.bin, group)) {
      if (fx && e.matchName.endsWith("-0000")) continue;
      const list = firstList(e.chunks);
      if (!list) {
        const bare: Prop = { matchName: e.matchName, propertyType: "Property" };
        const name = this.displayName(e.matchName);
        if (name !== undefined) bare.name = name;
        const pvt = PVT_FIX[e.matchName];
        if (pvt !== undefined) bare.propertyValueType = pvt;
        out.push(bare);
        continue;
      }
      switch (list.list) {
        case "tdgp": {
          if (e.matchName === "ADBE Mask Atom") {
            const mkifs = filter(e.chunks, "mkif");
            const tdgps = filterList(e.chunks, "tdgp");
            tdgps.forEach((t, i) => out.push(this.readMask(t, mkifs[i], ++maskCount)));
          } else {
            for (const t of filterList(e.chunks, "tdgp")) out.push(this.readGroup(e.matchName, t, fx));
          }
          break;
        }
        case "tdbs":
          out.push(this.readLeaf(e.matchName, list, fx, parentMn));
          break;
        case "otst":
          out.push(this.readOrientation(e.matchName, list));
          break;
        case "om-s":
          out.push(this.readPath(e.matchName, list));
          break;
        case "btds":
          out.push(this.readText(e.matchName, list));
          break;
        case "GCst":
          out.push(this.readGradient(e.matchName, list));
          break;
        case "mrst":
          out.push(this.readMarkers(e.matchName, list));
          break;
        case "sspc":
          for (const s of filterList(e.chunks, "sspc")) out.push(this.readEffect(e.matchName, s));
          break;
        case "OvG2": {
          const t = findList(e.chunks, "tdgp");
          if (t) out.push(this.readGroup(e.matchName, t, fx));
          else out.push({ matchName: e.matchName, propertyType: "NamedGroup", properties: [] });
          break;
        }
        default:
          out.push({ matchName: e.matchName });
          this.scope.note(`A property (${e.matchName}) on layer ${this.layer.where} wasn't read.`);
      }
    }
    return out;
  }

  private groupBase(mn: string, tdgp: Chunk): Prop {
    const tdsb = find(tdgp.children, "tdsb");
    const name = this.storedName(tdgp) ?? this.displayName(mn);
    const g: Prop = { matchName: mn };
    if (name !== undefined) g.name = name;
    g.propertyType = INDEXED_GROUPS.has(mn) ? "IndexedGroup" : "NamedGroup";
    g.enabled = tdsb ? (this.bin.cu8(tdsb, 3) & 1) === 1 : true;
    return g;
  }

  private readGroup(mn: string, tdgp: Chunk, fx: EffectContext | null): Prop {
    const g = this.groupBase(mn, tdgp);
    const kids = this.readChildren(tdgp, mn, fx);
    g.properties = this.fillDefaults(mn, kids);
    if (mn === "ADBE Layer Styles") {
      // AE reports Layer Styles (and its Blending Options) as enabled only when a style is on.
      const any = kids.some((k) => k.matchName !== "ADBE Blend Options Group" && k.propertyType !== "Property" && k.enabled === true);
      g.enabled = any;
      for (const k of kids) if (k.matchName === "ADBE Blend Options Group") k.enabled = any;
    }
    if (mn === "ADBE Camera Options Group") {
      // Untouched zoom and focus distance default to a 50 mm lens for the comp's width.
      const zoom = Math.round(((this.layer.comp.width * this.layer.comp.pixelAspect) / 0.72) * 1e8) / 1e8;
      for (const k of g.properties) {
        if ((k.matchName === "ADBE Camera Zoom" || k.matchName === "ADBE Camera Focus Distance") && this.synthesized.has(k)) k.value = zoom;
      }
    }
    return g;
  }

  private readMask(tdgp: Chunk, mkif: Chunk | undefined, n: number): Prop {
    const g = this.groupBase("ADBE Mask Atom", tdgp);
    g.name = this.storedName(tdgp) ?? `Mask ${n}`;
    if (mkif) {
      g.maskMode = 6812 + this.bin.cu16(mkif, 6);
      g.inverted = this.bin.cu8(mkif, 0) !== 0;
    }
    // RotoBezier masks: AE computes the handles itself and the file keeps them at zero.
    const shapeEntry = entries(this.bin, tdgp).find((e) => e.matchName === "ADBE Mask Shape");
    const oms = shapeEntry ? findList(shapeEntry.chunks, "om-s") : undefined;
    const msTdbs = oms ? findList(oms.children, "tdbs") : undefined;
    const msTdsb = msTdbs ? find(msTdbs.children, "tdsb") : undefined;
    if (msTdsb && this.bin.cu8(msTdsb, 0) !== 0) this.scope.note(`Mask “${g.name}” on layer ${this.layer.where} uses RotoBezier; its curves are imported as straight segments.`);
    g.properties = this.fillDefaults("ADBE Mask Atom", this.readChildren(tdgp, "ADBE Mask Atom", null));
    const shape = g.properties.find((p) => p.matchName === "ADBE Mask Shape");
    if (shape && this.synthesized.has(shape)) {
      // A mask whose path was never edited covers the whole layer.
      const [w, h] = this.layer.size;
      shape.propertyValueType = PVT.SHAPE;
      shape.value = { closed: true, vertices: [[0, 0], [0, h], [w, h], [w, 0]], inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]], outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]] };
    }
    return g;
  }

  /** Fill in the children AE reports but doesn't store (untouched defaults), in AE's order. */
  private fillDefaults(mn: string, kids: Prop[]): Prop[] {
    const specs = GROUP_CHILDREN[mn];
    if (!specs) return this.addTrailing(mn, kids);
    const byMn = new Map<string, Prop>();
    for (const k of kids) if (!byMn.has(k.matchName)) byMn.set(k.matchName, k);
    const used = new Set<Prop>();
    const out: Prop[] = [];
    for (const s of specs) {
      const have = byMn.get(s.m);
      if (have) {
        if (have.name === undefined || have.name === this.displayName(s.m)) have.name = s.n;
        out.push(have);
        used.add(have);
        // Same-named siblings (e.g. several dashes) stay together.
        for (const k of kids) if (k !== have && k.matchName === s.m && !used.has(k)) (out.push(k), used.add(k));
        continue;
      }
      if (s.mm !== undefined && s.mm > this.scope.aeMajor) continue;
      out.push(this.synthesize(s));
    }
    for (const k of kids) if (!used.has(k)) out.push(k);
    return this.addTrailing(mn, out);
  }

  private addTrailing(mn: string, out: Prop[]): Prop[] {
    for (const m of TRAILING_GROUPS[mn] ?? []) {
      if (!out.some((p) => p.matchName === m)) out.push(this.synthesize({ m, n: TRAILING_NAMES[m] ?? this.displayName(m) ?? m, g: 1 }));
    }
    return out;
  }

  private synthesize(s: ChildSpec): Prop {
    if (s.g) {
      const g: Prop = { matchName: s.m, name: s.n, propertyType: INDEXED_GROUPS.has(s.m) ? "IndexedGroup" : "NamedGroup", enabled: s.m !== "ADBE Layer Styles", properties: [] };
      g.properties = this.fillDefaults(s.m, []);
      this.synthesized.add(g);
      return g;
    }
    const p: Prop = { matchName: s.m, name: s.n, propertyType: "Property" };
    this.synthesized.add(p);
    if (s.t !== undefined) p.propertyValueType = PVT_FIX[s.m] ?? s.t;
    if (s.v !== undefined) p.value = Array.isArray(s.v) ? [...s.v] : s.v;
    if (s.m === "ADBE Position") p.dimensionsSeparated = false;
    if (FOLLOWERS.includes(s.m)) p.isSeparationFollower = true;
    return p;
  }

  // ---- leaf ----

  private tdb4Info(tdb4: Chunk | undefined) {
    const b = this.bin;
    if (!tdb4) return { dims: 1, spatialRaw: false, noValue: false, vector: false, integer: false, color: false, animated: false, exprDisabled: false };
    const type = b.cu8(tdb4, 59);
    return {
      dims: b.cu16(tdb4, 2, 1),
      spatialRaw: (b.cu8(tdb4, 5) & 0x08) !== 0,
      noValue: (b.cu8(tdb4, 57) & 0x01) !== 0,
      vector: (type & 0x08) !== 0,
      integer: (type & 0x04) !== 0,
      color: (type & 0x01) !== 0,
      animated: b.cu8(tdb4, 68) !== 0,
      exprDisabled: (b.cu8(tdb4, 119) & 0x01) !== 0,
    };
  }

  private readLeaf(mn: string, tdbs: Chunk, fx: EffectContext | null, parentMn: string): Prop {
    const b = this.bin;
    const kids = tdbs.children;
    const t = this.tdb4Info(find(kids, "tdb4"));
    // Effect parameters outside their effect (Essential Properties overrides) still follow its definition.
    const def = fx?.defs.get(mn) ?? this.effectParamDef(mn);
    const spec = GROUP_CHILDREN[parentMn]?.find((s) => s.m === mn);
    const color = spec && !spec.g ? spec.c === 1 : def ? def.controlType === CT.COLOR : t.color;
    const spatial = SPATIAL_OVERRIDE.has(mn) || color || t.spatialRaw;

    // Value type, as ExtendScript reports it.
    let pvt = 0;
    let control: "two" | "three" | "other" = "other";
    if (t.noValue) pvt = PVT.NO_VALUE;
    if (color) pvt = PVT.COLOR;
    else if (t.integer && t.dims <= 1) pvt = PVT.OneD;
    else if (t.vector || (t.integer && t.dims > 1)) {
      if (t.dims === 1) pvt = PVT.OneD;
      else if (t.dims === 2) {
        pvt = spatial ? PVT.TwoD_SPATIAL : PVT.TwoD;
        control = "two";
      } else if (t.dims === 3) {
        pvt = spatial ? PVT.ThreeD_SPATIAL : PVT.ThreeD;
        control = "three";
      }
    } else if (t.dims === 1) pvt = PVT.OneD;
    if (def) {
      switch (def.controlType) {
        case CT.ANGLE:
          pvt = PVT.OneD;
          break;
        case CT.COLOR:
          pvt = PVT.COLOR;
          break;
        case CT.TWO_D:
          pvt = PVT.TwoD_SPATIAL;
          control = "two";
          break;
        case CT.THREE_D:
          pvt = PVT.ThreeD_SPATIAL;
          control = "three";
          break;
        case CT.LAYER:
          pvt = PVT.LAYER_INDEX;
          control = "other";
          break;
        case CT.MASK:
          pvt = PVT.MASK_INDEX;
          control = "other";
          break;
        case CT.CURVE:
          pvt = PVT.CUSTOM_VALUE;
          break;
        case CT.GROUP:
        case CT.GROUP_END:
        case CT.BUTTON:
        case CT.PAINT_GROUP:
          pvt = PVT.NO_VALUE;
          break;
        default:
          break;
      }
    }
    const tdpi = find(kids, "tdpi");
    const tdli = find(kids, "tdli");
    if (tdpi) pvt = PVT.LAYER_INDEX;
    if (tdli) pvt = PVT.MASK_INDEX;
    pvt = PVT_FIX[mn] ?? pvt;

    // Normalisation the file applies to this value.
    let scale: number[] | null = null;
    let speedFactor = PERCENT.has(mn) ? 100 : 1;
    if (mn === "ADBE Anchor Point") {
      if (this.layer.sourceSize) scale = [this.layer.sourceSize[0], this.layer.sourceSize[1], 1];
    } else if ((fx || def) && control !== "other" && !color) {
      const [w, h] = this.layer.size;
      if (w && h) {
        scale = control === "three" ? [w, h, h] : [w, h];
        speedFactor = h;
      }
    }
    const vfAxis = mn.startsWith("ADBE Text VF Axis");
    const mode: ValueMode = {
      dims: vfAxis ? 1 : t.dims,
      color,
      percent: PERCENT.has(mn),
      scale,
      scaleZ100: mn === "ADBE Scale" && !this.layer.is3D,
    };

    const p: Prop = { matchName: mn };
    const name = this.leafName(mn, tdbs, def);
    if (name !== undefined) p.name = name;
    p.propertyType = "Property";
    if (pvt) p.propertyValueType = pvt;

    const list = findList(kids, "list");
    const { keys, unknown } = list ? readRawKeys(b, list, t.spatialRaw) : { keys: [], unknown: false };
    if (unknown) this.scope.note(`Keyframes of “${name ?? mn}” on layer ${this.layer.where} weren't read.`);
    if (mn === "ADBE Time Remapping" && t.animated) this.timeRemapFlag = true;

    if (keys.length > 0) {
      const values = keys.map((k) => (k.value ? resolve(k.value, mode) : null));
      p.keyframes = buildKeyframes(keys, values, {
        layer: this.layer,
        speedFactor,
        motionPath: spatial && !color,
        color,
        linearSpeedOne: false,
        scale,
      });
    } else if (tdpi) {
      const id = b.cs32(tdpi, 0);
      p.value = id === 0 ? 0 : (this.layer.comp.idToIndex.get(id) ?? 0);
    } else if (tdli) {
      p.value = b.cs32(tdli, 0);
    } else if (pvt !== PVT.NO_VALUE && pvt !== PVT.CUSTOM_VALUE) {
      const cdat = find(kids, "cdat");
      if (cdat) {
        const vals = b.doubles(cdat);
        if (vals.length > 0) p.value = resolve(vals, mode);
      }
    }
    if (mn === "ADBE Opacity" && this.layer.nullLayer && p.value === 100) p.value = 0;

    this.readExpression(p, tdbs);
    if (mn === "ADBE Position") {
      const tdsb = find(kids, "tdsb");
      p.dimensionsSeparated = tdsb ? (b.cu8(tdsb, 2) & 0x08) !== 0 : false;
    }
    if (FOLLOWERS.includes(mn)) p.isSeparationFollower = true;
    return p;
  }

  /** The definition of an effect parameter (`<effect match name>-NNNN`) from the project's effect list. */
  private effectParamDef(mn: string): ParamDef | undefined {
    const m = /^(.+)-\d{4}$/.exec(mn);
    return m ? this.scope.effectDefs.get(m[1]!)?.find((d) => d.matchName === mn) : undefined;
  }

  private leafName(mn: string, container: Chunk, def: ParamDef | undefined): string | undefined {
    const forced = NAME_OVERRIDES[mn];
    if (forced !== undefined) return forced;
    const stored = this.storedName(container);
    if (def) return stored ?? (def.controlType === CT.BUTTON ? "" : def.name || MATCH_NAME_DISPLAY[mn] || "");
    return stored ?? this.displayName(mn);
  }

  /** The expression of a property (a Utf8 directly inside its tdbs) and whether it's switched on. */
  private readExpression(p: Prop, tdbs: Chunk): void {
    const expr = find(tdbs.children, "Utf8");
    const src = expr ? this.bin.text(expr) : "";
    if (!src) return;
    p.expression = src;
    p.expressionEnabled = !this.tdb4Info(find(tdbs.children, "tdb4")).exprDisabled;
  }

  /** Keyframe timing/ease of a wrapper property (orientation, path, text), whose values live elsewhere. */
  private wrapperKeys(tdbs: Chunk): RawKey[] {
    const list = findList(tdbs.children, "list");
    return list ? readRawKeys(this.bin, list, false).keys : [];
  }

  // ---- specialised wrappers ----

  private readOrientation(mn: string, otst: Chunk): Prop {
    const b = this.bin;
    const tdbs = findList(otst.children, "tdbs");
    const p: Prop = { matchName: mn, name: (tdbs && this.storedName(tdbs)) ?? this.displayName(mn) ?? mn, propertyType: "Property", propertyValueType: PVT.ThreeD_SPATIAL };
    if (!tdbs) return p;
    const keys = this.wrapperKeys(tdbs);
    const otky = findList(otst.children, "otky");
    const otdas = otky ? filter(otky.children, "otda") : [];
    if (keys.length > 0) {
      const values = keys.map((_, i) => {
        const o = otdas[i];
        if (!o) return null;
        const v = b.doubles(o);
        while (v.length < 3) v.push(0);
        return v.slice(0, 3);
      });
      p.keyframes = buildKeyframes(keys, values, { layer: this.layer, speedFactor: 1, motionPath: false, linearSpeedOne: true, zeroSpatial: true, scale: null });
    } else {
      const cdat = find(tdbs.children, "cdat");
      if (cdat) {
        const v = b.doubles(cdat, true);
        while (v.length < 3) v.push(0);
        p.value = v.slice(0, 3);
      }
    }
    this.readExpression(p, tdbs);
    return p;
  }

  private readPath(mn: string, oms: Chunk): Prop {
    const b = this.bin;
    const tdbs = findList(oms.children, "tdbs");
    const p: Prop = { matchName: mn, name: (tdbs && this.storedName(tdbs)) ?? this.displayName(mn) ?? mn, propertyType: "Property", propertyValueType: PVT.SHAPE };
    const omks = findList(oms.children, "omks");
    const scale: [number, number] | null = mn === "ADBE Mask Shape" ? [this.layer.size[0], this.layer.size[1]] : null;
    const shapes: AeJsonShape[] = omks ? filterList(omks.children, "shap").map((s) => readShap(b, s, scale)) : [];
    if (!tdbs) {
      if (shapes[0]) p.value = shapes[0];
      return p;
    }
    const keys = this.wrapperKeys(tdbs);
    if (keys.length > 0) {
      p.keyframes = buildKeyframes(
        keys,
        keys.map((_, i) => shapes[i] ?? null),
        { layer: this.layer, speedFactor: 1, motionPath: false, linearSpeedOne: true, scale: null },
      );
    } else if (shapes[0]) p.value = shapes[0];
    else this.scope.note(`A path (${p.name}) on layer ${this.layer.where} has no outline.`);
    this.readExpression(p, tdbs);
    return p;
  }

  private readText(mn: string, btds: Chunk): Prop {
    const b = this.bin;
    const tdbs = findList(btds.children, "tdbs");
    const p: Prop = { matchName: mn, name: (tdbs && this.storedName(tdbs)) ?? this.displayName(mn) ?? mn, propertyType: "Property", propertyValueType: PVT.TEXT_DOCUMENT };
    const btdk = findList(btds.children, "btdk");
    let docs: AeJsonTextDocument[] = [];
    const mixedStyles = new Set<AeJsonTextDocument>();
    if (btdk) {
      try {
        docs = textDocuments(parseCos(b.bytes, btdk.start, btdk.end), mixedStyles);
      } catch {
        docs = [];
      }
    }
    if (docs.length === 0) this.scope.note(`The text of layer ${this.layer.where} couldn't be read.`);
    else if (docs.some((d) => mixedStyles.has(d))) this.scope.note(`Text on layer ${this.layer.where} mixes several fonts, sizes or colours; only the first style was read.`);
    if (!tdbs) {
      if (docs[0]) p.value = docs[0];
      return p;
    }
    const keys = this.wrapperKeys(tdbs);
    if (keys.length > 0) {
      p.keyframes = buildKeyframes(
        keys,
        keys.map((_, i) => docs[i] ?? null),
        { layer: this.layer, speedFactor: 1, motionPath: false, linearSpeedOne: false, scale: null },
      );
    } else if (docs[0]) p.value = docs[0];
    this.readExpression(p, tdbs);
    return p;
  }

  private readGradient(mn: string, gcst: Chunk): Prop {
    const tdbs = findList(gcst.children, "tdbs");
    const p: Prop = { matchName: mn, name: (tdbs && this.storedName(tdbs)) ?? this.displayName(mn) ?? mn, propertyType: "Property", propertyValueType: PVT_FIX[mn] ?? PVT.CUSTOM_VALUE };
    this.scope.note(`Gradient colours (${p.name}) on layer ${this.layer.where} weren't read.`);
    return p;
  }

  private readMarkers(mn: string, mrst: Chunk): Prop {
    const b = this.bin;
    const p: Prop = { matchName: mn, name: this.displayName(mn) ?? "Marker", propertyType: "Property", propertyValueType: PVT.MARKER };
    const tdbs = findList(mrst.children, "tdbs");
    const list = tdbs ? findList(tdbs.children, "list") : undefined;
    const lhd3 = list ? find(list.children, "lhd3") : undefined;
    const ldat = list ? find(list.children, "ldat") : undefined;
    const mrky = findList(mrst.children, "mrky");
    const nmrds = mrky ? filterList(mrky.children, "Nmrd") : [];
    if (!lhd3 || !ldat || nmrds.length === 0) return p;
    const count = b.cu16(lhd3, 10);
    const size = b.cu16(lhd3, 18);
    const tb = layerTimebase(this.layer);
    const stretch = this.layer.stretch ? this.layer.stretch / 100 : 1;
    const markers: AeJsonMarker[] = [];
    for (let i = 0; i < count && i < nmrds.length; i++) {
      const o = ldat.start + i * size;
      if (o + 4 > ldat.end) break;
      const units = b.s32(o);
      const nmrd = nmrds[i]!;
      const nmhd = find(nmrd.children, "NmHd");
      const strings = filter(nmrd.children, "Utf8").map((u) => b.text(u));
      const m: Mut<AeJsonMarker> = { time: (units / tb) * stretch + this.layer.startTime };
      m.duration = nmhd ? b.cu32(nmhd, 8) / 600 : 0;
      m.comment = strings[0] ?? "";
      m.label = nmhd ? b.cu8(nmhd, 16) : 0;
      markers.push(m);
    }
    this.markers = markers;
    return p;
  }

  // ---- effects ----

  private readEffect(mn: string, sspc: Chunk): Prop {
    const b = this.bin;
    const tdgp = findList(sspc.children, "tdgp");
    const fnam = find(sspc.children, "fnam");
    const display = fnam ? b.text(find(fnam.children, "Utf8")) : "";
    let defs = readParamDefs(b, sspc);
    if (defs.length === 0) defs = this.scope.effectDefs.get(mn) ?? [];
    if (defs.length === 0) this.scope.note(`Effect “${display || mn}” on layer ${this.layer.where}: its untouched settings aren't stored in the file, so only the changed ones were read.`);
    else if (!this.scope.effectDefs.has(mn)) this.scope.effectDefs.set(mn, defs);
    const fx: EffectContext = { defs: new Map(defs.map((d) => [d.matchName, d])) };
    const g: Prop = { matchName: mn };
    const name = (tdgp && this.storedName(tdgp)) || display || this.displayName(mn);
    if (name) g.name = name;
    g.propertyType = "NamedGroup";
    const tdsb = tdgp ? find(tdgp.children, "tdsb") : undefined;
    g.enabled = tdsb ? (b.cu8(tdsb, 3) & 1) === 1 : true;
    const parsed = tdgp ? this.readChildren(tdgp, mn, fx) : [];
    const byMn = new Map(parsed.map((p) => [p.matchName, p]));
    const out: Prop[] = [];
    for (const d of defs) {
      const have = byMn.get(d.matchName);
      if (have) {
        out.push(have);
        continue;
      }
      if (d.matchName === "ADBE Force CPU GPU") continue;
      out.push(this.synthesizeParam(d));
    }
    for (const p of parsed) if (!fx.defs.has(p.matchName)) out.push(p);
    if (!out.some((p) => p.matchName === "ADBE Effect Built In Params")) {
      out.push({ matchName: "ADBE Effect Built In Params", name: "Compositing Options", propertyType: "NamedGroup", enabled: true, properties: this.fillDefaults("ADBE Effect Built In Params", []) });
    }
    g.properties = out;
    return g;
  }

  private synthesizeParam(d: ParamDef): Prop {
    const forced = NAME_OVERRIDES[d.matchName];
    const p: Prop = { matchName: d.matchName, name: forced ?? (d.controlType === CT.BUTTON ? "" : d.name || MATCH_NAME_DISPLAY[d.matchName] || ""), propertyType: "Property" };
    let pvt: number = PVT.OneD;
    switch (d.controlType) {
      case CT.COLOR:
        pvt = PVT.COLOR;
        break;
      case CT.TWO_D:
        pvt = PVT.TwoD_SPATIAL;
        break;
      case CT.THREE_D:
        pvt = PVT.ThreeD_SPATIAL;
        break;
      case CT.LAYER:
        pvt = PVT.LAYER_INDEX;
        break;
      case CT.MASK:
        pvt = PVT.MASK_INDEX;
        break;
      case CT.CURVE:
        pvt = PVT.CUSTOM_VALUE;
        break;
      case CT.GROUP:
      case CT.GROUP_END:
      case CT.BUTTON:
      case CT.PAINT_GROUP:
        pvt = PVT.NO_VALUE;
        break;
      default:
        pvt = PVT.OneD;
    }
    p.propertyValueType = pvt;
    if (d.value !== undefined && pvt !== PVT.NO_VALUE && pvt !== PVT.CUSTOM_VALUE) {
      if (d.pointUnits && Array.isArray(d.value)) {
        const [w, h] = this.layer.size;
        const s = [w, h, h];
        p.value = d.value.map((v, i) => (v / 512) * (s[i] ?? 1));
      } else p.value = Array.isArray(d.value) ? [...d.value] : d.value;
    }
    return p;
  }

  // ---- transform ----

  /** Complete the Transform group with the twelve properties AE always reports, in AE's order. */
  completeTransform(g: Prop): void {
    const L = this.layer;
    const kids = g.properties ?? [];
    const byMn = new Map(kids.map((p) => [p.matchName, p]));
    const { width: cw, height: ch } = L.comp;
    let anchor: number[];
    if (L.kind === "camera" || L.kind === "light") anchor = [cw / 2, ch / 2, 0];
    else if (L.kind === "text" || L.kind === "shape" || L.kind === "model" || L.kind === "mesh" || L.nullLayer || !L.hasSource) anchor = [0, 0, 0];
    // A source without pixels (audio) keeps the anchor normalised: the centre is 0.5, 0.5.
    else anchor = L.sourceSize ? [L.sourceSize[0] / 2, L.sourceSize[1] / 2, 0] : [0.5, 0.5, 0];
    // A camera starts one 50 mm-lens zoom in front of the comp.
    const zoom = ((cw * L.comp.pixelAspect) / 0.72);
    const spatialDefaults: Record<string, number | number[]> = {
      "ADBE Anchor Point": anchor,
      "ADBE Position": L.kind === "camera" ? [cw / 2, ch / 2, -zoom] : [cw / 2, ch / 2, 0],
      "ADBE Position_0": 0,
      "ADBE Position_1": 0,
    };
    const out: Prop[] = [];
    for (const s of TRANSFORM_CHILDREN) {
      let p = byMn.get(s.m);
      if (!p) {
        p = this.synthesize(s);
        const v = spatialDefaults[s.m];
        if (v !== undefined) p.value = Array.isArray(v) ? [...v] : v;
        if (s.m === "ADBE Opacity" && L.nullLayer) p.value = 0;
      }
      out.push(p);
    }
    for (const k of kids) if (!TRANSFORM_CHILDREN.some((s) => s.m === k.matchName)) out.push(k);
    for (const p of out) {
      if (p.matchName === "ADBE Rotate Z") p.name = L.is3D ? "Z Rotation" : "Rotation";
      else if (p.matchName === "ADBE Anchor Point" && (L.kind === "camera" || L.kind === "light")) p.name = "Point of Interest";
      else if (!p.name) p.name = this.displayName(p.matchName);
    }
    // A separated position is driven by its X / Y / Z followers.
    const pos = out.find((p) => p.matchName === "ADBE Position");
    if (pos?.dimensionsSeparated && !pos.keyframes?.length) {
      // Its own stored value is stale; report the followers' values at time 0 where they are known.
      const at0 = (p: Prop | undefined): number | undefined => {
        if (!p) return undefined;
        const keys = p.keyframes;
        if (!keys?.length) return typeof p.value === "number" ? p.value : undefined;
        const first = keys[0]!;
        const last = keys[keys.length - 1]!;
        if (first.time >= 0) return typeof first.value === "number" ? first.value : undefined;
        if (last.time <= 0) return typeof last.value === "number" ? last.value : undefined;
        return undefined;
      };
      const f = FOLLOWERS.map((m) => at0(out.find((p) => p.matchName === m)));
      if (!L.is3D) f[2] = f[2] ?? 0;
      if (f.every((x) => x !== undefined)) pos.value = f as number[];
      else delete pos.value;
    }
    g.properties = out;
  }
}
