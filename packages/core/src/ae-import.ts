/**
 * After Effects → Before Effects. Turns After Effects project data (ae-json.ts, from the
 * in-After-Effects exporter or the .aep reader) into a Before Effects project, plus a
 * compatibility report that says, item by item, what came across exactly, what was approximated,
 * what was kept but isn't rendered yet, and what is missing. Nothing is dropped without a line in
 * the report, and the original file is never modified (the studio keeps a copy of it).
 *
 * Mapping (After Effects → Before Effects):
 *   compositions → compositions (size, frame rate, duration, background, work area, markers)
 *   footage files → media assets; solids → solid layers; precomps → nested scenes
 *   AV / text / shape / null / adjustment / camera / light layers → the matching layer kinds
 *   timing (start, in, out, stretch), switches, blend modes, parenting, track mattes, 3D flag
 *   transform, mask and shape properties with keyframes (linear / Bezier / hold, temporal ease,
 *   spatial tangents, roving) and expressions (kept; evaluated once the expression engine lands)
 *   effects: Gaussian Blur and Glow render; every other effect is kept with its settings
 */
import { AE, type AeJsonComp, type AeJsonFootage, type AeJsonKeyframe, type AeJsonLayer, type AeJsonProject, type AeJsonProperty, type AeJsonShape, type AeJsonTextDocument } from "./ae-json.ts";
import type { AnimProp, Ease, Interp, Keyframe, PropValue } from "./anim.ts";
import {
  type Asset,
  type AssetKind,
  type BlendMode,
  type Composition,
  emptyProject,
  type EffectInstance,
  type Id,
  type Layer,
  type LayerSource,
  type Mask,
  packPath,
  type PathValue,
  type Project,
  type RGBA,
  type ShapeContents,
  type TextDocument,
  type Transform,
  type Vec3,
} from "./model.ts";
import { type Flicks, type Rational, secondsToTime } from "./time.ts";

export type ImportLevel = "exact" | "approximated" | "kept" | "missing" | "not-imported";

export interface ImportNote {
  readonly level: ImportLevel;
  /** Where: "Comp 1 › Title text › Masks". */
  readonly where: string;
  readonly text: string;
}

export interface AeImportReport {
  readonly sourceName: string;
  readonly route: "after-effects-exporter" | "aep-file";
  readonly counts: {
    readonly compositions: number;
    readonly layers: number;
    readonly keyframes: number;
    readonly masks: number;
    readonly effects: number;
    readonly effectsRendered: number;
    readonly expressions: number;
    readonly media: number;
    readonly mediaMissing: number;
  };
  /**
   * Every layer in one of four groups. "Drawn" means Before Effects renders it with nothing
   * reported missing — it does not mean it was compared with After Effects frame by frame.
   */
  readonly layerFidelity: {
    readonly drawn: number;
    readonly approximated: number;
    readonly preservedNotDrawn: number;
    readonly notImported: number;
  };
  readonly notes: readonly ImportNote[];
}

export interface AeImportOptions {
  readonly sourceName?: string;
  readonly route?: AeImportReport["route"];
  /** Where an After Effects media path is on this PC (relinking); return missing:true if not found. */
  readonly resolveMedia?: (aePath: string) => { readonly path: string; readonly missing: boolean };
}

export interface AeImportResult {
  readonly project: Project;
  readonly mainCompId: Id | null;
  readonly report: AeImportReport;
}

// ---------------------------------------------------------------------------------------------
// Small helpers

const IMAGE = /\.(png|jpe?g|tiff?|bmp|gif|webp|psd|exr|tga|dpx|hdr|svg|ai|pdf|eps)$/i;
const VIDEO = /\.(mov|mp4|m4v|avi|mkv|webm|mxf|mpe?g|wmv|flv|r3d|braw|gif)$/i;
const AUDIO = /\.(wav|aiff?|mp3|aac|m4a|flac|ogg|wma)$/i;

/** Exact NTSC rates where AE stores e.g. 29.97002997. */
export const aeFrameRate = (fps: number, frameDuration?: number): Rational => {
  const f = frameDuration && frameDuration > 0 ? 1 / frameDuration : fps;
  for (const base of [24, 30, 48, 60, 120]) if (Math.abs(f - (base * 1000) / 1001) < 0.002) return { num: base * 1000, den: 1001 };
  if (Math.abs(f - Math.round(f)) < 0.0005 && f >= 1) return { num: Math.round(f), den: 1 };
  const den = 1000;
  const num = Math.round(f * den);
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
  const d = g(num, den);
  return { num: Math.max(1, num / d), den: den / d };
};

const T = (s: number | undefined): Flicks => secondsToTime(s ?? 0);
const rgba = (c: readonly number[] | undefined, a = 1): RGBA => [c?.[0] ?? 0, c?.[1] ?? 0, c?.[2] ?? 0, c?.[3] ?? a];

const BLEND: Record<number, BlendMode> = {
  [AE.blendingMode.NORMAL]: "normal",
  [AE.blendingMode.ADD]: "add",
  [AE.blendingMode.LINEAR_DODGE]: "add",
  [AE.blendingMode.SCREEN]: "screen",
  [AE.blendingMode.MULTIPLY]: "multiply",
  [AE.blendingMode.OVERLAY]: "overlay",
  [AE.blendingMode.SOFT_LIGHT]: "soft-light",
  [AE.blendingMode.HARD_LIGHT]: "hard-light",
  [AE.blendingMode.COLOR_DODGE]: "color-dodge",
  [AE.blendingMode.CLASSIC_COLOR_DODGE]: "color-dodge",
  [AE.blendingMode.COLOR_BURN]: "color-burn",
  [AE.blendingMode.CLASSIC_COLOR_BURN]: "color-burn",
  [AE.blendingMode.DARKEN]: "darken",
  [AE.blendingMode.LIGHTEN]: "lighten",
  [AE.blendingMode.DIFFERENCE]: "difference",
  [AE.blendingMode.CLASSIC_DIFFERENCE]: "difference",
  [AE.blendingMode.EXCLUSION]: "exclusion",
  [AE.blendingMode.HUE]: "hue",
  [AE.blendingMode.SATURATION]: "saturation",
  [AE.blendingMode.COLOR]: "color",
  [AE.blendingMode.LUMINOSITY]: "luminosity",
};
const BLEND_NAME = Object.fromEntries(Object.entries(AE.blendingMode).map(([k, v]) => [v, k.toLowerCase().replace(/_/g, " ")]));

