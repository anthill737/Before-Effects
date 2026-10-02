/**
 * Field-by-field comparison of readAep output with After Effects' own export of the same project
 * (ExtendScript JSON) and with py_aep oracle values for paths and text. Used by the corpus script
 * (compare.ts) and the unit tests.
 */

import type { AeJsonComp, AeJsonFootage, AeJsonItem, AeJsonKeyframe, AeJsonLayer, AeJsonProject, AeJsonProperty } from "@be/core";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---- statistics ---------------------------------------------------------------------------------

export interface Stat {
  ok: number;
  total: number;
  examples: string[];
  files: Set<string>;
}
const stats = new Map<string, Stat>();
let currentFile = "";
let maxExamples = 6;

/** Start a fresh tally (`examples` = how many mismatch descriptions to keep per field). */
export function resetStats(examples = 6): void {
  stats.clear();
  maxExamples = examples;
}
/** Name used in mismatch descriptions. */
export function setFile(name: string): void {
  currentFile = name;
}
export function getStats(): ReadonlyMap<string, Stat> {
  return stats;
}

export function record(field: string, ok: boolean, detail?: () => string): void {
  let s = stats.get(field);
  if (!s) stats.set(field, (s = { ok: 0, total: 0, examples: [], files: new Set() }));
  s.total++;
  if (ok) s.ok++;
  else {
    s.files.add(currentFile);
    if (s.examples.length < maxExamples && detail) s.examples.push(`${currentFile}: ${detail()}`);
  }
}

const fmt = (v: unknown): string => {
  const s = JSON.stringify(v, (_k, x) => (typeof x === "number" ? Math.round(x * 1e6) / 1e6 : x));
  return s === undefined ? "undefined" : s.length > 160 ? s.slice(0, 157) + "…" : s;
};

function numClose(a: number, b: number, rel = 1e-4): boolean {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));
}

function close(a: unknown, b: unknown, rel = 1e-4): boolean {
  if (typeof a === "number" && typeof b === "number") return numClose(a, b, rel);
  if (typeof a === "boolean" || typeof b === "boolean") return Boolean(a) === Boolean(b) && typeof a === typeof b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => close(x, b[i], rel));
  if (a === null || a === undefined) return b === null || b === undefined;
  return a === b;
}

function cmp(field: string, ours: unknown, gt: unknown, where: string, rel = 1e-4): void {
  record(field, close(ours, gt, rel), () => `${where}: ours=${fmt(ours)} gt=${fmt(gt)}`);
}

// ---- items --------------------------------------------------------------------------------------

export function compareProject(ours: AeJsonProject, gt: Json): void {
  if (gt.bitsPerChannel !== undefined) cmp("project.bitsPerChannel", ours.bitsPerChannel, gt.bitsPerChannel, "project");
  const byId = new Map<number, AeJsonItem>(ours.items.map((i) => [i.id, i]));
  for (const g of gt.items as Json[]) {
    const o = byId.get(g.id);
    record("item.present", !!o, () => `item ${g.id} “${g.name}” (${g.itemType}) missing`);
    if (!o) continue;
    const w = `item ${g.id} “${g.name}”`;
    cmp("item.name", o.name, g.name, w);
    cmp("item.itemType", o.itemType, g.itemType, w);
    cmp("item.parentFolderId", o.parentFolderId ?? null, g.parentFolderId ?? null, w);
    cmp("item.label", o.label, g.label, w);
    cmp("item.comment", o.comment ?? "", g.comment ?? "", w);
    if (g.itemType === "FootageItem" && o.itemType === "FootageItem") compareFootage(o, g, w);
    if (g.itemType === "CompItem" && o.itemType === "CompItem") compareComp(o, g, w);
  }
  record("item.count", ours.items.length === gt.items.length, () => `ours ${ours.items.length} gt ${gt.items.length}`);
}

