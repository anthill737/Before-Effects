/**
 * Composition evaluation: (project, composition, time) → a plain render plan for the GPU engine.
 *
 * This is the shared evaluation semantics required for preview and export. Both call exactly this
 * function with exact flick times. It is pure and synchronous, so frames can be evaluated in any
 * order and on any worker.
 */
import { type AnimProp, evalProp, type PropertyEvalContext, type PropValue } from "./anim.ts";
import { layerMatrix, type Mat4, mat4Mul } from "./geometry.ts";
import type {
  BlendMode,
  Composition,
  Id,
  Layer,
  PathData,
  PathSource,
  Project,
  RegionRef,
  RGBA,
  Vec3,
} from "./model.ts";
import { unpackPath } from "./model.ts";
import { refRegions, regionFillPaths } from "./areas.ts";
import { type ResolvedSim, resolveSim, type SimSettings } from "./simulation.ts";
import { type Flicks, timeToFrame } from "./time.ts";
import { type ResolvedScene3D, resolveScene3D } from "./world3d.ts";

export interface EvaluatedMask {
  readonly id: Id;
  /** "comp": path is in composition pixels (region-derived); "layer": in the layer's own space. */
  readonly space: "comp" | "layer";
  readonly paths: readonly PathData[];
  readonly mode: "add" | "subtract" | "intersect" | "lighten" | "darken" | "difference" | "none";
  readonly inverted: boolean;
  readonly feather: number;
  readonly expansion: number;
  readonly opacity: number; // 0..1
}

export interface EvaluatedShape {
  /** Paths in layer space (region-derived paths are converted by the engine using `pathSpace`). */
  readonly paths: readonly PathData[];
  readonly pathSpace: "comp" | "layer";
  readonly fill?: { readonly color: RGBA; readonly opacity: number };
  readonly stroke?: {
    readonly color: RGBA;
    readonly width: number;
    readonly opacity: number;
    readonly cap: "butt" | "round" | "square";
    readonly join: "miter" | "round" | "bevel";
  };
  /** Normalised trim window, 0..1, offset already applied (may wrap). */
  readonly trim?: { readonly start: number; readonly end: number; readonly offset: number };
}

export type EvaluatedSource =
  | { readonly kind: "solid"; readonly color: RGBA; readonly width: number; readonly height: number }
  | { readonly kind: "shape"; readonly shapes: readonly EvaluatedShape[] }
  | { readonly kind: "footage"; readonly assetId: Id; readonly frame: number; readonly localTime: Flicks; readonly width: number; readonly height: number; readonly still: boolean }
  | {
      readonly kind: "text";
      readonly text: string;
      readonly font: string;
      readonly weight: number;
      readonly size: number;
      readonly color: RGBA;
      readonly align: "left" | "center" | "right";
      readonly lineHeight: number;
      readonly tracking: number;
      readonly stroke?: { readonly color: RGBA; readonly width: number };
    }
  | { readonly kind: "comp"; readonly comp: EvaluatedComp }
  /** `frame` is the layer-local frame (comp rate) used to look up prepared physics motion. */
  | { readonly kind: "scene3d"; readonly sceneId: Id; readonly localTime: Flicks; readonly resolved: ResolvedScene3D | null; readonly frame: number }
  /** `frame` counts from the start of the simulation (preroll included). */
  | { readonly kind: "simulation"; readonly sim: ResolvedSim; readonly frame: number }
  | { readonly kind: "adjustment" }
  | { readonly kind: "null" };

export interface EvaluatedEffect {
  readonly id: Id;
  readonly type: string;
  readonly params: Readonly<Record<string, PropValue>>;
}

export interface EvaluatedLayer {
  readonly id: Id;
  readonly name: string;
  readonly source: EvaluatedSource;
  /** Layer space → composition space. */
  readonly matrix: Mat4;
  readonly opacity: number; // 0..1
  readonly blendMode: BlendMode;
  readonly is3D: boolean;
  readonly masks: readonly EvaluatedMask[];
  readonly effects: readonly EvaluatedEffect[];
  readonly trackMatte?: { readonly layer: EvaluatedLayer; readonly mode: "alpha" | "alpha-inverted" | "luma" | "luma-inverted" };
}