const MASK_MODE: Record<number, Mask["mode"]> = {
  [AE.maskMode.NONE]: "none",
  [AE.maskMode.ADD]: "add",
  [AE.maskMode.SUBTRACT]: "subtract",
  [AE.maskMode.INTERSECT]: "intersect",
  [AE.maskMode.LIGHTEN]: "lighten",
  [AE.maskMode.DARKEN]: "darken",
  [AE.maskMode.DIFFERENCE]: "difference",
};

const child = (p: { properties?: readonly AeJsonProperty[] } | undefined, matchName: string): AeJsonProperty | undefined => p?.properties?.find((c) => c.matchName === matchName);

const shapeToPath = (s: AeJsonShape): PathValue =>
  packPath({
    closed: !!s.closed,
    vertices: s.vertices.map((v, i) => ({
      p: [v[0] ?? 0, v[1] ?? 0],
      in: [s.inTangents[i]?.[0] ?? 0, s.inTangents[i]?.[1] ?? 0],
      out: [s.outTangents[i]?.[0] ?? 0, s.outTangents[i]?.[1] ?? 0],
    })),
  });

const isShape = (v: unknown): v is AeJsonShape => !!v && typeof v === "object" && Array.isArray((v as AeJsonShape).vertices);

type ItemRef =
  | { readonly kind: "comp"; readonly id: Id }
  | { readonly kind: "solid"; readonly color: RGBA; readonly width: number; readonly height: number }
  | { readonly kind: "asset"; readonly asset: Asset }
  | { readonly kind: "placeholder"; readonly name: string };

// ---------------------------------------------------------------------------------------------

class Importer {
  readonly notes: ImportNote[] = [];
  keyframes = 0;
  expressions = 0;
  masks = 0;
  effects = 0;
  effectsRendered = 0;
  private idSeq = 0;

  constructor(readonly ae: AeJsonProject, readonly opts: AeImportOptions) {}

  note(level: ImportLevel, where: string, text: string) {
    this.notes.push({ level, where, text });
  }

  /** Convert an AE property to an animatable value. `conv` maps each AE value to ours. */
  anim<V extends PropValue>(p: AeJsonProperty | undefined, fallback: V, conv: (v: unknown) => V, where: string, spatial = false): AnimProp<V> {
    if (!p) return spatial ? { value: fallback, spatial } : { value: fallback };
    const value = p.value !== undefined && p.value !== null ? conv(p.value) : p.keyframes?.[0] ? conv(p.keyframes[0].value) : fallback;
    const out: { value: V; keyframes?: Keyframe<V>[]; expression?: { src: string; enabled: boolean }; spatial?: boolean } = { value };
    if (spatial) out.spatial = true;
    const keys = p.keyframes ?? [];
    if (keys.length > 0) {
      out.keyframes = keys.map((k, i) => this.keyframe(k, i, conv));
      this.keyframes += keys.length;
      if (keys.length === 1) out.value = out.keyframes[0]!.v;
    }
    if (p.expression) {
      out.expression = { src: p.expression, enabled: p.expressionEnabled !== false };
      this.expressions++;
      this.note("kept", where, `Expression on “${p.name ?? p.matchName}” kept. Expressions aren't evaluated yet, so it shows its keyframed value.`);
    }
    return out as AnimProp<V>;
  }

  private keyframe<V extends PropValue>(k: AeJsonKeyframe, i: number, conv: (v: unknown) => V): Keyframe<V> {
    const interp = (n?: number): Interp => (n === AE.interp.HOLD ? "hold" : n === AE.interp.LINEAR ? "linear" : "bezier");
    const ease = (e?: readonly { speed: number; influence: number }[]): Ease[] | undefined => (e && e.length ? e.map((x) => ({ speed: x.speed, influence: Math.max(0.001, Math.min(1, x.influence / 100)) })) : undefined);
    const kf: { -readonly [K in keyof Keyframe<V>]: Keyframe<V>[K] } = { id: `k${++this.idSeq}_${i}`, t: T(k.time), v: conv(k.value), in: interp(k.inInterpolationType), out: interp(k.outInterpolationType) };
    const ei = ease(k.inTemporalEase);
    const eo = ease(k.outTemporalEase);
    if (ei) kf.easeIn = ei;
    if (eo) kf.easeOut = eo;
    if (k.inSpatialTangent?.length) kf.tanIn = [...k.inSpatialTangent];
    if (k.outSpatialTangent?.length) kf.tanOut = [...k.outSpatialTangent];
    if (k.roving) kf.roving = true;
    return kf as Keyframe<V>;
  }

  num = (d: number) => (v: unknown): number => (typeof v === "number" ? v : Array.isArray(v) ? Number(v[0] ?? d) : d);
  vec3 = (d: Vec3) => (v: unknown): Vec3 => (Array.isArray(v) ? [Number(v[0] ?? d[0]), Number(v[1] ?? d[1]), Number(v[2] ?? d[2])] : typeof v === "number" ? [v, v, d[2]] : d);
  colour = (v: unknown): RGBA => (Array.isArray(v) ? rgba(v as number[]) : [1, 1, 1, 1]);
  path = (v: unknown): PathValue => (isShape(v) ? shapeToPath(v) : [1, 0]);

  // ---- transform ----