function compareFootage(o: AeJsonFootage, g: Json, w: string): void {
  for (const f of ["width", "height", "duration", "frameRate", "pixelAspect", "hasAudio", "hasVideo", "footageMissing"] as const) {
    if (g[f] !== undefined) cmp(`footage.${f}`, o[f], g[f], w);
  }
  const gm = g.mainSource;
  if (!gm) return;
  const om = o.mainSource ?? {};
  cmp("footage.mainSource.sourceType", om.sourceType, gm.sourceType, w);
  if (gm.sourceType === "SolidSource") cmp("footage.mainSource.color", om.color, gm.color, w);
  if (gm.sourceType === "FileSource") cmp("footage.mainSource.file", om.file ?? null, gm.filePath ?? null, w);
  if (gm.isStill !== undefined) cmp("footage.mainSource.isStill", om.isStill, gm.isStill, w);
  if (gm.hasAlpha !== undefined) cmp("footage.mainSource.hasAlpha", om.hasAlpha, gm.hasAlpha, w);
  if (gm.loop !== undefined) cmp("footage.mainSource.loop", om.loop, gm.loop, w);
}

function compareMarkers(field: string, ours: readonly Json[] | undefined, gt: readonly Json[] | undefined, w: string): void {
  const o = ours ?? [];
  const g = gt ?? [];
  record(`${field}.count`, o.length === g.length, () => `${w}: ours ${o.length} gt ${g.length}`);
  g.forEach((m, i) => {
    const om = o[i];
    if (!om) return;
    cmp(`${field}.time`, om.time, m.time, `${w} marker ${i + 1}`);
    cmp(`${field}.duration`, om.duration ?? 0, m.duration ?? 0, `${w} marker ${i + 1}`);
    cmp(`${field}.comment`, om.comment ?? "", m.comment ?? "", `${w} marker ${i + 1}`);
    cmp(`${field}.label`, om.label ?? 0, m.label ?? 0, `${w} marker ${i + 1}`);
  });
}

function compareComp(o: AeJsonComp, g: Json, w: string): void {
  for (const f of ["width", "height", "frameRate", "frameDuration", "duration", "pixelAspect", "bgColor", "workAreaStart", "workAreaDuration", "displayStartTime", "motionBlur", "frameBlending", "renderer"] as const) {
    if (g[f] !== undefined) cmp(`comp.${f}`, o[f], g[f], w);
  }
  if (g.markers) compareMarkers("comp.markers", o.markers, g.markers, w);
  const gl = (g.layers ?? []) as Json[];
  record("comp.layerCount", o.layers.length === gl.length, () => `${w}: ours ${o.layers.length} gt ${gl.length}`);
  gl.forEach((L, i) => {
    const ol = o.layers[i];
    if (ol) compareLayer(ol, L, `${w} › layer ${L.index} “${L.name}”`);
  });
}

// ---- layers -------------------------------------------------------------------------------------

const LAYER_FIELDS = [
  "name",
  "layerType",
  "matchName",
  "startTime",
  "inPoint",
  "outPoint",
  "stretch",
  "enabled",
  "solo",
  "locked",
  "shy",
  "audioEnabled",
  "blendingMode",
  "threeDLayer",
  "adjustmentLayer",
  "nullLayer",
  "guideLayer",
  "trackMatteType",
  "timeRemapEnabled",
  "motionBlur",
  "collapseTransformation",
  "frameBlending",
  "label",
  "lightType",
] as const;

function compareLayer(o: AeJsonLayer, g: Json, w: string): void {
  cmp("layer.index", o.index, g.index, w);
  for (const f of LAYER_FIELDS) {
    if (g[f] === undefined || g[f] === null) continue;
    cmp(`layer.${f}`, o[f], g[f], w);
  }
  cmp("layer.comment", o.comment ?? "", g.comment ?? "", w);
  if (g.layerType === "AVLayer" || g.sourceId !== undefined) cmp("layer.sourceId", o.sourceId ?? null, g.sourceId ?? null, w);
  cmp("layer.parentIndex", o.parentIndex ?? null, g.parentIndex ?? null, w);
  if (g.properties) {
    const markerProp = (g.properties as Json[]).find((p) => p.matchName === "ADBE Marker");
    if (markerProp && markerProp.keyframes) {
      const gm = (markerProp.keyframes as Json[]).map((k) => ({ time: k.time, duration: k.value?.duration ?? 0, comment: k.value?.comment ?? "", label: k.value?.label ?? 0 }));
      compareMarkers("layer.markers", o.markers, gm, w);
    }
    compareProps(o.properties ?? [], g.properties, w, 0);
  }
}

