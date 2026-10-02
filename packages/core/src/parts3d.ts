/**
 * Moving parts of the house in 3D: doors swinging on a hinge, garage doors raising, windows pushing
 * in, parts sliding, turning or falling away.
 *
 * A "house parts" scene holds the facade as a solid with the building photo on its front and its
 * openings cut out (so nothing of the original stays where a part has moved), each moving part as
 * its own photo-faced solid turning about its hinge, and a backing behind each opening — a dark
 * recess, a lit room, a picture, or the wall's colour. The motions are ordinary keyframes on the
 * parts, editable like any other. The traced areas — the fixed mapping of the building — are never
 * changed: the parts are creative copies drawn from them.
 *
 * Depths are assumed, not measured (a photo has no depth): they're stated wherever they're shown.
 */
import { type AnimProp, EASY_EASE, type Keyframe, staticProp } from "./anim.ts";
import { refRegions } from "./areas.ts";
import type { Id, Project, RegionKind, RGBA, Vec3 } from "./model.ts";
import { flattenPath } from "./pathmath.ts";
import { type Flicks, FLICKS_PER_SECOND } from "./time.ts";
import { type Canvas, canvasToWorld, lightObject, type Material3D, type Object3D, type Scene3D } from "./world3d.ts";

export type PartMotion =
  /** Turn about a vertical hinge at one side, into the house or out toward the audience. */
  | { readonly kind: "swing"; readonly hinge: "left" | "right"; readonly direction: "in" | "out"; readonly angle: number }
  /** Garage doors: slide up behind the wall, or tip up and back about the top edge. */
  | { readonly kind: "raise"; readonly style: "slide" | "tilt" }
  /** Straight in (negative metres) or out toward the audience (positive). */
  | { readonly kind: "push"; readonly distance: number }
  /** Slide out of the opening, behind the wall. */
  | { readonly kind: "slide"; readonly direction: "left" | "right" | "up" | "down" }
  /** Spin about its centre. */
  | { readonly kind: "turn"; readonly axis: "vertical" | "horizontal"; readonly turns: number }
  /** Come loose and fall with real physics (and fly back if timing.back). */
  | { readonly kind: "fall" };

/** Seconds into the parts layer. */
export interface PartTiming {
  readonly start: number;
  /** How long the move takes. */
  readonly move: number;
  /** How long it stays moved before going back (if `back`). */
  readonly hold: number;
  readonly back: boolean;
}

/** What shows through an opening once its part has moved. */
export type Backing =
  | { readonly kind: "recess" }
  | { readonly kind: "room"; readonly color: RGBA }
  | { readonly kind: "image"; readonly assetId: Id }
  | { readonly kind: "wall"; readonly color: RGBA };

export interface PartInfo {
  /** The traced area the part is made from (its source; never changed by the part). */
  readonly regionId: Id;
  readonly motion: PartMotion;
  readonly timing: PartTiming;
  readonly backing: Backing;
  /** The backing object behind the opening. */
  readonly backingId?: Id;
}

/** Assumed depths in metres (a photo can't show them). */
export const ASSUMED_DEPTH = { facade: 0.25, door: 0.06, garage: 0.08, window: 0.06, other: 0.1 } as const;

export const partDepth = (kind: RegionKind): number => (kind === "door" ? ASSUMED_DEPTH.door : kind === "garage" ? ASSUMED_DEPTH.garage : kind === "window" ? ASSUMED_DEPTH.window : ASSUMED_DEPTH.other);

export const defaultMotion = (kind: RegionKind): PartMotion =>
  kind === "door" ? { kind: "swing", hinge: "left", direction: "in", angle: 95 } : kind === "garage" ? { kind: "raise", style: "slide" } : kind === "light" ? { kind: "turn", axis: "vertical", turns: 1 } : { kind: "push", distance: -0.25 };

export const defaultBacking = (kind: RegionKind): Backing => (kind === "window" ? { kind: "room", color: [1, 0.78, 0.45, 1] } : { kind: "recess" });