  transform(L: AeJsonLayer, where: string, is3D: boolean): Transform {
    const g = (L.properties ?? []).find((p) => p.matchName === "ADBE Transform Group");
    const anchor = this.anim(child(g, "ADBE Anchor Point"), [0, 0, 0] as Vec3, this.vec3([0, 0, 0]), where, true);
    let position: AnimProp<Vec3>;
    const pos = child(g, "ADBE Position");
    const sep = pos?.dimensionsSeparated || (!!child(g, "ADBE Position_0")?.keyframes?.length && !pos?.keyframes?.length);
    if (sep) {
      const dims = ["ADBE Position_0", "ADBE Position_1", "ADBE Position_2"].map((m) => child(g, m));
      position = this.mergeSeparated(dims, pos, where);
    } else position = this.anim(pos, [0, 0, 0] as Vec3, this.vec3([0, 0, 0]), where, true);
    const scale = this.anim(child(g, "ADBE Scale"), [100, 100, 100] as Vec3, this.vec3([100, 100, 100]), where);
    const rz = child(g, "ADBE Rotate Z");
    let rotation: AnimProp<Vec3>;
    const rx = child(g, "ADBE Rotate X");
    const ry = child(g, "ADBE Rotate Y");
    const animated = (p?: AeJsonProperty) => (p?.keyframes?.length ?? 0) > 0;
    if (is3D && (animated(rx) || animated(ry) || Number(rx?.value ?? 0) !== 0 || Number(ry?.value ?? 0) !== 0)) {
      rotation = this.mergeSeparated([rx, ry, rz], undefined, where, "rotation");
    } else {
      const z = this.anim(rz, 0, this.num(0), where);
      rotation = { ...z, value: [0, 0, z.value], ...(z.keyframes ? { keyframes: z.keyframes.map((k) => ({ ...k, v: [0, 0, k.v] as Vec3, ...(k.easeIn ? { easeIn: [k.easeIn[0]!, k.easeIn[0]!, k.easeIn[0]!] } : {}), ...(k.easeOut ? { easeOut: [k.easeOut[0]!, k.easeOut[0]!, k.easeOut[0]!] } : {}) })) } : {}) } as AnimProp<Vec3>;
    }
    const orient = child(g, "ADBE Orientation");
    const ov = Array.isArray(orient?.value) ? (orient!.value as number[]) : [0, 0, 0];
    if (is3D && (ov.some((x) => Math.abs(x) > 1e-6) || animated(orient))) {
      if (!animated(orient) && !rotation.keyframes) {
        const r = rotation.value;
        rotation = { value: [r[0] + ov[0]!, r[1] + ov[1]!, r[2] + ov[2]!] };
        this.note("approximated", where, "3D orientation was combined into rotation.");
      } else this.note("approximated", where, "Animated 3D orientation isn't supported yet; rotation keeps its own animation only.");
    }
    const opacity = this.anim(child(g, "ADBE Opacity"), 100, this.num(100), where);
    return { anchor, position, scale, rotation, opacity };
  }

  /** Combine separately animated X/Y/Z into one 3D property (keys at the union of times). */
  private mergeSeparated(dims: (AeJsonProperty | undefined)[], whole: AeJsonProperty | undefined, where: string, what = "position"): AnimProp<Vec3> {
    const props = dims.map((d) => this.anim(d, 0, this.num(0), where));
    const times = [...new Set(props.flatMap((p) => p.keyframes?.map((k) => k.t) ?? []))].sort((a, b) => a - b);
    const fallback: Vec3 = Array.isArray(whole?.value) ? (this.vec3([0, 0, 0])(whole!.value) as Vec3) : [props[0]!.value, props[1]!.value, props[2]!.value];
    if (!times.length) return { value: [props[0]!.value, props[1]!.value, props[2]!.value], ...(what === "position" ? { spatial: true } : {}) };
    const at = (p: AnimProp<number>, t: Flicks): number => {
      const k = p.keyframes;
      if (!k?.length) return p.value;
      if (t <= k[0]!.t) return k[0]!.v;
      if (t >= k.at(-1)!.t) return k.at(-1)!.v;
      for (let i = 0; i < k.length - 1; i++) if (t >= k[i]!.t && t <= k[i + 1]!.t) return k[i]!.out === "hold" ? k[i]!.v : k[i]!.v + ((k[i + 1]!.v - k[i]!.v) * (t - k[i]!.t)) / Math.max(1, k[i + 1]!.t - k[i]!.t);
      return p.value;
    };
    this.note("approximated", where, `Separately animated ${what} dimensions were combined; easing between keyframes may differ slightly.`);
    void fallback;
    return {
      value: [at(props[0]!, times[0]!), at(props[1]!, times[0]!), at(props[2]!, times[0]!)],
      keyframes: times.map((t, i) => ({ id: `k${++this.idSeq}_m${i}`, t, v: [at(props[0]!, t), at(props[1]!, t), at(props[2]!, t)] as Vec3, in: "linear", out: "linear" })),
      ...(what === "position" ? { spatial: true } : {}),
    };
  }

  // ---- masks ----

  masksOf(L: AeJsonLayer, where: string): Mask[] {
    const parade = (L.properties ?? []).find((p) => p.matchName === "ADBE Mask Parade");
    return (parade?.properties ?? [])
      .filter((m) => m.matchName === "ADBE Mask Atom")
      .map((m, i): Mask => {
        this.masks++;
        const w = `${where} › Mask “${m.name ?? i + 1}”`;
        const shape = child(m, "ADBE Mask Shape");
        if (!shape || (!isShape(shape.value) && !shape.keyframes?.length)) this.note("missing", w, "The mask's outline couldn't be read, so it's empty.");
        const feather = child(m, "ADBE Mask Feather");
        const fv = Array.isArray(feather?.value) ? (feather!.value as number[]) : [0, 0];
        if (Math.abs((fv[0] ?? 0) - (fv[1] ?? 0)) > 0.01) this.note("approximated", w, "Different horizontal and vertical feather became one feather amount.");
        const mode = MASK_MODE[m.maskMode ?? AE.maskMode.ADD] ?? "add";
        return {
          id: `mask_${++this.idSeq}`,
          name: m.name ?? `Mask ${i + 1}`,
          source: { kind: "path", path: this.anim(shape, [1, 0] as PathValue, this.path, w) },
          mode,
          inverted: !!m.inverted,
          feather: this.anim(feather, 0, this.num(0), w),
          expansion: this.anim(child(m, "ADBE Mask Offset"), 0, this.num(0), w),
          opacity: this.anim(child(m, "ADBE Mask Opacity"), 100, this.num(100), w),
        };
      });
  }

  // ---- effects ----