// ---- properties ---------------------------------------------------------------------------------

const keyOf = (mn: string, n: number) => `${mn}#${n}`;

function indexChildren<T extends { matchName: string }>(list: readonly T[]): Map<string, T> {
  const seen = new Map<string, number>();
  const out = new Map<string, T>();
  for (const p of list) {
    const n = (seen.get(p.matchName) ?? 0) + 1;
    seen.set(p.matchName, n);
    out.set(keyOf(p.matchName, n), p);
  }
  return out;
}

const isGroupGt = (g: Json) => g.propertyType === "PropertyGroup" || Array.isArray(g.properties);

function compareProps(ours: readonly AeJsonProperty[], gt: readonly Json[], w: string, depth: number): void {
  const om = indexChildren(ours);
  const gm = indexChildren(gt as { matchName: string }[]);
  for (const [k, g] of gm) {
    // Markers are compared as layer.markers; the reader doesn't repeat them as a property.
    if (depth === 0 && k === "ADBE Marker#1") continue;
    const o = om.get(k);
    const pw = `${w} › ${k}`;
    // Layer Styles' default children are deliberately not synthesised (they're not imported).
    const field = depth === 0 ? "prop.present.top" : pw.includes("ADBE Layer Styles") ? "prop.present.layerStyles" : "prop.present";
    record(field, !!o, () => `${pw} missing`);
    if (!o) continue;
    compareProp(o, g as Json, pw, depth);
  }
  for (const [k] of om) if (!gm.has(k)) record("prop.extra(ours only)", false, () => `${w} › ${k}`);
}

function compareProp(o: AeJsonProperty, g: Json, w: string, depth: number): void {
  const group = isGroupGt(g);
  record("prop.kind", group === (o.propertyType === "IndexedGroup" || o.propertyType === "NamedGroup"), () => `${w}: ours ${o.propertyType} gt ${g.propertyType}`);
  if (g.name !== undefined) cmp("prop.name", o.name, g.name, w);
  if (group) {
    if (g.enabled !== undefined) cmp("prop.group.enabled", o.enabled ?? true, g.enabled, w);
    if (g.maskMode !== undefined) cmp("prop.mask.maskMode", o.maskMode, g.maskMode, w);
    if (g.inverted !== undefined) cmp("prop.mask.inverted", o.inverted, g.inverted, w);
    compareProps(o.properties ?? [], g.properties ?? [], w, depth + 1);
    return;
  }
  if (g.propertyValueType !== undefined) cmp("prop.propertyValueType", o.propertyValueType, g.propertyValueType, w);
  const gExpr = g.expression ?? "";
  cmp("prop.expression", o.expression ?? "", gExpr, w);
  if (gExpr) cmp("prop.expressionEnabled", o.expressionEnabled ?? false, g.expressionEnabled, w);
  if (g.matchName === "ADBE Position" && g.dimensionsSeparated !== undefined) cmp("prop.dimensionsSeparated", o.dimensionsSeparated ?? false, g.dimensionsSeparated, w);
  if (g.isSeparationFollower) cmp("prop.isSeparationFollower", o.isSeparationFollower ?? false, true, w);

  const gk = (g.keyframes ?? []) as Json[];
  const ok = (o.keyframes ?? []) as AeJsonKeyframe[];
  const animated = gk.length > 0;
  // Markers are reported as layer/comp `markers`, not as keyframes.
  if (g.propertyValueType !== 6420) record("kf.count", ok.length === gk.length, () => `${w}: ours ${ok.length} gt ${gk.length}`);

  // Static value (AE reports the evaluated value; skip where an expression or animation drives it).
  if (!animated && !(g.expressionEnabled && gExpr)) {
    if (g.shapeValue) compareShape("value.shape(gt)", o.value, g.shapeValue, w);
    else if (g.textDocument) compareText("value.text(gt)", o.value, g.textDocument, w);
    else if (typeof g.value === "number" || (Array.isArray(g.value) && g.value.every((x: unknown) => typeof x === "number"))) {
      const field = depth === 1 && w.includes("ADBE Transform Group") ? "value.transform" : "value.other";
      cmp(field, o.value, g.value, w);
    }
  }
  if (animated && ok.length === gk.length) {
    gk.forEach((k, i) => compareKey(ok[i]!, k, `${w} key ${i + 1}`, g));
  }
}