export const DEFAULT_TIMING: PartTiming = { start: 1, move: 1.5, hold: 2, back: true };

/** An area's extent on the building front, in metres (x right, y up). */
export const partBounds = (project: Project, regionId: Id, venueId: Id | undefined, canvas: Canvas) => {
  const pts = refRegions(project, { role: "areas", regionIds: [regionId] }, venueId).flatMap((r) => flattenPath(r.path, 4));
  if (!pts.length) return null;
  const w = pts.map((p) => canvasToWorld(p, canvas));
  const xs = w.map((p) => p[0]), ys = w.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};

const flicks = (s: number): Flicks => Math.round(s * FLICKS_PER_SECOND);

/** Keyframes rest → moved (→ rest), eased in and out. */
const keyed = (rest: Vec3, moved: Vec3, t: PartTiming, spatial: boolean, id: string): AnimProp<Vec3> => {
  const ease = spatial ? [EASY_EASE] : [EASY_EASE, EASY_EASE, EASY_EASE];
  const k = (n: number, s: number, v: Vec3): Keyframe<Vec3> => ({ id: `${id}${n}`, t: flicks(s), v, in: "bezier", out: "bezier", easeIn: ease, easeOut: ease });
  const keys = [k(0, t.start, rest), k(1, t.start + t.move, moved)];
  if (t.back) keys.push(k(2, t.start + t.move + t.hold, moved), k(3, t.start + 2 * t.move + t.hold, rest));
  return { value: rest, keyframes: keys, ...(spatial ? { spatial: true } : {}) };
};

/**
 * The pivot, position and rotation of a part for a motion (positions and the pivot in metres,
 * rotations in degrees), plus how far into the house it reaches (for placing the backing).
 */
export const partMotion = (m: PartMotion, t: PartTiming, b: { x0: number; x1: number; y0: number; y1: number }, depth: number, facadeDepth: number, id: string) => {
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const still = staticProp<Vec3>([0, 0, 0]);
  const stillPos = staticProp<Vec3>([0, 0, 0], true);
  // Behind the wall: just past the facade's back face.
  const behind = -(facadeDepth + 0.04);
  switch (m.kind) {
    case "swing": {
      const sign = (m.hinge === "left" ? 1 : -1) * (m.direction === "in" ? 1 : -1);
      return { pivot: [m.hinge === "left" ? b.x0 : b.x1, cy, 0] as Vec3, position: stillPos, rotation: keyed([0, 0, 0], [0, sign * m.angle, 0], t, false, `${id}-r`), reach: m.direction === "in" ? w : 0.3 };
    }
    case "raise":
      if (m.style === "tilt") return { pivot: [cx, b.y1, 0] as Vec3, position: stillPos, rotation: keyed([0, 0, 0], [85, 0, 0], t, false, `${id}-r`), reach: h };
      // Step back behind the wall first, then rise.
      return { pivot: [cx, cy, 0] as Vec3, position: keyed([0, 0, 0], [0, h * 0.98, behind], t, true, `${id}-p`), rotation: still, reach: 0.3 };
    case "push":
      return { pivot: [cx, cy, 0] as Vec3, position: keyed([0, 0, 0], [0, 0, m.distance], t, true, `${id}-p`), rotation: still, reach: Math.max(0.3, -m.distance + depth) };
    case "slide": {
      const d: Vec3 = m.direction === "left" ? [-w * 0.98, 0, behind] : m.direction === "right" ? [w * 0.98, 0, behind] : m.direction === "up" ? [0, h * 0.98, behind] : [0, -h * 0.98, behind];
      return { pivot: [cx, cy, 0] as Vec3, position: keyed([0, 0, 0], d, t, true, `${id}-p`), rotation: still, reach: 0.3 };
    }
    case "turn":
      return { pivot: [cx, cy, -depth / 2] as Vec3, position: stillPos, rotation: keyed([0, 0, 0], m.axis === "vertical" ? [0, 360 * m.turns, 0] : [360 * m.turns, 0, 0], t, false, `${id}-r`), reach: Math.max(w, h) / 2 };
    case "fall":
      return { pivot: [cx, cy, 0] as Vec3, position: stillPos, rotation: still, reach: 0.3 };
  }
};

