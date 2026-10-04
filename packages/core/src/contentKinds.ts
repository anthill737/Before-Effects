/**
 * What kinds of content a scene's frames draw (2D layers, 3D scenes, simulations, track mattes,
 * adjustment layers, blend modes beyond the basic four), from the layers on at each frame — nested
 * scenes included. Used to keep prepared frames when the app changes how only some kinds draw.
 */
import type { Composition, Id, Project } from "./model.ts";
import { type Flicks, frameToTime, timeToFrame } from "./time.ts";

export type ContentKind = "2d" | "3d" | "simulation" | "track-matte" | "adjustment" | "blend-mode";

/** Blend modes drawn the same way since the first builds (mixing light in hardware). */
const BASIC_BLENDS = new Set(["normal", "add", "screen", "multiply"]);

const visit = (project: Project, comp: Composition, t: Flicks, depth: number, out: Set<ContentKind>) => {
  if (depth > 32) return;
  const anySolo = comp.layerOrder.some((id) => comp.layers[id]?.solo);
  const mattes = new Set(comp.layerOrder.map((id) => comp.layers[id]?.trackMatte?.layerId).filter((x): x is Id => !!x));
  for (const id of comp.layerOrder) {
    const l = comp.layers[id];
    if (!l || !l.enabled || (anySolo && !l.solo) || !(l.inPoint <= t && t < l.outPoint)) continue;
    const k = l.source.kind;
    if (k === "null" || k === "audio") continue;
    if (l.trackMatte || mattes.has(l.id)) out.add("track-matte");
    if (!BASIC_BLENDS.has(l.blendMode)) out.add("blend-mode");
    if (k === "scene3d") out.add("3d");
    else if (k === "simulation") out.add("simulation");
    else if (k === "adjustment") out.add("adjustment");
    else if (k === "comp") {
      const nested = project.compositions[l.source.compId];
      if (nested) visit(project, nested, Math.round((t - l.startTime) * l.stretch), depth + 1, out);
    } else out.add("2d");
  }
};

/** The kinds of content drawn at a composition time. */
export const contentAt = (project: Project, compId: Id, t: Flicks): Set<ContentKind> => {
  const out = new Set<ContentKind>();
  const comp = project.compositions[compId];
  if (comp) visit(project, comp, t, 0, out);
  return out;
};

/** The frames of a composition (half-open ranges) that draw any of `kinds`. */
export const framesUsing = (project: Project, compId: Id, kinds: ReadonlySet<ContentKind>): Array<[number, number]> => {
  const comp = project.compositions[compId];
  if (!comp) return [];
  // The frames a preview prepares (see preview/prepare.ts): 0 … the one holding the last instant.
  const frames = Math.max(1, timeToFrame(comp.duration - 1, comp.frameRate) + 1);
  const out: Array<[number, number]> = [];
  for (let f = 0; f < frames; f++) {
    const uses = contentAt(project, compId, frameToTime(f, comp.frameRate));
    if (![...uses].some((k) => kinds.has(k))) continue;
    const last = out[out.length - 1];
    if (last && last[1] === f) last[1] = f + 1;
    else out.push([f, f + 1]);
  }
  return out;
};