export interface EvaluatedComp {
  readonly id: Id;
  readonly width: number;
  readonly height: number;
  readonly background: RGBA;
  readonly time: Flicks;
  /** Bottom-most first: the order layers are composited in. */
  readonly layers: readonly EvaluatedLayer[];
}

export interface EvaluateOptions {
  readonly props?: PropertyEvalContext;
  /** Venue whose bindings resolve region roles; defaults to the project's active venue. */
  readonly venueId?: Id;
  /** Guard against runaway nesting. */
  readonly maxDepth?: number;
}

const ev = <V extends PropValue>(p: AnimProp<V>, t: Flicks, o: EvaluateOptions): V => evalProp(p, t, o.props);

/** Resolve a region reference to region outlines through the venue binding. */
export const resolveRegionPaths = (project: Project, ref: RegionRef, venueId?: Id): PathData[] => {
  const vid = venueId ?? project.activeVenueId;
  const venue = vid ? project.venues[vid] : undefined;
  return refRegions(project, ref, venueId).flatMap((r) => regionFillPaths(r, venue));
};

const resolvePath = (
  project: Project,
  src: PathSource,
  t: Flicks,
  o: EvaluateOptions,
): { paths: PathData[]; space: "comp" | "layer" } =>
  src.kind === "region"
    ? { paths: resolveRegionPaths(project, src.ref, o.venueId), space: "comp" }
    : { paths: [unpackPath(ev(src.path, t, o))], space: "layer" };

const layerLocalTime = (l: Layer, t: Flicks): Flicks => Math.round((t - l.startTime) * l.stretch);

export const isLayerActiveAt = (l: Layer, t: Flicks): boolean => l.inPoint <= t && t < l.outPoint;

const localMatrix = (l: Layer, t: Flicks, o: EvaluateOptions): Mat4 => {
  const tr = l.transform;
  const pos = ev(tr.position, t, o);
  const sc = ev(tr.scale, t, o);
  const rot = ev(tr.rotation, t, o);
  const anc = ev(tr.anchor, t, o);
  // 2D layers ignore z components; 3D layers use them.
  const z = (v: Vec3, d: number): Vec3 => (l.is3D ? v : [v[0], v[1], d]);
  return layerMatrix(z(anc, 0), z(pos, 0), z(sc, 100), l.is3D ? rot : [0, 0, rot[2]]);
};

const worldMatrix = (comp: Composition, l: Layer, t: Flicks, o: EvaluateOptions, depth = 0): Mat4 => {
  const local = localMatrix(l, t, o);
  if (!l.parentId || depth > 64) return local;
  const parent = comp.layers[l.parentId];
  if (!parent) return local;
  return mat4Mul(worldMatrix(comp, parent, t, o, depth + 1), local);
};

/** Resolved simulations, memoised: settings objects are immutable, so identity tells when to re-resolve. */
const simMemo = new WeakMap<SimSettings, { venues: unknown; bindings: unknown; comp: string; venueId: string; res: ResolvedSim }>();
const resolvedSimFor = (project: Project, l: Layer, settings: SimSettings, comp: Composition, o: EvaluateOptions): ResolvedSim => {
  const compKey = `${comp.width}x${comp.height}@${comp.frameRate.num}/${comp.frameRate.den}:${l.outPoint - l.startTime}`;
  const venueId = o.venueId ?? project.activeVenueId ?? "";
  const hit = simMemo.get(settings);
  if (hit && hit.venues === project.venues && hit.bindings === project.bindings && hit.comp === compKey && hit.venueId === venueId) return hit.res;
  const res = resolveSim(settings, comp, l.outPoint - l.startTime, (src) => resolvePath(project, src, 0, o).paths);
  simMemo.set(settings, { venues: project.venues, bindings: project.bindings, comp: compKey, venueId, res });
  return res;
};

/** A simulation layer resolved for preparing (shapes in composition space, cache key), or null. */
export const resolveSimulationLayer = (project: Project, compId: Id, layerId: Id): ResolvedSim | null => {
  const comp = project.compositions[compId];
  const l = comp?.layers[layerId];
  if (!comp || !l || l.source.kind !== "simulation") return null;
  const venueId = comp.venueId ?? project.activeVenueId;
  return resolvedSimFor(project, l, l.source.sim, comp, venueId ? { venueId } : {});
};