const photoMaterial = (): Material3D => ({ style: "photo", color: staticProp<RGBA>([1, 1, 1, 1]), roughness: 0.85, metalness: 0, glow: staticProp(0), opacity: 1 });

const backingMaterial = (b: Backing): Material3D => {
  const base = { roughness: 1, metalness: 0, opacity: 1 };
  if (b.kind === "image") return { style: "image", assetId: b.assetId, color: staticProp<RGBA>([1, 1, 1, 1]), glow: staticProp(0.6), ...base };
  if (b.kind === "room") return { style: "color", color: staticProp(b.color), glow: staticProp(0.35), ...base };
  if (b.kind === "wall") return { style: "color", color: staticProp(b.color), glow: staticProp(0), ...base };
  return { style: "color", color: staticProp<RGBA>([0.03, 0.03, 0.035, 1]), glow: staticProp(0), ...base };
};

/**
 * A moving part made from a traced area, and the backing behind its opening (two ordinary 3D
 * objects). `facadeDepth` is how thick the facade around it is assumed to be.
 */
export const partObjects = (
  project: Project,
  o: { id: Id; backingId: Id; name: string; regionId: Id; kind: RegionKind; venueId?: Id; canvas: Canvas; motion: PartMotion; timing: PartTiming; backing: Backing; facadeDepth?: number },
): [Object3D, Object3D] | null => {
  const b = partBounds(project, o.regionId, o.venueId, o.canvas);
  if (!b) return null;
  const depth = partDepth(o.kind);
  const facadeDepth = o.facadeDepth ?? ASSUMED_DEPTH.facade;
  const mv = partMotion(o.motion, o.timing, b, depth, facadeDepth, o.id);
  const fall = o.motion.kind === "fall";
  const part: Object3D = {
    id: o.id,
    name: o.name,
    kind: "mesh",
    visible: true,
    position: mv.position,
    rotation: mv.rotation,
    scale: staticProp<Vec3>([100, 100, 100]),
    pivot: mv.pivot,
    geometry: { kind: "area", ref: { role: "areas", regionIds: [o.regionId] }, depth },
    material: photoMaterial(),
    castShadow: true,
    receiveShadow: true,
    physics: fall ? { body: "dynamic", mass: 60, friction: 0.7, bounce: 0.1 } : { body: "static", mass: 60, friction: 0.7, bounce: 0.1 },
    ...(fall
      ? { fracture: { pieceSize: 100_000, seed: 1, collapseAt: o.timing.start, rebuildAt: o.timing.back ? o.timing.start + o.timing.move + o.timing.hold : null, rebuildSeconds: o.timing.move, push: 0.5, spin: 0.15 } }
      : {}),
    part: { regionId: o.regionId, motion: o.motion, timing: o.timing, backing: o.backing, backingId: o.backingId },
  };
  // The backing sits behind the opening, past wherever the part reaches, a little larger than the
  // opening so its edges never show through it.
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  const back = facadeDepth + mv.reach + 0.3;
  const backing: Object3D = {
    id: o.backingId,
    name: `Behind ${o.name}`,
    kind: "mesh",
    visible: true,
    position: staticProp<Vec3>([(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, -back], true),
    rotation: staticProp<Vec3>([0, 0, 0]),
    scale: staticProp<Vec3>([100, 100, 100]),
    geometry: { kind: "box", size: [w * 1.6 + back * 0.4, h * 1.6 + back * 0.4, 0.05] },
    material: backingMaterial(o.backing),
    castShadow: false,
    receiveShadow: true,
  };
  return [part, backing];
};

/** Id of the still copy of an opening (shown in the facade's cut-out while the opening isn't moving). */
export const stillId = (sceneId: Id, regionId: Id) => `${sceneId}-still-${regionId}`;

/** An opening that doesn't move: its photo in place, filling the facade's cut-out. */
export const stillObject = (sceneId: Id, regionId: Id, name: string, kind: RegionKind): Object3D => ({
  id: stillId(sceneId, regionId),
  name: `${name} (still)`,
  kind: "mesh",
  visible: true,
  position: staticProp<Vec3>([0, 0, 0], true),
  rotation: staticProp<Vec3>([0, 0, 0]),
  scale: staticProp<Vec3>([100, 100, 100]),
  geometry: { kind: "area", ref: { role: "areas", regionIds: [regionId] }, depth: partDepth(kind) },
  material: photoMaterial(),
  castShadow: true,
  receiveShadow: true,
  physics: { body: "static", mass: 60, friction: 0.7, bounce: 0.1 },
});

/**
 * The parts scene for a venue: the facade with its openings cut out, still copies of the openings
 * (`stills`; each is replaced by a part when it's made to move), the ground at its foot, and lights.
 */
export const partsScene = (project: Project, o: { sceneId: Id; name: string; facadeId?: Id; stills?: ReadonlyArray<{ regionId: Id; name: string; kind: RegionKind }>; venueId?: Id; canvas: Canvas }): Scene3D => {
  const p = o.sceneId;
  const objects: Object3D[] = [];
  const fb = o.facadeId ? partBounds(project, o.facadeId, o.venueId, o.canvas) : null;
  const W = o.canvas.width * 0.01, H = o.canvas.height * 0.01;
  if (o.facadeId)
    objects.push({
      id: `${p}-facade`,
      name: "Facade",
      kind: "mesh",
      visible: true,
      position: staticProp<Vec3>([0, 0, 0], true),
      rotation: staticProp<Vec3>([0, 0, 0]),
      scale: staticProp<Vec3>([100, 100, 100]),
      geometry: { kind: "area", ref: { role: "areas", regionIds: [o.facadeId] }, depth: ASSUMED_DEPTH.facade },
      material: photoMaterial(),
      castShadow: true,
      receiveShadow: true,
      physics: { body: "static", mass: 10_000, friction: 0.8, bounce: 0.1 },
    });
  for (const st of o.stills ?? []) objects.push(stillObject(p, st.regionId, st.name, st.kind));
  // The ground at the foot of the house, for anything that falls (only its shadows show).
  const foot = fb ? fb.y0 : 0;
  objects.push({
    id: `${p}-ground`,
    name: "Ground",
    kind: "mesh",
    visible: true,
    position: staticProp<Vec3>([0, foot - 0.1, 2], true),
    rotation: staticProp<Vec3>([0, 0, 0]),
    scale: staticProp<Vec3>([100, 100, 100]),
    geometry: { kind: "box", size: [60, 0.2, 12] },
    material: { style: "shadow", color: staticProp<RGBA>([0, 0, 0, 1]), roughness: 1, metalness: 0, glow: staticProp(0), opacity: 0.55 },
    castShadow: false,
    receiveShadow: true,
    physics: { body: "static", mass: 1000, friction: 0.9, bounce: 0.05 },
  });
  const cx = fb ? (fb.x0 + fb.x1) / 2 : 0, top = fb ? fb.y1 : H;
  objects.push(lightObject(`${p}-key`, "Key light", { target: [cx, (top + foot) / 2, 0], intensity: staticProp(2.2), softness: 0.6 }, [cx - W * 0.25, top + 4, 9]));
  objects.push(lightObject(`${p}-fill`, "Soft fill", { type: "ambient", intensity: staticProp(0.9), castShadow: false, color: [0.95, 0.96, 1, 1] }, [0, 0, 0]));
  return { id: o.sceneId, name: o.name, purpose: "parts", objectOrder: objects.map((x) => x.id), objects: Object.fromEntries(objects.map((x) => [x.id, x])), gravity: [0, -9.81, 0], cameraDistance: 1.6 };
};