  effectsOf(L: AeJsonLayer, where: string): EffectInstance[] {
    const parade = (L.properties ?? []).find((p) => p.matchName === "ADBE Effect Parade");
    return (parade?.properties ?? []).map((fx, i): EffectInstance => {
      this.effects++;
      const w = `${where} › Effect “${fx.name ?? fx.matchName}”`;
      const params = (fx.properties ?? []).filter((p) => !p.properties && (p.propertyType ?? "Property") === "Property" && !p.matchName.startsWith("ADBE Effect ") && p.matchName !== "ADBE Force CPU GPU");
      const byName = (re: RegExp, idx: number) => params.find((p) => re.test(p.name ?? "")) ?? params.find((p) => p.matchName.endsWith(`-${String(idx).padStart(4, "0")}`));
      const id = `fx_${++this.idSeq}`;
      const enabled = fx.enabled !== false;
      if (fx.matchName === "ADBE Gaussian Blur 2" || fx.matchName === "ADBE Gaussian Blur") {
        this.effectsRendered++;
        this.note("approximated", w, "Gaussian Blur became Blur; the strength is matched approximately.");
        const b = this.anim(byName(/blurriness/i, 1), 10, this.num(10), w);
        return { id, type: "gaussian-blur", enabled, params: { radius: scaleAnim(b, 1.25) } };
      }
      if (fx.matchName === "ADBE Glo2" || fx.matchName === "ADBE Glow") {
        this.effectsRendered++;
        this.note("approximated", w, "Glow became Before Effects' glow; threshold, radius and intensity are matched approximately.");
        const thr = this.anim(byName(/threshold/i, 2), 60, this.num(60), w);
        const rad = this.anim(byName(/radius/i, 3), 10, this.num(10), w);
        const inten = this.anim(byName(/intensity/i, 4), 1, this.num(1), w);
        return { id, type: "glow", enabled, params: { threshold: scaleAnim(thr, 0.01), radius: rad, intensity: inten } };
      }
      // Any other effect: kept with every setting so nothing is lost, but not rendered yet.
      const kept: Record<string, AnimProp> = {};
      for (const p of params) {
        if (typeof p.value === "number" || Array.isArray(p.value)) kept[p.name ?? p.matchName] = this.anim(p, p.value as PropValue, (v) => (Array.isArray(v) ? (v as number[]) : Number(v)) as PropValue, w);
      }
      this.note("kept", w, `“${fx.name ?? fx.matchName}” (${fx.matchName}) is kept with its settings but isn't rendered yet.`);
      return { id, type: `ae:${fx.matchName}`, enabled, params: kept };
    });
  }

  // ---- text ----