/** A 3D layer's scene, resolved for its length (frames at the composition's rate). */
const scene3dFor = (project: Project, comp: Composition, l: Layer, sceneId: Id, venueOverride?: Id): { resolved: ResolvedScene3D | null; frames: number; fps: number } => {
  const fps = comp.frameRate.num / comp.frameRate.den;
  const frames = Math.max(1, Math.ceil(((Math.max(0, l.outPoint - l.startTime) * Math.abs(l.stretch)) / 705_600_000) * fps) + 1);
  const scene = project.scenes3d?.[sceneId];
  if (!scene) return { resolved: null, frames, fps };
  const venueId = venueOverride ?? comp.venueId ?? project.activeVenueId;
  const venue = venueId ? project.venues[venueId] : undefined;
  return { resolved: resolveScene3D(project, scene, { ...(venueId ? { venueId } : {}), canvas: venue?.canvas ?? { width: comp.width, height: comp.height }, fps, frames }), frames, fps };
};

/** Every 3D layer in the project (for preparing physics and status). */
export const scene3dLayers = (p: Project): Array<{ compId: Id; layerId: Id }> =>
  Object.values(p.compositions).flatMap((c) => Object.values(c.layers).filter((l) => l.source.kind === "scene3d").map((l) => ({ compId: c.id, layerId: l.id })));

export const resolveScene3DLayer = (project: Project, compId: Id, layerId: Id): ResolvedScene3D | null => {
  const comp = project.compositions[compId];
  const l = comp?.layers[layerId];
  if (!comp || !l || l.source.kind !== "scene3d") return null;
  return scene3dFor(project, comp, l, l.source.sceneId).resolved;
};

const evaluateSource = (
  project: Project,
  comp: Composition,
  l: Layer,
  t: Flicks,
  o: EvaluateOptions,
  depth: number,
): EvaluatedSource => {
  const s = l.source;
  const lt = layerLocalTime(l, t);
  switch (s.kind) {
    case "solid":
      return { kind: "solid", color: ev(s.color, t, o), width: s.width, height: s.height };
    case "shape":
      return {
        kind: "shape",
        shapes: s.contents.map((c): EvaluatedShape => {
          const { paths, space } = resolvePath(project, c.path, t, o);
          const trim = c.trim
            ? {
                start: Math.min(1, Math.max(0, ev(c.trim.start, t, o) / 100)),
                end: Math.min(1, Math.max(0, ev(c.trim.end, t, o) / 100)),
                offset: ev(c.trim.offset, t, o) / 360,
              }
            : undefined;
          return {
            paths,
            pathSpace: space,
            ...(c.fill ? { fill: { color: ev(c.fill.color, t, o), opacity: ev(c.fill.opacity, t, o) / 100 } } : {}),
            ...(c.stroke
              ? {
                  stroke: {
                    color: ev(c.stroke.color, t, o),
                    width: ev(c.stroke.width, t, o),
                    opacity: ev(c.stroke.opacity, t, o) / 100,
                    cap: c.stroke.cap,
                    join: c.stroke.join,
                  },
                }
              : {}),
            ...(trim ? { trim } : {}),
          };
        }),
      };
    case "footage": {
      const asset = project.assets[s.assetId];
      const rate = asset?.meta.frameRate;
      const still = asset?.kind === "image";
      const count = asset?.meta.frameCount;
      let frame = rate && !still ? timeToFrame(lt, rate) : 0;
      if (count && s.loop && frame >= count) frame = ((frame % count) + count) % count;
      if (count && frame >= count) frame = count - 1; // hold the last frame
      if (frame < 0) frame = 0;
      return { kind: "footage", assetId: s.assetId, frame, localTime: lt, width: asset?.meta.width ?? 0, height: asset?.meta.height ?? 0, still };
    }
    case "text": {
      const d = s.doc;
      return {
        kind: "text",
        text: d.text,
        font: d.font,
        weight: d.weight,
        size: ev(d.size, t, o),
        color: ev(d.color, t, o),
        align: d.align,
        lineHeight: d.lineHeight,
        tracking: d.tracking,
        ...(d.stroke ? { stroke: { color: ev(d.stroke.color, t, o), width: ev(d.stroke.width, t, o) } } : {}),
      };
    }
    case "comp": {
      const nested = project.compositions[s.compId];
      if (!nested || depth >= (o.maxDepth ?? 32)) return { kind: "null" };
      return { kind: "comp", comp: evaluateCompAt(project, nested, lt, o, depth + 1) };
    }
    case "scene3d": {
      const { resolved, frames, fps } = scene3dFor(project, comp, l, s.sceneId, o.venueId);
      const frame = Math.min(frames - 1, Math.max(0, Math.round((lt / 705_600_000) * fps)));
      return { kind: "scene3d", sceneId: s.sceneId, localTime: lt, resolved, frame };
    }
    case "adjustment":
      return { kind: "adjustment" };
    case "simulation": {
      const sim = resolvedSimFor(project, l, s.sim, comp, o);
      const fps = sim.frameRate.num / sim.frameRate.den;
      const frame = Math.min(sim.frames - 1, Math.max(0, Math.floor((lt / 705_600_000) * fps + 1e-6) + sim.prerollFrames));
      return { kind: "simulation", sim, frame };
    }
    case "null":
    case "camera":
    case "light":
    case "audio":
      return { kind: "null" };
  }
};

