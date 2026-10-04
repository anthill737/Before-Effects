/**
 * What each frame of a composition is made from, as a short signature. Two frames with the same
 * signature — in this version of the show or any other (an earlier save, unsaved edits, a recovered
 * copy, a copy saved under another name) — draw the same, so prepared frames on disk are kept by
 * signature and reused wherever it matches; a frame whose inputs differ has another signature, so a
 * stale frame is never found for it.
 *
 * A frame at time t is made from:
 *   - the composition's own settings (size, frame rate, background, … — not its name, markers or work
 *     area), and which layers are solo;
 *   - each layer on at t (from its in point to its out point; sounds don't draw), in stacking order:
 *     everything about the layer, the layers it refers to (its parent, its track matte, anything else
 *     naming another layer of the composition — and theirs), the 3D scenes it shows, the pictures,
 *     video and models it uses (named anywhere in it or its 3D scenes), and a nested composition's own
 *     frame at the layer's time;
 *   - the building (venue: its areas, photo, …; not its projectors), the area bindings and the
 *     show's colour settings;
 *   - the time itself (effects can change over time on their own).
 *
 * These are the dependencies the edit-by-edit invalidation follows (invalidate.ts), at the same or a
 * finer grain: a layer added or moved changes only the frames it's on, and a picture or sound only the
 * frames that use it.
 */
import { layerLocalTime } from "./evaluate.ts";
import type { Composition, Id, Layer, Project } from "./model.ts";
import { type Flicks, frameToTime } from "./time.ts";

/** JSON with sorted keys and exact numbers: the same data always gives the same text. */
const exactJson = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(exactJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${exactJson(o[k])}`)
    .join(",")}}`;
};

/** Two independent 53-bit hashes (cyrb53) in base 36: about 106 bits, so different inputs don't meet. */
const h53 = (text: string, seed: number): string => {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
};
export const signatureHash = (text: string): string => `${h53(text, 0)}${h53(text, 0x9e3779b9)}`;

/** Every string anywhere in a value (ids are strings). */
const strings = (v: unknown, out: Set<string>): Set<string> => {
  if (typeof v === "string") out.add(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
};

/** Hash of an object, worked out once per object (unchanged parts of an edited show are the same objects). */
const objectHashes = new WeakMap<object, string>();
const hashOf = (o: object): string => {
  let h = objectHashes.get(o);
  if (h === undefined) objectHashes.set(o, (h = signatureHash(exactJson(o))));
  return h;
};

/** What a layer names: other layers of its composition, 3D scenes, and pictures/video/models (assets). */
interface Refs {
  readonly layers: readonly Id[];
  readonly scenes: readonly Id[];
  readonly assets: readonly Id[];
}

/** Signatures of a composition's frames (by frame number), for one version of a show. */
export const frameSignatures = (project: Project, compId: Id): ((frame: number) => string) => {
  const comp = project.compositions[compId];
  const rate = comp?.frameRate;
  const at = timeSignatures(project);
  const memo = new Map<number, string>();
  return (frame) => {
    let s = memo.get(frame);
    if (s === undefined) memo.set(frame, (s = comp && rate ? at(compId, frameToTime(frame, rate)) : "none"));
    return s;
  };
};

/** Signatures at any composition time (nested compositions are asked at their layers' times). */
const timeSignatures = (project: Project): ((compId: Id, t: Flicks) => string) => {
  const memo = new Map<string, string>();
  const refsMemo = new Map<string, Refs>();
  const staticMemo = new Map<Id, string>();
  const scenes = project.scenes3d ?? {};

  // The building and the rest of the show every frame depends on.
  const showPart = (comp: Composition): string => {
    const venueId = comp.venueId ?? project.activeVenueId;
    const venue = venueId ? project.venues[venueId] : undefined;
    // Projector calibration and output settings don't change composition content (they're applied when shown).
    const { projectors: _p, projectorOrder: _o, name: _n, ...v } = (venue ?? {}) as Record<string, unknown>;
    // The pictures it names (the building photo, …).
    const assets = [...strings(venue ?? null, new Set())].filter((x) => x in project.assets).sort().map((a) => hashOf(project.assets[a]!));
    return signatureHash(exactJson({ venueId: venueId ?? null, venue: venue ? v : null, assets, bindings: project.bindings, settings: project.settings }));
  };

  const compPart = (comp: Composition): string => {
    let s = staticMemo.get(comp.id);
    if (s === undefined) {
      const { layers: _l, layerOrder: _o, markers: _m, name: _n, workArea: _w, ...rest } = comp as unknown as Record<string, unknown>;
      const solo = comp.layerOrder.filter((id) => comp.layers[id]?.solo);
      staticMemo.set(comp.id, (s = signatureHash(exactJson({ comp: rest, solo, show: showPart(comp) }))));
    }
    return s;
  };

  const refsOf = (comp: Composition, l: Layer): Refs => {
    const key = `${comp.id}/${l.id}`;
    let r = refsMemo.get(key);
    if (!r) {
      const names = strings(l, new Set());
      const sceneIds = [...names].filter((x) => x in scenes);
      for (const sid of sceneIds) strings(scenes[sid], names);
      r = {
        layers: [...names].filter((x) => x !== l.id && x in comp.layers).sort(),
        scenes: sceneIds.sort(),
        assets: [...names].filter((x) => x in project.assets).sort(),
      };
      refsMemo.set(key, r);
    }
    return r;
  };

  /** A layer at composition time t: itself, what it names, and its nested composition's frame. */
  const layerPart = (comp: Composition, l: Layer, t: Flicks, depth: number, seen: Set<Id>): string => {
    seen.add(l.id);
    const r = refsOf(comp, l);
    const parts = [hashOf(l), ...r.scenes.map((sid) => hashOf(scenes[sid]!)), ...r.assets.map((a) => hashOf(project.assets[a]!))];
    if (l.source.kind === "comp") parts.push(`c${sigAt(l.source.compId, layerLocalTime(l, t), depth + 1)}`);
    for (const id of r.layers) {
      const other = comp.layers[id];
      if (other && !seen.has(id)) parts.push(`r${layerPart(comp, other, t, depth, seen)}`);
    }
    return parts.join(".");
  };

  const sigAt = (compId: Id, t: Flicks, depth = 0): string => {
    const key = `${compId}@${t}`;
    let s = memo.get(key);
    if (s !== undefined) return s;
    const comp = project.compositions[compId];
    if (!comp || depth > 32) return "missing";
    const parts: string[] = [`t${t}`, compPart(comp)];
    for (const id of comp.layerOrder) {
      const l = comp.layers[id];
      if (!l || l.source.kind === "audio" || !(l.inPoint <= t && t < l.outPoint)) continue;
      parts.push(`${id}:${layerPart(comp, l, t, depth, new Set())}`);
    }
    s = signatureHash(parts.join("|"));
    memo.set(key, s);
    return s;
  };

  return sigAt;
};
