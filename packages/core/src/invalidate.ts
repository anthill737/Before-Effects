/**
 * Which rendered frames does a change affect? Used by preview caches to invalidate only stale
 * frames after an edit, instead of throwing the whole cache away.
 *
 * Works from the operation's Immer patches. Content frames depend on the composition's layers,
 * nested compositions, venue regions/bindings, assets and colour settings. Projector calibration
 * affects only the projector view, which is redrawn from cached content every time.
 */
import type { Patch } from "immer";
import type { Composition, Id, Project } from "./model.ts";
import type { Flicks } from "./time.ts";

export interface Affected {
  /** True when every frame of the composition must be re-rendered. */
  readonly all: boolean;
  /** Half-open time ranges [start, end) that changed (when not `all`). */
  readonly ranges: ReadonlyArray<readonly [Flicks, Flicks]>;
}

const NONE: Affected = { all: false, ranges: [] };
const ALL: Affected = { all: true, ranges: [] };

/** Compositions nested (directly or indirectly) inside `compId`, including itself. */
const nestedComps = (p: Project, compId: Id, seen = new Set<Id>()): Set<Id> => {
  if (seen.has(compId)) return seen;
  seen.add(compId);
  const c = p.compositions[compId];
  if (c) for (const l of Object.values(c.layers)) if (l.source.kind === "comp") nestedComps(p, l.source.compId, seen);
  return seen;
};

const layerRange = (c: Composition | undefined, layerId: Id): readonly [Flicks, Flicks] | null => {
  const l = c?.layers[layerId];
  return l ? [l.inPoint, l.outPoint] : null;
};

/** True if other layers depend on this one (as parent or track matte), which widens the effect. */
const hasDependents = (c: Composition | undefined, layerId: Id): boolean =>
  !!c && Object.values(c.layers).some((l) => l.parentId === layerId || l.trackMatte?.layerId === layerId);

/**
 * Where a change inside a nested composition shows in `compId`: each layer that shows `nestedId`
 * (directly or through other nested compositions) maps the nested times onto its own timeline
 * (start + nested time ÷ speed), within the layer's in and out points. A nested change with no
 * known times (`all`) covers the whole span of those layers.
 */
const mapUp = (p: Project, compId: Id, nestedId: Id, inner: Affected, depth = 0): Array<readonly [Flicks, Flicks]> => {
  const out: Array<readonly [Flicks, Flicks]> = [];
  const c = p.compositions[compId];
  if (!c || depth > 32) return out;
  for (const l of Object.values(c.layers)) {
    if (l.source.kind !== "comp") continue;
    const src = l.source.compId;
    const at: Affected | null = src === nestedId ? inner : src !== compId && nestedComps(p, src).has(nestedId) ? { all: false, ranges: mapUp(p, src, nestedId, inner, depth + 1) } : null;
    if (!at) continue;
    if (at.all || !l.stretch) {
      out.push([l.inPoint, l.outPoint]);
      continue;
    }
    for (const [x0, x1] of at.ranges) {
      let a = l.startTime + x0 / l.stretch;
      let b = l.startTime + x1 / l.stretch;
      if (a > b) [a, b] = [b, a];
      // Rounding (and a reversed layer's flipped ends) can move a frame across the edge: one flick wider.
      const s = Math.max(l.inPoint, Math.floor(a) - 1);
      const e = Math.min(l.outPoint, Math.ceil(b) + 1);
      if (s < e) out.push([s, e]);
    }
  }
  return out;
};

export const affectedByPatches = (before: Project, after: Project, patches: readonly Patch[], compId: Id): Affected => {
  const ranges: Array<readonly [Flicks, Flicks]> = [];
  const used = new Set([...nestedComps(before, compId), ...nestedComps(after, compId)]);
  for (const patch of patches) {
    if (patch.path.length === 0) return ALL; // whole project replaced (selective undo)
    const [root, a, b, c] = patch.path as Array<string | number>;
    switch (root) {
      case "compositions": {
        if (a === undefined) return ALL;
        const id = String(a);
        if (id !== compId) {
          if (!used.has(id)) continue;
          // A nested composition changed: the times it changed, where this composition shows them.
          const inner = affectedByPatches(before, after, [patch], id);
          for (const proj of [before, after]) ranges.push(...mapUp(proj, compId, id, inner));
          continue;
        }
        if (b === undefined) return ALL;
        if (b === "layers") {
          if (c === undefined) return ALL;
          const lid = String(c);
          const cb = before.compositions[compId];
          const ca = after.compositions[compId];
          if (hasDependents(cb, lid) || hasDependents(ca, lid)) return ALL;
          const r0 = layerRange(cb, lid);
          const r1 = layerRange(ca, lid);
          if (r0) ranges.push(r0);
          if (r1) ranges.push(r1);
          continue;
        }
        if (b === "markers" || b === "name" || b === "workArea") continue;
        return ALL; // size, frame rate, duration, background, layer order
      }
      case "venues": {
        // Projector calibration and output settings don't change composition content.
        if (b === "projectors" || b === "projectorOrder" || b === "name") continue;
        return ALL;
      }
      case "scenes3d": {
        // A 3D scene changed: every layer showing it (here or in a nested composition) is stale.
        if (a === undefined) return ALL;
        const sid = String(a);
        for (const cid of used) {
          for (const proj of [before, after]) {
            const c = proj.compositions[cid];
            for (const l of Object.values(c?.layers ?? {})) {
              if (l.source.kind !== "scene3d" || l.source.sceneId !== sid) continue;
              const here: Affected = hasDependents(c, l.id) ? ALL : { all: false, ranges: [[l.inPoint, l.outPoint]] };
              if (cid !== compId) ranges.push(...mapUp(proj, compId, cid, here));
              else if (here.all) return ALL;
              else ranges.push(...here.ranges);
            }
          }
        }
        continue;
      }
      case "bindings":
      case "activeVenueId":
      case "assets":
      case "settings":
        return ALL;
      default:
        // name, recipes (their layers change separately), compositionOrder, mainCompId, …
        continue;
    }
  }
  return ranges.length ? { all: false, ranges: mergeRanges(ranges) } : NONE;
};

export const mergeRanges = (rs: ReadonlyArray<readonly [Flicks, Flicks]>): Array<readonly [Flicks, Flicks]> => {
  const sorted = [...rs].sort((x, y) => x[0] - y[0]);
  const out: Array<[Flicks, Flicks]> = [];
  for (const [s, e] of sorted) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
};