  textOf(L: AeJsonLayer, where: string): TextDocument {
    const props = (L.properties ?? []).find((p) => p.matchName === "ADBE Text Properties");
    const docProp = child(props, "ADBE Text Document");
    const raw = (docProp?.value ?? docProp?.keyframes?.[0]?.value) as AeJsonTextDocument | undefined;
    if (!raw || typeof raw !== "object" || typeof (raw as AeJsonTextDocument).text !== "string") {
      this.note("missing", where, "The text content couldn't be read; the layer shows “Text”.");
    }
    if ((docProp?.keyframes?.length ?? 0) > 1) this.note("approximated", where, "Animated source text: the first text is used.");
    const animators = child(props, "ADBE Text Animators");
    if (animators?.properties?.length) this.note("not-imported", where, `${animators.properties.length} text animator(s) weren't imported (per-character animation comes later).`);
    if (child(props, "ADBE Text Path Options")?.properties?.some((p) => p.matchName === "ADBE Text Path" && Number(p.value) > 0)) this.note("not-imported", where, "Text on a path isn't supported yet.");
    const d = (raw ?? { text: "Text" }) as AeJsonTextDocument;
    const size = d.fontSize ?? 48;
    // .aep files store only the PostScript name ("Arial-BoldMT"); the family and style come from it.
    const [psFamily = "", psStyle = ""] = (d.font ?? "").split("-");
    const family = d.fontFamily || psFamily.replace(/(PSMT|PS|MT)$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim() || "Arial";
    const style = (d.fontStyle ?? psStyle).toLowerCase();
    const weight = /black|heavy/.test(style) ? 900 : /extra ?bold|ultra ?bold/.test(style) ? 800 : /semi ?bold|demi/.test(style) ? 600 : /bold/.test(style) || d.fauxBold ? 700 : /medium/.test(style) ? 500 : /extra ?light|ultra ?light|thin/.test(style) ? 200 : /light/.test(style) ? 300 : 400;
    const j = d.justification ?? AE.justification.LEFT_JUSTIFY;
    const align: TextDocument["align"] = j === AE.justification.CENTER_JUSTIFY || j === AE.justification.FULL_JUSTIFY_LASTLINE_CENTER ? "center" : j === AE.justification.RIGHT_JUSTIFY || j === AE.justification.FULL_JUSTIFY_LASTLINE_RIGHT ? "right" : "left";
    if (d.boxText) this.note("approximated", where, "Paragraph (box) text became point text; line breaks are kept but the box isn't.");
    this.note("approximated", where, "Text is laid out by Before Effects; position and line spacing can differ slightly from After Effects.");
    const doc: { -readonly [K in keyof TextDocument]: TextDocument[K] } = {
      text: (d.allCaps ? d.text.toUpperCase() : d.text).replace(/\r/g, "\n"),
      font: family,
      weight,
      size: { value: size },
      color: { value: d.applyFill === false ? [0, 0, 0, 0] : rgba(d.fillColor) },
      align,
      lineHeight: d.leading && size ? Math.max(0.5, d.leading / size) : 1.2,
      tracking: ((d.tracking ?? 0) / 1000) * size,
    };
    if (d.applyStroke && (d.strokeWidth ?? 0) > 0) doc.stroke = { color: { value: rgba(d.strokeColor) }, width: { value: d.strokeWidth ?? 1 } };
    return doc;
  }

  // ---- shapes ----

  shapesOf(L: AeJsonLayer, where: string): ShapeContents[] {
    const root = (L.properties ?? []).find((p) => p.matchName === "ADBE Root Vectors Group");
    const out: ShapeContents[] = [];
    const skipped = new Set<string>();
    const walk = (group: AeJsonProperty | undefined, path: string, offset: [number, number]) => {
      const items = group?.properties ?? [];
      const fill = items.find((p) => p.matchName === "ADBE Vector Graphic - Fill" && p.enabled !== false);
      const stroke = items.find((p) => p.matchName === "ADBE Vector Graphic - Stroke" && p.enabled !== false);
      const trim = items.find((p) => p.matchName === "ADBE Vector Filter - Trim" && p.enabled !== false);
      const style = (): Omit<ShapeContents, "path"> => {
        const s: { -readonly [K in keyof ShapeContents]?: ShapeContents[K] } = {};
        if (fill) s.fill = { color: this.anim(child(fill, "ADBE Vector Fill Color"), [1, 1, 1, 1] as RGBA, this.colour, path), opacity: this.anim(child(fill, "ADBE Vector Fill Opacity"), 100, this.num(100), path) };
        if (stroke) {
          const cap = Number(child(stroke, "ADBE Vector Stroke Line Cap")?.value ?? 1);
          const join = Number(child(stroke, "ADBE Vector Stroke Line Join")?.value ?? 1);
          s.stroke = {
            color: this.anim(child(stroke, "ADBE Vector Stroke Color"), [1, 1, 1, 1] as RGBA, this.colour, path),
            width: this.anim(child(stroke, "ADBE Vector Stroke Width"), 2, this.num(2), path),
            opacity: this.anim(child(stroke, "ADBE Vector Stroke Opacity"), 100, this.num(100), path),
            cap: cap === 2 ? "round" : cap === 3 ? "square" : "butt",
            join: join === 2 ? "round" : join === 3 ? "bevel" : "miter",
          };
        }
        if (trim) s.trim = { start: this.anim(child(trim, "ADBE Vector Trim Start"), 0, this.num(0), path), end: this.anim(child(trim, "ADBE Vector Trim End"), 100, this.num(100), path), offset: this.anim(child(trim, "ADBE Vector Trim Offset"), 0, this.num(0), path) };
        return s as Omit<ShapeContents, "path">;
      };
      for (const it of items) {
        if (it.enabled === false) continue;
        const w = `${path} › ${it.name ?? it.matchName}`;
        switch (it.matchName) {
          case "ADBE Vector Group": {
            const tr = child(it, "ADBE Vector Transform Group");
            const pos = Array.isArray(child(tr, "ADBE Vector Position")?.value) ? (child(tr, "ADBE Vector Position")!.value as number[]) : [0, 0];
            const anc = Array.isArray(child(tr, "ADBE Vector Anchor")?.value) ? (child(tr, "ADBE Vector Anchor")!.value as number[]) : [0, 0];
            const sc = child(tr, "ADBE Vector Scale")?.value;
            const rot = Number(child(tr, "ADBE Vector Rotation")?.value ?? 0);
            const animatedTr = (tr?.properties ?? []).some((p) => (p.keyframes?.length ?? 0) > 0);
            if (animatedTr || rot !== 0 || (Array.isArray(sc) && (sc[0] !== 100 || sc[1] !== 100))) this.note("approximated", w, "Group transforms other than position aren't applied yet (the group keeps its position).");
            walk(child(it, "ADBE Vectors Group"), w, [offset[0] + (pos[0] ?? 0) - (anc[0] ?? 0), offset[1] + (pos[1] ?? 0) - (anc[1] ?? 0)]);
            break;
          }
          case "ADBE Vector Shape - Group": {
            const p = child(it, "ADBE Vector Shape");
            const shift = (v: unknown): PathValue => offsetPath(this.path(v), offset);
            out.push({ path: { kind: "path", path: this.anim(p, [1, 0] as PathValue, shift, w) }, ...style() });
            break;
          }
          case "ADBE Vector Shape - Rect":
          case "ADBE Vector Shape - Ellipse": {
            const rect = it.matchName === "ADBE Vector Shape - Rect";
            const sizeP = child(it, rect ? "ADBE Vector Rect Size" : "ADBE Vector Ellipse Size");
            const posP = child(it, rect ? "ADBE Vector Rect Position" : "ADBE Vector Ellipse Position");
            const round = Number(child(it, "ADBE Vector Rect Roundness")?.value ?? 0);
            const make = (size: unknown, pos: unknown): PathValue => {
              const s = Array.isArray(size) ? (size as number[]) : [100, 100];
              const p = Array.isArray(pos) ? (pos as number[]) : [0, 0];
              return offsetPath(rect ? rectPath(s[0]!, s[1]!, round) : ellipsePath(s[0]!, s[1]!), [offset[0] + p[0]!, offset[1] + p[1]!]);
            };
            const sizeAnim = (sizeP?.keyframes?.length ?? 0) > 0;
            const posAnim = (posP?.keyframes?.length ?? 0) > 0;
            let anim: AnimProp<PathValue>;
            if (sizeAnim && !posAnim) anim = this.anim(sizeP, make(sizeP?.value, posP?.value), (v) => make(v, posP?.value), w);
            else if (posAnim && !sizeAnim) anim = this.anim(posP, make(sizeP?.value, posP?.value), (v) => make(sizeP?.value, v), w);
            else {
              if (sizeAnim && posAnim) this.note("approximated", w, "Size and position are both animated; only the size animation was kept.");
              anim = sizeAnim ? this.anim(sizeP, make(sizeP?.value, posP?.value), (v) => make(v, posP?.value), w) : { value: make(sizeP?.value, posP?.value) };
            }
            if (round > 0 && rect) this.note("approximated", w, "Rounded corners are approximated.");
            out.push({ path: { kind: "path", path: anim }, ...style() });
            break;
          }
          case "ADBE Vector Shape - Star": {
            const n = Math.max(3, Math.round(Number(child(it, "ADBE Vector Star Points")?.value ?? 5)));
            const type = Number(child(it, "ADBE Vector Star Type")?.value ?? 1);
            const outer = Number(child(it, "ADBE Vector Star Outer Radius")?.value ?? 100);
            const inner = Number(child(it, "ADBE Vector Star Inner Radius")?.value ?? 50);
            const rot = Number(child(it, "ADBE Vector Star Rotation")?.value ?? 0);
            const pos = child(it, "ADBE Vector Star Position")?.value;
            const p = Array.isArray(pos) ? (pos as number[]) : [0, 0];
            out.push({ path: { kind: "path", path: { value: offsetPath(starPath(n, outer, type === 2 ? outer : inner, rot, type !== 2), [offset[0] + p[0]!, offset[1] + p[1]!]) } }, ...style() });
            if ((it.properties ?? []).some((q) => q.keyframes?.length)) this.note("approximated", w, "An animated star or polygon is imported as its first frame.");
            break;
          }
          case "ADBE Vector Graphic - Fill":
          case "ADBE Vector Graphic - Stroke":
          case "ADBE Vector Filter - Trim":
          case "ADBE Vector Transform Group":
          case "ADBE Vector Materials Group":
            break;
          default:
            skipped.add(it.name ?? it.matchName);
        }
      }
    };
    walk(root, where, [0, 0]);
    if (skipped.size) this.note("not-imported", where, `Shape operators not supported yet: ${[...skipped].join(", ")}.`);
    if (!out.length) this.note("missing", where, "No shapes could be read from this shape layer.");
    return out;
  }

  // ---- layers and comps ----

  layer(L: AeJsonLayer, comp: AeJsonComp, compWhere: string, items: Map<number, ItemRef>, idOf: (index: number) => Id): Layer {
    const where = `${compWhere} › ${L.name}`;
    const mn = L.matchName ?? (L.layerType === "CameraLayer" ? "ADBE Camera Layer" : L.layerType === "LightLayer" ? "ADBE Light Layer" : "ADBE AV Layer");
    const is3D = !!L.threeDLayer || mn === "ADBE Camera Layer" || mn === "ADBE Light Layer";
    let source: LayerSource;
    if (mn === "ADBE Text Layer") source = { kind: "text", doc: this.textOf(L, where) };
    else if (mn === "ADBE Vector Layer") source = { kind: "shape", contents: this.shapesOf(L, where) };
    else if (mn === "ADBE Camera Layer") {
      const opts = (L.properties ?? []).find((p) => p.matchName === "ADBE Camera Options Group");
      source = { kind: "camera", zoom: this.anim(child(opts, "ADBE Camera Zoom"), 1000, this.num(1000), where) };
      this.note("kept", where, "Camera kept with its animation. 3D cameras aren't rendered yet, so the scene is viewed from the front.");
    } else if (mn === "ADBE Light Layer") {
      const opts = (L.properties ?? []).find((p) => p.matchName === "ADBE Light Options Group");
      const lt = L.lightType ?? AE.lightType.POINT;
      source = {
        kind: "light",
        lightType: lt === AE.lightType.PARALLEL ? "parallel" : lt === AE.lightType.SPOT ? "spot" : lt === AE.lightType.AMBIENT ? "ambient" : lt === AE.lightType.ENVIRONMENT ? "environment" : "point",
        color: this.anim(child(opts, "ADBE Light Color"), [1, 1, 1, 1] as RGBA, this.colour, where),
        intensity: this.anim(child(opts, "ADBE Light Intensity"), 100, this.num(100), where),
      };
      this.note("kept", where, "Light kept with its settings. 3D lighting isn't rendered yet.");
    } else if (L.nullLayer) source = { kind: "null" };
    else if (L.adjustmentLayer) source = { kind: "adjustment" };
    else if (mn !== "ADBE AV Layer") {
      source = { kind: "null" };
      this.note("not-imported", where, `This kind of layer (${mn}) isn't supported yet; it was imported as an empty controller layer.`);
    } else {
      const src = L.sourceId != null ? items.get(L.sourceId) : undefined;
      if (!src) {
        source = { kind: "solid", color: { value: [0.5, 0.5, 0.5, 1] }, width: comp.width, height: comp.height };
        this.note("missing", where, "The layer's source wasn't found in the project; a grey placeholder was used.");
      } else if (src.kind === "comp") source = { kind: "comp", compId: src.id };
      else if (src.kind === "solid") source = { kind: "solid", color: { value: src.color }, width: src.width, height: src.height };
      else if (src.kind === "placeholder") {
        source = { kind: "solid", color: { value: [0.5, 0.5, 0.5, 1] }, width: comp.width, height: comp.height };
        this.note("missing", where, `“${src.name}” was a placeholder in After Effects; a grey placeholder was used.`);
      } else source = src.asset.kind === "audio" ? { kind: "audio", assetId: src.asset.id } : { kind: "footage", assetId: src.asset.id };
    }

    const stretch = L.stretch && L.stretch !== 0 ? 100 / L.stretch : 1;
    if (L.stretch && L.stretch < 0) this.note("approximated", where, "Reversed layers (negative stretch) play forwards for now.");
    if (L.timeRemapEnabled) this.note("not-imported", where, "Time remapping isn't supported yet; the layer plays at its normal speed.");
    if (L.motionBlur) this.note("not-imported", where, "Motion blur isn't supported yet.");
    if (L.collapseTransformation && source.kind === "comp") this.note("approximated", where, "Collapse transformations isn't supported yet; the nested composition renders at its own size.");
    if (L.guideLayer) this.note("approximated", where, "Guide layer imported hidden (Before Effects has no guide layers yet).");
    if (L.blendingMode !== undefined && L.blendingMode !== AE.blendingMode.NORMAL) {
      const mapped = BLEND[L.blendingMode];
      const label = BLEND_NAME[L.blendingMode] ?? String(L.blendingMode);
      if (!mapped) this.note("approximated", where, `Blend mode “${label}” has no Before Effects equivalent; Normal is used.`);
    }
    if (L.markers?.length) this.note("not-imported", where, `${L.markers.length} layer marker(s) weren't imported.`);
    if (is3D && source.kind !== "camera" && source.kind !== "light") this.note("approximated", where, "3D layer: kept as 3D, but rendered flat until 3D rendering arrives.");

    const masks = this.masksOf(L, where);
    const effects = this.effectsOf(L, where);
    const layer: { -readonly [K in keyof Layer]: Layer[K] } = {
      id: idOf(L.index),
      name: L.name,
      source,
      startTime: T(L.startTime),
      inPoint: T(L.inPoint),
      outPoint: T(L.outPoint),
      stretch,
      enabled: L.enabled !== false && !L.guideLayer,
      solo: !!L.solo,
      locked: !!L.locked,
      audioEnabled: L.audioEnabled !== false,
      is3D,
      blendMode: BLEND[L.blendingMode ?? AE.blendingMode.NORMAL] ?? "normal",
      transform: this.transform(L, where, is3D),
      masks,
      effects,
    };
    if (L.parentIndex) layer.parentId = idOf(L.parentIndex);
    const tm = L.trackMatteType ?? AE.trackMatte.NO_TRACK_MATTE;
    if (tm !== AE.trackMatte.NO_TRACK_MATTE) {
      const mi = L.trackMatteLayerIndex ?? L.index - 1;
      if (comp.layers.some((x) => x.index === mi)) {
        layer.trackMatte = { layerId: idOf(mi), mode: tm === AE.trackMatte.ALPHA ? "alpha" : tm === AE.trackMatte.ALPHA_INVERTED ? "alpha-inverted" : tm === AE.trackMatte.LUMA ? "luma" : "luma-inverted" };
      } else this.note("missing", where, "The track matte layer wasn't found.");
    }
    if (L.label) layer.label = String(L.label);
    return layer as Layer;
  }

  run(): AeImportResult {
    const ae = this.ae;
    const name = (this.opts.sourceName ?? ae.projectName ?? "After Effects project").replace(/\.aepx?$/i, "");
    const base = emptyProject(name);
    for (const n of ae.notes ?? []) this.note("missing", "Project", n);
    const items = new Map<number, ItemRef>();
    const assets: Record<Id, Asset> = {};
    let media = 0;
    let mediaMissing = 0;
    const folders = ae.items.filter((i) => i.itemType === "FolderItem").length;
    if (folders) this.note("approximated", "Project", `${folders} project folder(s) aren't used in Before Effects; every item keeps its name.`);

    for (const it of ae.items) {
      if (it.itemType === "CompItem") {
        items.set(it.id, { kind: "comp", id: `comp_ae${it.id}` });
        continue;
      }
      if (it.itemType !== "FootageItem") continue;
      const f = it as AeJsonFootage;
      const where = `Project › ${f.name}`;
      const st = f.mainSource?.sourceType;
      if (st === "SolidSource") {
        items.set(f.id, { kind: "solid", color: rgba(f.mainSource?.color), width: Math.round(f.width ?? 100), height: Math.round(f.height ?? 100) });
        continue;
      }
      const file = f.mainSource?.file ?? (st === "FileSource" ? "" : null);
      if (st === "PlaceholderSource" || file === null || file === undefined) {
        items.set(f.id, { kind: "placeholder", name: f.name });
        this.note("missing", where, "This was a placeholder (no media file) in After Effects.");
        continue;
      }
      media++;
      // Some exporters leave the file path out; the media is then imported by name, to relink.
      const resolved = file ? (this.opts.resolveMedia?.(file) ?? { path: file, missing: !!f.footageMissing }) : { path: f.name, missing: true };
      const still = !!f.mainSource?.isStill;
      const probe = file || f.name;
      const kind: AssetKind = AUDIO.test(probe) || (f.hasVideo === false && !!f.hasAudio) ? "audio" : VIDEO.test(probe) && !still ? "video" : IMAGE.test(probe) || still ? "image" : "video";
      if (kind === "image" && !still && IMAGE.test(probe)) this.note("approximated", where, "Image sequence imported as a single picture (image sequences come later).");
      const meta: { -readonly [K in keyof Asset["meta"]]: Asset["meta"][K] } = {};
      if (f.width) meta.width = Math.round(f.width);
      if (f.height) meta.height = Math.round(f.height);
      if (!still && f.duration && f.duration > 0) meta.duration = T(f.duration);
      if (!still && f.frameRate && f.frameRate > 0) meta.frameRate = aeFrameRate(f.frameRate);
      if (f.mainSource?.hasAlpha !== undefined) meta.hasAlpha = !!f.mainSource.hasAlpha;
      const asset: Asset = { id: `asset_ae${f.id}`, kind, name: f.name, path: resolved.path, meta, originalPath: file, ...(resolved.missing ? { missing: true } : {}) };
      if (resolved.missing) {
        mediaMissing++;
        this.note("missing", where, file ? `Media file not found: ${file}. Use “Find missing files…” to show it.` : "The export didn't include where this file is. Use “Find missing files…” to show it.");
      }
      assets[asset.id] = asset;
      items.set(f.id, { kind: "asset", asset });
    }

    const comps: Record<Id, Composition> = {};
    const order: Id[] = [];
    let layerCount = 0;
    const fidelity = { drawn: 0, approximated: 0, preservedNotDrawn: 0, notImported: 0 };
    for (const it of ae.items) {
      if (it.itemType !== "CompItem") continue;
      const c = it as AeJsonComp;
      const id = `comp_ae${c.id}`;
      const layers = [...(c.layers ?? [])].sort((a, b) => a.index - b.index);
      const idOf = (index: number): Id => `${id}_l${index}`;
      const out: Record<Id, Layer> = {};
      for (const L of layers) {
        const before = this.notes.length;
        try {
          const layer = this.layer(L, c, c.name, items, idOf);
          out[idOf(L.index)] = layer;
          layerCount++;
          const mine = this.notes.slice(before);
          const unsupportedKind = layer.source.kind === "null" && mine.some((n) => n.level === "not-imported" && /kind of layer/.test(n.text));
          if (layer.source.kind === "camera" || layer.source.kind === "light" || unsupportedKind) fidelity.preservedNotDrawn++;
          else if (mine.some((n) => n.level !== "exact")) fidelity.approximated++;
          else fidelity.drawn++;
        } catch (e) {
          this.note("not-imported", `${c.name} › ${L.name}`, `This layer couldn't be imported (${String((e as Error)?.message ?? e)}).`);
          fidelity.notImported++;
        }
      }
      for (const l of Object.values(out)) {
        if (l.parentId && !out[l.parentId]) {
          this.note("missing", `${c.name} › ${l.name}`, "Its parent layer wasn't found, so it isn't parented.");
          delete (l as { parentId?: Id }).parentId;
        }
        if (l.trackMatte && !out[l.trackMatte.layerId]) delete (l as { trackMatte?: unknown }).trackMatte;
      }
      if (c.pixelAspect && Math.abs(c.pixelAspect - 1) > 1e-3) this.note("approximated", c.name, `Non-square pixels (aspect ${c.pixelAspect}) are shown as square pixels.`);
      if (c.displayStartTime) this.note("approximated", c.name, "The timeline starts at 0 instead of the composition's custom start time.");
      if (c.motionBlur) this.note("not-imported", c.name, "Motion blur isn't supported yet.");
      if (c.renderer && c.renderer !== "ADBE Advanced 3d" && c.renderer !== "ADBE Calder") this.note("approximated", c.name, `The ${c.renderer === "ADBE Ernst" ? "Cinema 4D" : c.renderer} renderer isn't available; Before Effects renders flat.`);
      comps[id] = {
        id,
        name: c.name,
        width: Math.round(c.width),
        height: Math.round(c.height),
        frameRate: aeFrameRate(c.frameRate, c.frameDuration),
        duration: T(c.duration),
        background: rgba(c.bgColor),
        layerOrder: layers.filter((L) => out[idOf(L.index)]).map((L) => idOf(L.index)),
        layers: out,
        markers: (c.markers ?? []).map((m, i) => ({ id: `${id}_m${i}`, t: T(m.time), duration: T(m.duration ?? 0), label: m.comment ?? "", kind: "note" as const })),
        ...(c.workAreaDuration ? { workArea: { start: T(c.workAreaStart), end: T((c.workAreaStart ?? 0) + c.workAreaDuration) } } : {}),
      };
      order.push(id);
    }

    // The composition to open first: one that isn't nested in another, with the most layers.
    const nested = new Set(Object.values(comps).flatMap((c) => Object.values(c.layers).flatMap((l) => (l.source.kind === "comp" ? [l.source.compId] : []))));
    const rank = (ids: Id[]) => [...ids].sort((a, b) => Object.keys(comps[b]!.layers).length - Object.keys(comps[a]!.layers).length || comps[b]!.duration - comps[a]!.duration)[0] ?? null;
    const tops = order.filter((id) => !nested.has(id));
    const mainCompId = rank(tops) ?? rank(order);
    if (tops.length > 1 && mainCompId) this.note("exact", "Project", `${tops.length} top-level compositions. “${comps[mainCompId]!.name}” opens first; the others are available as scenes.`);
    if (!order.length) this.note("missing", "Project", "No compositions were found.");

    const project: Project = { ...base, assets, compositions: comps, compositionOrder: order, ...(mainCompId ? { mainCompId } : {}) };
    const report: AeImportReport = {
      sourceName: this.opts.sourceName ?? ae.projectName ?? name,
      route: this.opts.route ?? "aep-file",
      counts: { compositions: order.length, layers: layerCount, keyframes: this.keyframes, masks: this.masks, effects: this.effects, effectsRendered: this.effectsRendered, expressions: this.expressions, media, mediaMissing },
      layerFidelity: fidelity,
      notes: this.notes,
    };
    return { project, mainCompId, report };
  }
}

/** Multiply every value and keyframe of a numeric property. */
const scaleAnim = (p: AnimProp<number>, k: number): AnimProp<number> => ({
  ...p,
  value: p.value * k,
  ...(p.keyframes ? { keyframes: p.keyframes.map((f) => ({ ...f, v: f.v * k, ...(f.easeIn ? { easeIn: f.easeIn.map((e) => ({ ...e, speed: e.speed * k })) } : {}), ...(f.easeOut ? { easeOut: f.easeOut.map((e) => ({ ...e, speed: e.speed * k })) } : {}) })) } : {}),
});

const offsetPath = (p: PathValue, [dx, dy]: readonly [number, number]): PathValue => {
  if (!dx && !dy) return p;
  const out = [...p];
  const n = p[1] ?? 0;
  for (let i = 0; i < n; i++) {
    out[2 + i * 6] = p[2 + i * 6]! + dx;
    out[3 + i * 6] = p[3 + i * 6]! + dy;
  }
  return out;
};

const K = 0.5522847498;
const ellipsePath = (w: number, h: number): PathValue => {
  const rx = w / 2;
  const ry = h / 2;
  // Top, right, bottom, left — clockwise like After Effects.
  return packPath({
    closed: true,
    vertices: [
      { p: [0, -ry], in: [-rx * K, 0], out: [rx * K, 0] },
      { p: [rx, 0], in: [0, -ry * K], out: [0, ry * K] },
      { p: [0, ry], in: [rx * K, 0], out: [-rx * K, 0] },
      { p: [-rx, 0], in: [0, ry * K], out: [0, -ry * K] },
    ],
  });
};

const rectPath = (w: number, h: number, round: number): PathValue => {
  const x = w / 2;
  const y = h / 2;
  const r = Math.min(round, x, y);
  if (r <= 0) return packPath({ closed: true, vertices: [{ p: [x, -y] }, { p: [x, y] }, { p: [-x, y] }, { p: [-x, -y] }] });
  const c = r * K;
  return packPath({
    closed: true,
    vertices: [
      { p: [x, -y + r], in: [0, -c] },
      { p: [x, y - r], out: [0, c] },
      { p: [x - r, y], in: [c, 0] },
      { p: [-x + r, y], out: [-c, 0] },
      { p: [-x, y - r], in: [0, c] },
      { p: [-x, -y + r], out: [0, -c] },
      { p: [-x + r, -y], in: [-c, 0] },
      { p: [x - r, -y], out: [c, 0] },
    ],
  });
};

const starPath = (n: number, outer: number, inner: number, rotDeg: number, star: boolean): PathValue => {
  const pts: [number, number][] = [];
  const count = star ? n * 2 : n;
  for (let i = 0; i < count; i++) {
    const r = star && i % 2 === 1 ? inner : outer;
    const a = ((rotDeg - 90) * Math.PI) / 180 + (i * 2 * Math.PI) / count;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return packPath({ closed: true, vertices: pts.map((p) => ({ p })) });
};

export const importAeProject = (ae: AeJsonProject, opts: AeImportOptions = {}): AeImportResult => new Importer(ae, opts).run();