function compareKey(o: AeJsonKeyframe, g: Json, w: string, prop: Json): void {
  cmp("kf.time", o.time, g.time, w, 1e-6);
  if (prop.propertyValueType === 6423) {
    if (g.value && typeof g.value === "object" && g.value.vertices) compareShape("kf.value.shape(gt)", o.value, g.value, w);
  } else if (typeof g.value === "number" || (Array.isArray(g.value) && g.value.every((x: unknown) => typeof x === "number"))) cmp("kf.value", o.value, g.value, w);
  cmp("kf.inInterpolationType", o.inInterpolationType, g.inInterpolationType, w);
  cmp("kf.outInterpolationType", o.outInterpolationType, g.outInterpolationType, w);
  const ease = (field: string, oe: readonly { speed: number; influence: number }[] | undefined, ge: Json[] | undefined) => {
    if (!ge) return;
    const oo = oe ?? [];
    record(`${field}.length`, oo.length === ge.length, () => `${w}: ours ${fmt(oo)} gt ${fmt(ge)}`);
    if (oo.length !== ge.length) return;
    cmp(`${field}.speed`, oo.map((e) => e.speed), ge.map((e) => e.speed), w, 1e-3);
    cmp(`${field}.influence`, oo.map((e) => e.influence), ge.map((e) => e.influence), w, 1e-3);
  };
  ease("kf.inTemporalEase", o.inTemporalEase, g.inTemporalEase);
  ease("kf.outTemporalEase", o.outTemporalEase, g.outTemporalEase);
  if (g.inSpatialTangent !== undefined) {
    cmp("kf.inSpatialTangent", o.inSpatialTangent, g.inSpatialTangent, w, 1e-3);
    cmp("kf.outSpatialTangent", o.outSpatialTangent, g.outSpatialTangent, w, 1e-3);
    cmp("kf.spatialAutoBezier", o.spatialAutoBezier ?? false, g.spatialAutoBezier, w);
    cmp("kf.spatialContinuous", o.spatialContinuous ?? false, g.spatialContinuous, w);
    cmp("kf.roving", o.roving ?? false, g.roving, w);
  }
  if (g.temporalAutoBezier !== undefined) cmp("kf.temporalAutoBezier", o.temporalAutoBezier ?? false, g.temporalAutoBezier, w);
  if (g.temporalContinuous !== undefined) cmp("kf.temporalContinuous", o.temporalContinuous ?? false, g.temporalContinuous, w);
}

function compareShape(field: string, o: unknown, g: Json, w: string): void {
  const s = o as { closed?: boolean; vertices?: number[][]; inTangents?: number[][]; outTangents?: number[][] } | undefined;
  if (!s || !Array.isArray(s.vertices)) {
    record(field, false, () => `${w}: ours has no path`);
    return;
  }
  const ok = s.closed === g.closed && close(s.vertices, g.vertices, 1e-3) && close(s.inTangents, g.inTangents, 1e-3) && close(s.outTangents, g.outTangents, 1e-3);
  record(field, ok, () => `${w}: ours=${fmt(s)} gt=${fmt({ closed: g.closed, vertices: g.vertices, inTangents: g.inTangents, outTangents: g.outTangents })}`);
}

const TEXT_FIELDS = ["text", "font", "fontSize", "applyFill", "fillColor", "applyStroke", "strokeColor", "strokeWidth", "justification", "tracking", "leading", "fauxBold", "fauxItalic", "allCaps", "boxText", "boxTextSize"];