const evaluateLayer = (
  project: Project,
  comp: Composition,
  l: Layer,
  t: Flicks,
  o: EvaluateOptions,
  depth: number,
  withMatte: boolean,
): EvaluatedLayer => {
  const masks: EvaluatedMask[] = l.masks.map((m) => {
    const { paths, space } = resolvePath(project, m.source, t, o);
    // An area's own soft edge / growth applies wherever content is clipped to it; the mask adds to it.
    const area = m.source.kind === "region" ? refRegions(project, m.source.ref, o.venueId)[0] : undefined;
    return {
      id: m.id,
      space,
      paths,
      mode: m.mode,
      inverted: m.inverted,
      feather: Math.max(0, ev(m.feather, t, o) + (area?.feather ?? 0)),
      expansion: ev(m.expansion, t, o) + (area?.expansion ?? 0),
      opacity: ev(m.opacity, t, o) / 100,
    };
  });
  const effects: EvaluatedEffect[] = l.effects
    .filter((e) => e.enabled)
    .map((e) => ({
      id: e.id,
      type: e.type,
      params: Object.fromEntries(Object.entries(e.params).map(([k, p]) => [k, ev(p, t, o)])),
    }));
  const matteLayer = withMatte && l.trackMatte ? comp.layers[l.trackMatte.layerId] : undefined;
  return {
    id: l.id,
    name: l.name,
    source: evaluateSource(project, comp, l, t, o, depth),
    matrix: worldMatrix(comp, l, t, o),
    opacity: Math.min(1, Math.max(0, ev(l.transform.opacity, t, o) / 100)),
    blendMode: l.blendMode,
    is3D: l.is3D,
    masks,
    effects,
    ...(matteLayer && l.trackMatte
      ? { trackMatte: { layer: evaluateLayer(project, comp, matteLayer, t, o, depth, false), mode: l.trackMatte.mode } }
      : {}),
  };
};

export const evaluateCompAt = (
  project: Project,
  comp: Composition,
  t: Flicks,
  o: EvaluateOptions = {},
  depth = 0,
): EvaluatedComp => {
  const anySolo = comp.layerOrder.some((id) => comp.layers[id]?.solo);
  const layers: EvaluatedLayer[] = [];
  // layerOrder is top-first; composite bottom-up.
  for (let i = comp.layerOrder.length - 1; i >= 0; i--) {
    const l = comp.layers[comp.layerOrder[i]!];
    if (!l) continue;
    if (!l.enabled || (anySolo && !l.solo) || !isLayerActiveAt(l, t)) continue;
    if (l.source.kind === "null" || l.source.kind === "audio") continue;
    layers.push(evaluateLayer(project, comp, l, t, o, depth, true));
  }
  return { id: comp.id, width: comp.width, height: comp.height, background: comp.background, time: t, layers };
};

export const evaluateComp = (project: Project, compId: Id, t: Flicks, o: EvaluateOptions = {}): EvaluatedComp => {
  const comp = project.compositions[compId];
  if (!comp) throw new Error(`Composition ${compId} not found`);
  return evaluateCompAt(project, comp, t, o);
};
