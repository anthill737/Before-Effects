/**
 * Fluid simulations (smoke and water) as layer content.
 *
 * A simulation layer holds plain settings: what it is, where it comes from (emitters, usually
 * regions of the building), what holds it in (containers), a few forces and a look. The engine
 * simulates it frame by frame in order ("preparing"), stores every frame on disk, and preview and
 * export both read those frames, so they always match and any frame can be shown instantly.
 *
 * Results are reproducible: a fixed time step, seeded randomness (the same PCG hash as everywhere
 * else) and a deterministic GPU solver mean the same settings give the same frames on this PC.
 * The cache key changes whenever anything that affects the result changes (settings, the shapes of
 * the regions used, the composition's size or frame rate), so stale frames are never shown as
 * current.
 */
import type { PathData, PathSource, Project, RGBA, Id, Composition } from "./model.ts";
import type { Flicks, Rational } from "./time.ts";

/** Bump when the solver changes in a way that changes its output (invalidates every cache). */
export const SIM_ENGINE_VERSION = 6;

export interface SimEmitter {
  /** Where it comes from: a region (through bindings) or a drawn path. */
  readonly source: PathSource;
  /** Which part of the shape emits: its top band (pouring), bottom band (rising) or all of it. */
  readonly band: "top" | "bottom" | "whole";
  /** How much comes out (0..100). */
  readonly amount: number;
  /** Initial push in px per second (x right, y down). */
  readonly velocity: readonly [number, number];
  /** Emission window in seconds from the start of the simulation; `to` omitted = until the end. */
  readonly from?: number;
  readonly to?: number;
}

export interface SimSettings {
  readonly type: "smoke" | "water";
  readonly seed: number;
  /** Grid detail: cells along the long side are 160 (draft), 256 (normal), 384 (high). */
  readonly quality: "draft" | "normal" | "high";
  readonly emitters: readonly SimEmitter[];
  /** Water only: it stays inside these shapes (everything else is solid). Empty = open space. */
  readonly containers: readonly PathSource[];
  /** Seconds simulated before the layer starts, so smoke is already present at the first frame. */
  readonly preroll: number;
  readonly forces: {
    /** Smoke: how strongly warm smoke rises (0..100). */
    readonly rise: number;
    /** Water: gravity strength (0..100, 50 ≈ real-world look). */
    readonly gravity: number;
    /** Steady wind in px per second. */
    readonly wind: readonly [number, number];
    /** Curling detail (0..100). */
    readonly swirl: number;
    /** Random gusts (0..100). */
    readonly turbulence: number;
    /** Smoke: seconds it takes to fade away. */
    readonly linger: number;
  };
  readonly look: {
    readonly color: RGBA;
    /** Smoke: colour where it is densest / water: highlight colour. */
    readonly color2: RGBA;
    /** 0..100 */
    readonly opacity: number;
    /** Glowing (added light) instead of covering — good for coloured smoke on dark facades. */
    readonly glow: boolean;
  };
}

export const defaultSmoke = (source: PathSource): SimSettings => ({
  type: "smoke",
  seed: 1,
  quality: "normal",
  emitters: [{ source, band: "bottom", amount: 60, velocity: [0, -40] }],
  containers: [],
  preroll: 1,
  forces: { rise: 55, gravity: 0, wind: [0, 0], swirl: 45, turbulence: 30, linger: 3 },
  look: { color: [0.92, 0.94, 1, 1], color2: [1, 1, 1, 1], opacity: 85, glow: false },
});

export const defaultWater = (source: PathSource): SimSettings => ({
  type: "water",
  seed: 1,
  quality: "normal",
  emitters: [{ source, band: "top", amount: 60, velocity: [0, 60] }],
  containers: [source],
  preroll: 0,
  forces: { rise: 0, gravity: 50, wind: [0, 0], swirl: 0, turbulence: 10, linger: 0 },
  look: { color: [0.16, 0.5, 0.95, 1], color2: [0.85, 0.95, 1, 1], opacity: 90, glow: false },
});

/** Grid size for a domain: the long side gets the quality's cell count. */
export const simGrid = (width: number, height: number, quality: SimSettings["quality"]): { nx: number; ny: number; cell: number } => {
  const long = quality === "draft" ? 160 : quality === "high" ? 384 : 256;
  const cell = Math.max(width, height) / long;
  return { nx: Math.max(8, Math.round(width / cell)), ny: Math.max(8, Math.round(height / cell)), cell };
};

/** A simulation with every shape resolved to composition space, ready for the solver. */
export interface ResolvedSim {
  readonly settings: SimSettings;
  readonly width: number;
  readonly height: number;
  readonly frameRate: Rational;
  /** Number of frames to simulate (layer length + preroll). */
  readonly frames: number;
  /** Frames simulated before the layer's first visible frame. */
  readonly prerollFrames: number;
  readonly emitters: ReadonlyArray<{ readonly paths: readonly PathData[]; readonly emitter: SimEmitter }>;
  readonly containers: readonly PathData[];
  /** Cache identity: changes whenever anything affecting the frames changes. */
  readonly key: string;
}

/** Deterministic JSON (sorted keys, fixed number formatting) for hashing. */
export const stableJson = (v: unknown): string => {
  if (v === null || typeof v !== "object") return typeof v === "number" ? (Number.isFinite(v) ? String(Math.round(v * 1e4) / 1e4) : "0") : JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  return `{${Object.keys(v as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
};

/** 64-bit FNV-1a as two 32-bit halves, hex. */
export const simHash = (s: string): string => {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
};

export const resolveSim = (
  settings: SimSettings,
  comp: Pick<Composition, "width" | "height" | "frameRate">,
  layerDuration: Flicks,
  resolvePaths: (src: PathSource) => PathData[],
): ResolvedSim => {
  const fps = comp.frameRate.num / comp.frameRate.den;
  const prerollFrames = Math.max(0, Math.round(settings.preroll * fps));
  const frames = Math.max(1, Math.ceil((layerDuration / 705_600_000) * fps)) + prerollFrames;
  const emitters = settings.emitters.map((emitter) => ({ emitter, paths: resolvePaths(emitter.source) }));
  const containers = settings.containers.flatMap((c) => resolvePaths(c));
  const key = simHash(
    stableJson({ v: SIM_ENGINE_VERSION, s: { ...settings, emitters: settings.emitters.map((e) => ({ ...e, source: null })), containers: null }, w: comp.width, h: comp.height, r: comp.frameRate, frames, emitters: emitters.map((e) => e.paths), containers }),
  );
  return { settings, width: comp.width, height: comp.height, frameRate: comp.frameRate, frames, prerollFrames, emitters, containers, key };
};

/** Every simulation layer in the project (for preparing caches and status). */
export const simulationLayers = (p: Project): Array<{ compId: Id; layerId: Id }> =>
  Object.values(p.compositions).flatMap((c) => Object.values(c.layers).filter((l) => l.source.kind === "simulation").map((l) => ({ compId: c.id, layerId: l.id })));