function compareText(field: string, o: unknown, g: Json, w: string): void {
  const t = o as Record<string, unknown> | undefined;
  if (!t || typeof t.text !== "string") {
    record(`${field}.present`, false, () => `${w}: ours has no text document`);
    return;
  }
  record(`${field}.present`, true);
  for (const f of TEXT_FIELDS) {
    let gv = g[f];
    if (gv === undefined) continue;
    if (f === "strokeColor" && !g.applyStroke) continue;
    if (f === "boxTextSize" && !g.boxText) continue;
    if (f === "text" && typeof gv === "string") gv = gv.replace(/\n/g, "\r");
    cmp(`${field}.${f}`, t[f], gv, w, 1e-4);
  }
}

// ---- oracle (py_aep) ----------------------------------------------------------------------------

function propAt(layer: AeJsonLayer, path: string[]): AeJsonProperty | undefined {
  let list: readonly AeJsonProperty[] = layer.properties ?? [];
  let node: AeJsonProperty | undefined;
  for (const k of path) {
    node = indexChildren(list).get(k);
    if (!node) return undefined;
    list = node.properties ?? [];
  }
  return node;
}

export function compareOracle(ours: AeJsonProject, entries: Json[]): void {
  const comps = new Map<number, AeJsonComp>();
  for (const i of ours.items) if (i.itemType === "CompItem") comps.set(i.id, i);
  for (const e of entries) {
    const layer = comps.get(e.comp)?.layers[e.layer - 1];
    const w = `comp ${e.comp} layer ${e.layer} ${(e.path as string[]).join(" › ")}`;
    const p = layer ? propAt(layer, e.path) : undefined;
    const kind = e.kind === "keys" ? "keyframes" : e.kind === "shape" ? (e.path.some((s: string) => s.startsWith("ADBE Mask")) ? "mask" : "shapeLayer") : "text";
    record(`oracle.${kind}.property`, !!p, () => `${w} missing`);
    if (!p) continue;
    if (e.kind === "keys") {
      const ok = p.keyframes ?? [];
      record("oracle.keyframes.count", ok.length === e.keyframes.length, () => `${w}: ours ${ok.length} py ${e.keyframes.length}`);
      if (ok.length === e.keyframes.length) (e.keyframes as Json[]).forEach((k, i) => compareOracleKey(ok[i]!, k, `${w} key ${i + 1}`));
      continue;
    }
    const vals: Json[] = e.keyframes ?? [e.value];
    const ours2: unknown[] = e.keyframes ? (p.keyframes ?? []).map((k) => k.value) : [p.value];
    record(`oracle.${kind}.count`, vals.length === ours2.length, () => `${w}: ours ${ours2.length} py ${vals.length}`);
    vals.forEach((v, i) => {
      if (v === null || v === undefined) return;
      if (e.kind === "shape") compareShape(`oracle.${kind}`, ours2[i], v, `${w} #${i}`);
      else compareText(`oracle.text`, ours2[i], v, `${w} #${i}`);
    });
  }
}

function compareOracleKey(o: AeJsonKeyframe, g: Json, w: string): void {
  cmp("oracle.keyframes.time", o.time, g.time, w, 1e-6);
  cmp("oracle.keyframes.value", o.value, g.value, w);
  cmp("oracle.keyframes.interpolation", [o.inInterpolationType, o.outInterpolationType], [g.inInterpolationType, g.outInterpolationType], w);
  const flat = (e: readonly { speed: number; influence: number }[] | undefined) => (e ?? []).flatMap((x) => [x.speed, x.influence]);
  cmp("oracle.keyframes.ease", [flat(o.inTemporalEase), flat(o.outTemporalEase)], [flat(g.inTemporalEase), flat(g.outTemporalEase)], w, 1e-3);
  if (g.inSpatialTangent) cmp("oracle.keyframes.spatialTangents", [o.inSpatialTangent, o.outSpatialTangent], [g.inSpatialTangent, g.outSpatialTangent], w, 1e-3);
}

