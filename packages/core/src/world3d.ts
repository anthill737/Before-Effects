/**
 * Internal 3D: editable 3D scenes stored in the project.
 *
 * A scene holds objects — solids (boxes, balls, planes, and building areas given thickness),
 * lights — each with a transform that can be animated, a material and optional physical
 * properties. A 3D layer shows a scene in a composition through the show camera, which looks at
 * the building front so that the traced canvas lines up exactly with the front plane (z = 0).
 *
 * Units: metres, with 1 canvas pixel = 1 cm on the building front. x right, y up (0 = bottom of
 * the canvas), z toward the audience. Rotations are degrees (XYZ order), scale is percent.
 *
 * Physics (falling, tumbling, colliding) is computed ahead of time ("prepared") from a plain
 * description of the bodies — `ResolvedPhysics` — and stored per frame, so playback, seeking and
 * export always show the same motion. Its key changes whenever anything that affects motion
 * changes; lights, colours and the camera don't affect it.
 *
 * The building itself (venue geometry used for calibration) is not part of these scenes: they are
 * creative geometry placed in front of it. Moving a 3D object never moves a traced area.
 */
import earcut from "earcut";
import polygonClipping from "polygon-clipping";
import { z } from "zod";
import { type AnimProp, evalProp, staticProp } from "./anim.ts";
import { refRegions, regionHoles } from "./areas.ts";
import type { Id, Project, RegionRef, RGBA, Vec2, Vec3 } from "./model.ts";
import { defineOp, OpError } from "./ops.ts";
import { flattenPath } from "./pathmath.ts";
import { type HouseLight, houseLightPlace } from "./houseLights.ts";
import { particleEmitter } from "./particles3d.ts";
import { rand01 } from "./rng.ts";
import { simHash, stableJson } from "./simulation.ts";
import { type Flicks, FLICKS_PER_SECOND } from "./time.ts";

export const METERS_PER_PIXEL = 0.01;
/** Bump when the physics set-up changes in a way that changes results (invalidates prepared motion). */
export const PHYSICS_ENGINE_VERSION = 3;
/** Physics steps per frame (at 30 fps: 120 steps per second). */
export const PHYSICS_SUBSTEPS = 4;
export const MAX_FRAGMENTS = 600;

export type MaterialStyle = "photo" | "color" | "shadow" | "image";

export interface Material3D {
  /** "photo": the building photo on the front (sides plain) · "color": plain · "shadow": only shows shadows · "image": a picture (`assetId`) on the front. */
  readonly style: MaterialStyle;
  /** The picture for "image". */
  readonly assetId?: Id;
  readonly color: AnimProp<RGBA>;
  readonly roughness: number;
  readonly metalness: number;
  /** Self-lit glow, 0..10. */
  readonly glow: AnimProp<number>;
  /** 0..1 (for "shadow": how dark the shadows are). */
  readonly opacity: number;
  /** A picture surface ("photo"/"image"): how much the scene's lights shade it — 0 shows the picture
   *  itself whichever way it turns (like a layer mapped onto pieces), 1 lit like a real solid (default). */
  readonly shading?: number;
  /** A picture surface: evened out so that, facing the audience, it shows its picture exactly whatever
   *  the lights are (default on). Off: the picture as the lights really fall on it — e.g. a light's own
   *  pass, added over the house. */
  readonly matchPicture?: boolean;
  /**
   * How a picture lands on the surface. "front" (default): straight on the front, lined up with the
   * canvas (traced areas, cut-outs). "camera": projected through the scene's camera like a slide
   * projector, so every surface — at any depth or angle — shows exactly the picture the camera sees
   * there (a house model under its photo's camera). Transparent parts of the picture give no colour.
   * Pieces (of an area or panel) carry the picture they show at rest: a broken door's fragments fly
   * off with their part of it.
   */
  readonly mapping?: "front" | "camera";
  /**
   * Shadows only: also hide whatever of this layer is behind it, so the layers below show there — a
   * wall that debris falls behind, standing in for the house picture under this layer.
   */
  readonly holdout?: boolean;
  /**
   * Picture surfaces: the picture exactly, plus the light the scene's lights add to it (none of it
   * evened out) — a house picture lit by a lantern carried past it. `shading` sets how strongly.
   */
  readonly addLight?: boolean;
  /**
   * Adds what it shows to the layers beneath instead of covering them — a light's own pass on the
   * house (with matchPicture off) kept in the same layer as what casts it, e.g. a ghost and the
   * glow it throws on the house. It still hides what of this layer is behind it.
   */
  readonly addOver?: boolean;
}

/**
 * How a picture surface is made from its picture: `lit` (per colour) scales the part the scene's lights
 * shade — the renderer shows it × the light falling on it / π — and `self` is the part shown as it is
 * (what shading leaves, plus any glow). With the defaults a surface facing the audience shows exactly
 * its picture; turning or a shadow only darkens the shaded part.
 */
export const pictureMix = (m: Pick<Material3D, "shading" | "matchPicture" | "addLight">, glow: number, gain: readonly number[]): { lit: [number, number, number]; self: number } => {
  const s = Math.max(0, Math.min(1, m.shading ?? 1));
  // The picture itself (as it shows), with what the lights bring on top.
  if (m.addLight) return { lit: [s, s, s], self: 1 + Math.max(0, glow) };
  const g = m.matchPicture === false ? [1, 1, 1] : gain;
  return { lit: [s * g[0]!, s * g[1]!, s * g[2]!], self: 1 - s + Math.max(0, glow) };
};

export type Geometry3D =
  /**
   * A traced building area given thickness. Its front sits on the building front (z = 0), or `standOut`
   * metres out toward the audience (a column in front of a porch, a roof overhang) — drawn along the
   * show camera's lines of sight, so from the audience it still sits exactly on its picture while
   * lights and shadows treat it as the real solid. `cut`: other areas cut out of it (room for the parts
   * that are their own pieces, e.g. a wall with its columns and doors as separate solids).
   */
  | { readonly kind: "area"; readonly ref: RegionRef; readonly depth: number; readonly standOut?: number; readonly cut?: RegionRef }
  | { readonly kind: "box"; readonly size: Vec3 }
  | { readonly kind: "sphere"; readonly radius: number }
  | { readonly kind: "plane"; readonly size: Vec2 }
  /**
   * A model brought in from a file (glTF/GLB, e.g. exported from a linked Blender scene): its own
   * meshes, materials, lights and animation. `nodes`: only these named parts of it (and what's inside
   * them) — one file can give several objects (walls, a door that comes and goes).
   */
  | { readonly kind: "model"; readonly assetId: Id; readonly nodes?: readonly string[] }
  /**
   * A flat solid placed in the scene's own space (metres), for scenes modelled in 3D and seen through
   * their own camera: `outline` (and `holes`) in the object's x–y plane, its front at z = 0 and
   * `depth` behind it — a door, a slab, a section of wall. It can break apart like an area.
   */
  | { readonly kind: "panel"; readonly outline: readonly Vec2[]; readonly holes?: readonly (readonly Vec2[])[]; readonly depth: number };

/** Geometry that is cut into pieces (and can break apart or move as blocks): traced areas and panels. */
export type PiecedGeometry = Extract<Geometry3D, { kind: "area" | "panel" }>;
export const isPieced = (g: Geometry3D | undefined): g is PiecedGeometry => g?.kind === "area" || g?.kind === "panel";

export interface Physics3D {
  /** "dynamic" falls and collides; "static" stays put (or follows its animation) and others hit it. */
  readonly body: "dynamic" | "static";
  /** Kilograms for the whole object (split between its pieces by size). */
  readonly mass: number;
  readonly friction: number;
  /** 0 = no bounce, 1 = bounces back fully. */
  readonly bounce: number;
  /**
   * Dynamic bodies: seconds into the layer when it lets go. Until then it follows its animation (and
   * whatever it rides on); then physics takes over with the speed and spin it had — a thrown pumpkin
   * keeps flying. Absent: physics from the start.
   */
  readonly releaseAt?: number;
}

export interface Fracture3D {
  /** Typical piece size in cm (= canvas pixels). */
  readonly pieceSize: number;
  readonly seed: number;
  /** Seconds into the layer when the pieces let go. */
  readonly collapseAt: number;
  /** Seconds into the layer when the pieces start flying back; null = they stay down. */
  readonly rebuildAt: number | null;
  readonly rebuildSeconds: number;
  /** Speed toward the audience when the pieces let go (m/s); negative pushes them in (a window broken inwards). */
  readonly push: number;
  /** Random tumbling when the pieces let go (turns per second). */
  readonly spin: number;
  /** Seconds over which the pieces let go, from the top down (0 or absent = all at once). */
  readonly stagger?: number;
  /** How it breaks: irregular pieces (absent), glass — shards radiating from an impact point — or bricks: courses of heavy blocks laid like masonry. */
  readonly pattern?: "pieces" | "glass" | "bricks";
  /**
   * What makes it break: "time" (at collapseAt) or "impact" — it stays whole until something moving
   * hits it at least `impactSpeed` m/s fast, then only the pieces within `impactRadius` metres of the
   * hit let go, carried the way the hit was going (a pumpkin through a wall breaks it inward).
   */
  readonly trigger?: "time" | "impact";
  /** Impact: metres around the hit that break out (default 0.8). */
  readonly impactRadius?: number;
  /** Impact: slowest hit that breaks it, m/s (default 3). */
  readonly impactSpeed?: number;
  /**
   * Seconds into the layer by which the fallen pieces have come to rest. Pieces slowing to a stop are
   * damped (the scraping friction rubble has) so they settle instead of rocking on the ground or on
   * each other, and from this time each piece that has stopped stays exactly where it lies. Absent or
   * null: the pieces move freely throughout.
   */
  readonly settleAt?: number | null;
}

/**
 * The surface as blocks that move in a pattern (procedural: worked out from time, like particles):
 * cubes pushing out and back, columns rising, slats turning, in a pulse, ripples, a wave…
 */
export interface Blocks3D {
  /** cubes: a grid · columns: full-height strips · rows: full-width strips. */
  readonly shape: "cubes" | "columns" | "rows";
  /** Block size in cm (= canvas pixels): the width, and the height unless `height` is set. */
  readonly size: number;
  /** Block height (cm), for blocks shaped like the stones or bricks they cover. Set (or `bond`/`offset`):
   *  blocks keep exactly their size, lined up from `offset`, cut where the area ends. */
  readonly height?: number;
  /** Every other row shifted by this much of a block's width (0.5: half-brick courses, like real brickwork). */
  readonly bond?: number;
  /** Where the grid starts (cm on the canvas), so the blocks line up with the joints in the picture. */
  readonly offset?: Vec2;
  /** Gap between blocks (cm). */
  readonly gap: number;
  /** push: toward the audience (and back) · turn: about their own middle, like slats. */
  readonly motion: "push" | "turn";
  /** pulse: all together · ripple: rings from a point · wave: a band across · random: each its own · checker: alternate blocks opposite. */
  readonly pattern: "pulse" | "ripple" | "wave" | "random" | "checker";
  /** How far: cm pushed out, or degrees turned. */
  readonly amount: number;
  /** Also push in (or turn the other way); otherwise only out from the wall. */
  readonly bothWays: boolean;
  /** Cycles per second. */
  readonly speed: number;
  /** Distance between wave crests (cm), for ripple and wave. */
  readonly wavelength: number;
  /** Direction a wave travels, degrees (0 = left to right, 90 = upward). */
  readonly direction: number;
  /** Where ripples start, across the area (0..1, top-left origin). */
  readonly origin: Vec2;
  /** Seconds into the layer when they start moving, and when they've settled flat again (null = keep moving). */
  readonly startAt: number;
  readonly stopAt: number | null;
  /** Seconds to get going and to settle. */
  readonly ramp: number;
  readonly seed: number;
}

export interface Light3D {
  readonly type: "directional" | "spot" | "point" | "ambient";
  readonly color: RGBA;
  readonly intensity: AnimProp<number>;
  readonly castShadow: boolean;
  /** Where directional and spot lights point (metres). */
  readonly target: Vec3;
  /** Spot cone, degrees. */
  readonly angle: number;
  /** Soft shadow edge / spot edge, 0..1. */
  readonly softness: number;
  /** Point and spot lights: metres beyond which they light nothing (fading smoothly to it); absent or 0: no limit. */
  readonly range?: number;
  /** Point and spot lights: how the light weakens with distance — 2 as real light (default), lower reaches further, 0 not at all. */
  readonly falloff?: number;
  /**
   * Part of the picture's own lighting: picture surfaces are evened out by these lights so that, at
   * rest, they show their picture exactly. Lights that aren't add light (and cast shadows) on top of
   * the picture — a lantern, a ghost's glow, a passing beam. Default: sun (directional) and fill
   * (ambient) lights are; spot and point lights aren't.
   */
  readonly balance?: boolean;
}

/** Does this light even out picture surfaces (see Light3D.balance)? */
export const balancesPicture = (L: Pick<Light3D, "type" | "balance">): boolean => L.balance ?? (L.type === "directional" || L.type === "ambient");

/** A light as it is at one moment, for working out what lands on a surface (colours linear RGB). */
export interface LightNow {
  readonly type: Light3D["type"];
  readonly color: readonly [number, number, number];
  /** A soft fill's ground colour (its sky is `color`). */
  readonly ground?: readonly [number, number, number];
  readonly intensity: number;
  readonly position: Vec3;
  readonly target: Vec3;
  readonly angle: number;
  readonly softness: number;
  readonly range?: number;
  readonly falloff?: number;
  /** Part of the picture's own lighting (see Light3D.balance). */
  readonly balance?: boolean;
}

/**
 * How much of a point or spot light reaches `dist` metres (the renderer's own rule): weakening as
 * 1/dist^falloff, and with a range, fading smoothly to nothing at it.
 */
export const lightReach = (dist: number, range = 0, falloff = 2): number => {
  const d = Math.max(0.1, dist);
  const k = 1 / d ** Math.max(0, falloff);
  if (!(range > 0)) return k;
  const r = Math.min(1, Math.max(0, 1 - (d / range) ** 4));
  return k * r * r;
};

/**
 * The light falling on a surface that faces the audience (+z) at `at`, per colour channel, in the
 * renderer's units (a matte surface of colour a shows a·E/π). Spot and point lights are as bright as
 * the renderer makes them (×50, falling off with distance squared); a soft fill lights a wall with the
 * average of its sky and ground.
 */
export const frontIrradiance = (lights: readonly LightNow[], at: Vec3): [number, number, number] => {
  const e: [number, number, number] = [0, 0, 0];
  for (const L of lights) {
    if (L.type === "ambient") {
      const g = L.ground ?? L.color;
      for (let i = 0; i < 3; i++) e[i]! += L.intensity * 0.5 * (L.color[i]! + g[i]!);
      continue;
    }
    let k: number;
    if (L.type === "directional") {
      const d = [L.position[0] - L.target[0], L.position[1] - L.target[1], L.position[2] - L.target[2]];
      const len = Math.hypot(d[0]!, d[1]!, d[2]!);
      k = len > 0 ? L.intensity * Math.max(0, d[2]! / len) : 0;
    } else {
      const d = [L.position[0] - at[0], L.position[1] - at[1], L.position[2] - at[2]];
      const dist2 = Math.max(0.01, d[0]! ** 2 + d[1]! ** 2 + d[2]! ** 2);
      k = L.intensity * 50 * lightReach(Math.sqrt(dist2), L.range, L.falloff) * Math.max(0, d[2]! / Math.sqrt(dist2));
      if (L.type === "spot") {
        const ax = [L.target[0] - L.position[0], L.target[1] - L.position[1], L.target[2] - L.position[2]];
        const al = Math.hypot(ax[0]!, ax[1]!, ax[2]!) || 1;
        const cos = -(ax[0]! * d[0]! + ax[1]! * d[1]! + ax[2]! * d[2]!) / (al * Math.sqrt(dist2));
        const a = (L.angle * Math.PI) / 180;
        k *= smoothstep(Math.cos(a), Math.cos(a * (1 - L.softness)), cos);
      }
    }
    for (let i = 0; i < 3; i++) e[i]! += k * L.color[i]!;
  }
  return e;
};

/**
 * What a picture-faced surface's colour is multiplied by so that, facing the audience, it shows its
 * picture exactly whatever the scene's lights are: only turning away, or a shadow, changes it (a part
 * at rest looks like the house itself, not a re-lit copy of it).
 */
export const pictureGain = (e: readonly number[]): [number, number, number] => e.map((v) => (v > 1e-3 ? Math.min(20, Math.max(0.05, Math.PI / v)) : 1)) as [number, number, number];

export interface Object3D {
  readonly id: Id;
  readonly name: string;
  /** "null": a controller — invisible, only a position, turn and size over time for others to ride on (After Effects' null). */
  readonly kind: "mesh" | "light" | "particles" | "null";
  readonly visible: boolean;
  /**
   * Seconds into the layer when it's there (like a layer's in and out points); outside it's gone —
   * not drawn, casting no shadow, giving no light. Absent: always.
   */
  readonly activeFrom?: number;
  readonly activeTo?: number;
  readonly position: AnimProp<Vec3>;
  readonly rotation: AnimProp<Vec3>;
  readonly scale: AnimProp<Vec3>;
  /** The point it turns and scales about (metres, in the scene's frame at rest) — a door's hinge. Default: its origin. */
  readonly pivot?: Vec3;
  /**
   * Rides on another object of the scene (a pumpkin in a character's hands, a lantern on a ghost):
   * its own position, turn and size are then measured in that object's frame, so it moves with it.
   * `until`: seconds into the layer when it lets go (it stays where it was left, or physics takes
   * over: see Physics3D.releaseAt). It follows the other object's animation, not its physics.
   */
  readonly attach?: { readonly to: Id; readonly until?: number | null };
  readonly geometry?: Geometry3D;
  readonly material?: Material3D;
  readonly castShadow?: boolean;
  readonly receiveShadow?: boolean;
  readonly physics?: Physics3D;
  /** Break into pieces that fall (and optionally fly back). Areas only. */
  readonly fracture?: Fracture3D;
  /** The surface as moving blocks (cubes, columns, slats). Areas only; ignored while it breaks apart. */
  readonly blocks?: Blocks3D;
  readonly light?: Light3D;
  /** A moving part of the house made from a traced area (see parts3d.ts). */
  readonly part?: import("./parts3d.ts").PartInfo;
  /** Models: how the file's own animation plays (speed 1 = as authored; offset in seconds). */
  readonly clip?: { readonly speed: number; readonly offset: number };
  /** Particles (kind "particles"; see particles3d.ts): sparks, embers, snow, confetti. */
  readonly particles?: import("./particles3d.ts").Particles3D;
}

export interface Scene3D {
  readonly id: Id;
  readonly name: string;
  /** "parts": the house's moving parts (facade, doors, windows…), one per scene of the show. */
  readonly purpose?: "parts";
  readonly objectOrder: readonly Id[];
  readonly objects: Readonly<Record<Id, Object3D>>;
  /** m/s² — strength and direction. */
  readonly gravity: Vec3;
  /**
   * The show camera stands this many building-widths in front of the building. Absent: the
   * building's own viewpoint (Venue.cameraDistance), shared by every scene that follows it.
   */
  readonly cameraDistance?: number;
  /**
   * The camera the scene is seen through, instead of the straight-on show camera: a camera in a
   * model of the scene (e.g. the Blender scene's camera, placed with that model), or one set by hand
   * (position m, rotation ° XYZ — looking along its −z, as in Blender — and vertical field of view °).
   * The canvas fills its view. Absent: the show camera.
   */
  readonly camera?: SceneCamera;
  /** Lit by the venue's house lights (its candles and torches: Venue.lights)? Default: yes. */
  readonly houseLights?: boolean;
  /**
   * How strongly this scene catches the house lights (× their brightness; default 1). For a scene whose
   * own lights balance its pictures differently from the house's (an older scene lit by a key and fill
   * with partial shading): set so its pieces at rest match the candlelit picture around them.
   */
  readonly houseLightStrength?: number;
}

export type SceneCamera =
  | { readonly kind: "model"; readonly objectId: Id; readonly name?: string }
  | { readonly kind: "manual"; readonly position: Vec3; readonly rotation: Vec3; readonly fovY: number };

/** Is the object there at layer time `t` (Object3D.activeFrom / activeTo)? */
export const activeAt = (o: Pick<Object3D, "visible" | "activeFrom" | "activeTo">, t: Flicks): boolean => {
  if (!o.visible) return false;
  const s = t / FLICKS_PER_SECOND;
  return (o.activeFrom === undefined || s >= o.activeFrom) && (o.activeTo === undefined || s < o.activeTo);
};

/** A camera at one moment (scene metres): where it is, which way it's turned (it looks along its −z), its vertical field of view. */
export interface CameraNow {
  readonly eye: Vec3;
  readonly q: Quat;
  readonly fovY: number;
}

const quatFromMatrix = (m: readonly number[]): Quat => {
  // Column-major 4×4; the rotation part with any scale divided out.
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!) || 1, sy = Math.hypot(m[4]!, m[5]!, m[6]!) || 1, sz = Math.hypot(m[8]!, m[9]!, m[10]!) || 1;
  const r00 = m[0]! / sx, r10 = m[1]! / sx, r20 = m[2]! / sx;
  const r01 = m[4]! / sy, r11 = m[5]! / sy, r21 = m[6]! / sy;
  const r02 = m[8]! / sz, r12 = m[9]! / sz, r22 = m[10]! / sz;
  const tr = r00 + r11 + r22;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    return [(r21 - r12) * s, (r02 - r20) * s, (r10 - r01) * s, 0.25 / s];
  }
  if (r00 > r11 && r00 > r22) {
    const s = 2 * Math.sqrt(1 + r00 - r11 - r22);
    return [0.25 * s, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s];
  }
  if (r11 > r22) {
    const s = 2 * Math.sqrt(1 + r11 - r00 - r22);
    return [(r01 + r10) / s, 0.25 * s, (r12 + r21) / s, (r02 - r20) / s];
  }
  const s = 2 * Math.sqrt(1 + r22 - r00 - r11);
  return [(r02 + r20) / s, (r12 + r21) / s, 0.25 * s, (r10 - r01) / s];
};

/**
 * The scene's own camera at layer time `t` (scene metres), or null for the show camera. A model's
 * camera is carried by that model's object (its position, turn and size, and what it rides on).
 */
export const sceneCameraAt = (project: Project, scene: Pick<Scene3D, "camera" | "objects">, t: Flicks): CameraNow | null => {
  const c = scene.camera;
  if (!c) return null;
  if (c.kind === "manual") return { eye: c.position, q: eulerDegToQuat(c.rotation), fovY: c.fovY };
  const o = scene.objects[c.objectId];
  if (!o || o.geometry?.kind !== "model") return null;
  const cams = project.assets[o.geometry.assetId]?.meta.model?.cameras ?? [];
  const cam = (c.name ? cams.find((x) => x.name === c.name) : undefined) ?? cams[0];
  if (!cam) return null;
  const pose = objectPose(scene, o, t);
  const m = cam.matrix;
  return { eye: pose.place([m[12]!, m[13]!, m[14]!]), q: quatMul(pose.q, quatFromMatrix(m)), fovY: cam.fovY };
};

/**
 * Where a scene point appears on the canvas through a camera (canvas pixels, and its distance in
 * front of the camera; null behind it). The canvas fills the camera's view, centred.
 */
export const projectThrough = (cam: CameraNow, canvas: Canvas, p: Vec3): { x: number; y: number; depth: number } | null => {
  const inv: Quat = [-cam.q[0], -cam.q[1], -cam.q[2], cam.q[3]];
  const v = rotateByQuat([p[0] - cam.eye[0], p[1] - cam.eye[1], p[2] - cam.eye[2]], inv);
  const depth = -v[2];
  if (depth <= 1e-6) return null;
  const f = canvas.height / 2 / Math.tan((cam.fovY * Math.PI) / 360);
  return { x: canvas.width / 2 + (f * v[0]) / depth, y: canvas.height / 2 - (f * v[1]) / depth, depth };
};

/** A scene's camera distance: its own, or the building's viewpoint, or 1.6. */
export const sceneCameraDistance = (project: Project, scene: Pick<Scene3D, "cameraDistance">, venueId: Id | undefined): number =>
  Math.max(0.2, scene.cameraDistance ?? (venueId ? project.venues[venueId]?.cameraDistance : undefined) ?? 1.6);

// ---------------------------------------------------------------------------------------------
// Small maths

export type Quat = readonly [number, number, number, number];

/** XYZ Euler degrees → quaternion (same convention as three.js). */
export const eulerDegToQuat = (r: Vec3): Quat => {
  const [x, y, z] = r.map((d) => (d * Math.PI) / 360) as [number, number, number];
  const c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z);
  const s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
};

/** Quaternion → XYZ Euler degrees (the inverse of eulerDegToQuat; three.js's convention). */
export const quatToEulerDeg = (q: Quat): Vec3 => {
  const [x, y, z, w] = q;
  const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - z * w), m13 = 2 * (x * z + y * w);
  const m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - x * w);
  const m32 = 2 * (y * z + x * w), m33 = 1 - 2 * (x * x + y * y);
  const ry = Math.asin(Math.min(1, Math.max(-1, m13)));
  const [rx, rz] = Math.abs(m13) < 0.9999999 ? [Math.atan2(-m23, m33), Math.atan2(-m12, m11)] : [Math.atan2(m32, m22), 0];
  return [rx, ry, rz].map((a) => (a * 180) / Math.PI) as unknown as Vec3;
};

/**
 * Where a point of an object (`c`, in its rest frame) ends up for a pose: scaled and turned about
 * the object's pivot, then moved. With no pivot this is position + rotation·(scale·c).
 */
export const placePoint = (c: Vec3, pos: Vec3, q: Quat, scale: Vec3, pivot: Vec3 = [0, 0, 0]): Vec3 => {
  const r = rotateByQuat([(c[0] - pivot[0]) * scale[0], (c[1] - pivot[1]) * scale[1], (c[2] - pivot[2]) * scale[2]], q);
  return [pos[0] + pivot[0] + r[0], pos[1] + pivot[1] + r[1], pos[2] + pivot[2] + r[2]];
};

export const quatMul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/** Angular velocity (radians a second, world axes) turning q0 into q1 over `dt` seconds. */
export const angularVelocity = (q0: Quat, q1: Quat, dt: number): Vec3 => {
  let d = quatMul(q1, [-q0[0], -q0[1], -q0[2], q0[3]]);
  if (d[3] < 0) d = [-d[0], -d[1], -d[2], -d[3]];
  const s = Math.hypot(d[0], d[1], d[2]);
  if (s < 1e-9 || dt <= 0) return [0, 0, 0];
  const angle = 2 * Math.atan2(s, d[3]);
  return [(d[0] / s) * (angle / dt), (d[1] / s) * (angle / dt), (d[2] / s) * (angle / dt)];
};

/** Where an object is at a moment: how its points are placed, its turn and its size (attachments included). */
export interface Pose3D {
  readonly place: (c: Vec3) => Vec3;
  readonly q: Quat;
  readonly scale: Vec3;
}

/**
 * An object's pose at layer time `t`: its own position, turn and size about its pivot, carried by
 * whatever it rides on (see Object3D.attach). After it lets go it stays where its carrier left it,
 * still moving by its own animation.
 */
export const objectPose = (scene: Pick<Scene3D, "objects">, o: Object3D, t: Flicks, depth = 0): Pose3D => {
  const pos = evalProp(o.position, t);
  const q = eulerDegToQuat(evalProp(o.rotation, t));
  const sc = evalProp(o.scale, t).map((v) => v / 100) as unknown as Vec3;
  const own = (c: Vec3) => placePoint(c, pos, q, sc, o.pivot);
  const a = o.attach;
  const carrier = a && depth < 8 && a.to !== o.id ? scene.objects[a.to] : undefined;
  if (!carrier) return { place: own, q, scale: sc };
  const tc = a!.until !== undefined && a!.until !== null ? Math.min(t, Math.round(a!.until * FLICKS_PER_SECOND)) : t;
  const P = objectPose(scene, carrier, tc, depth + 1);
  return { place: (c) => P.place(own(c)), q: quatMul(P.q, q), scale: [sc[0] * P.scale[0], sc[1] * P.scale[1], sc[2] * P.scale[2]] };
};

/** Does the object move in the scene by animation (its own keyframes, or riding on something)? */
export const animatedIn3D = (o: Object3D): boolean => (o.position.keyframes?.length ?? 0) > 0 || (o.rotation.keyframes?.length ?? 0) > 0 || !!o.attach;

export const rotateByQuat = (v: Vec3, q: Quat): Vec3 => {
  const [x, y, z] = v;
  const [qx, qy, qz, qw] = q;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx];
};

const polyArea = (p: readonly Vec2[]): number => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length]!;
    a += p[i]![0] * q[1] - q[0] * p[i]![1];
  }
  return a / 2;
};

const polyCentroid = (p: readonly Vec2[]): Vec2 => {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0; i < p.length; i++) {
    const v = p[i]!, w = p[(i + 1) % p.length]!;
    const c = v[0] * w[1] - w[0] * v[1];
    a += c;
    cx += (v[0] + w[0]) * c;
    cy += (v[1] + w[1]) * c;
  }
  if (Math.abs(a) < 1e-9) return [p.reduce((s, v) => s + v[0], 0) / p.length, p.reduce((s, v) => s + v[1], 0) / p.length];
  return [cx / (3 * a), cy / (3 * a)];
};

/** Keep the side of the line through `a` with normal `n` where (x − a)·n ≤ 0 (Sutherland–Hodgman). */
const clipHalf = (poly: readonly Vec2[], a: Vec2, n: Vec2): Vec2[] => {
  const out: Vec2[] = [];
  const side = (p: Vec2) => (p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
    const sp = side(p), sq = side(q);
    if (sp <= 0) out.push(p);
    if ((sp <= 0) !== (sq <= 0)) {
      const t = sp / (sp - sq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
};

const ccw = (p: Vec2[]): Vec2[] => (polyArea(p) < 0 ? p.slice().reverse() : p);

const hull2 = (pts: readonly Vec2[]): Vec2[] => {
  const s = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (s.length < 3) return s;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: Vec2[] = [];
  for (const p of s) {
    while (lo.length >= 2 && cross(lo[lo.length - 2]!, lo[lo.length - 1]!, p) <= 0) lo.pop();
    lo.push(p);
  }
  const up: Vec2[] = [];
  for (const p of s.reverse()) {
    while (up.length >= 2 && cross(up[up.length - 2]!, up[up.length - 1]!, p) <= 0) up.pop();
    up.push(p);
  }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
};

/** Polygon minus a convex hole: up to one piece per hole edge. */
const subtractConvex = (poly: Vec2[], hole: Vec2[]): Vec2[][] => {
  const h = ccw(hole);
  const out: Vec2[][] = [];
  let rest = poly;
  for (let i = 0; i < h.length && rest.length >= 3; i++) {
    const a = h[i]!, b = h[(i + 1) % h.length]!;
    // Inward normal of a CCW edge points left; "outside" the hole is the right side.
    const inward: Vec2 = [-(b[1] - a[1]), b[0] - a[0]];
    const outside = clipHalf(rest, a, inward);
    if (outside.length >= 3 && Math.abs(polyArea(outside)) > 1e-6) out.push(outside);
    rest = clipHalf(rest, a, [-inward[0], -inward[1]]);
  }
  return out;
};

const insidePoly = (pts: readonly Vec2[], [x, y]: Vec2) => {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!, [xj, yj] = pts[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

/**
 * An outline minus holes, as solids for 3D (outer outline plus holes, one entry per separate
 * piece). A hole touching or crossing the edge — a garage door at the foot of a facade — becomes a
 * notch in the outline instead (triangulation would drop a hole lying on the edge).
 */
export const solidWithHoles = (outline: readonly Vec2[], holes: readonly (readonly Vec2[])[]): Array<{ outline: Vec2[]; holes: Vec2[][] }> => {
  const ring = (pts: readonly Vec2[]): [number, number][] => pts.map((p) => [p[0], p[1]]);
  const open = (r: [number, number][]): Vec2[] => (r.length > 1 && r[0]![0] === r.at(-1)![0] && r[0]![1] === r.at(-1)![1] ? r.slice(0, -1) : r) as Vec2[];
  const usable = holes.filter((h) => h.length >= 3);
  if (!usable.length) return [{ outline: ccw([...outline]), holes: [] }];
  try {
    const out = polygonClipping.difference([ring(outline)], ...usable.map((h) => [ring(h)]));
    return out.map((poly) => ({ outline: ccw(open(poly[0]!)), holes: poly.slice(1).map(open) })).filter((p) => p.outline.length >= 3);
  } catch {
    // Degenerate shapes: keep the holes that lie inside as they are.
    return [{ outline: ccw([...outline]), holes: usable.filter((h) => h.every((p) => insidePoly(outline, p))).map((h) => [...h]) }];
  }
};

/** A closed path's outline as points (curves flattened, repeats dropped). */
export const closedPoints = (path: { closed: boolean; vertices: readonly { p: Vec2 }[] } & Parameters<typeof flattenPath>[0]): Vec2[] => {
  const pts = flattenPath(path, 8);
  const out: Vec2[] = [];
  for (const p of pts) if (!out.length || Math.hypot(p[0] - out.at(-1)![0], p[1] - out.at(-1)![1]) > 1e-6) out.push(p);
  if (out.length > 2 && Math.hypot(out[0]![0] - out.at(-1)![0], out[0]![1] - out.at(-1)![1]) < 1e-6) out.pop();
  return out;
};

// ---------------------------------------------------------------------------------------------
// Fracture

const fractureCache = new Map<string, Vec2[][]>();

/**
 * Break an outline (with holes) into Voronoi pieces about `size` across (canvas pixels). Seeded and
 * deterministic. Holes are kept empty: pieces never cover a window cut out of a wall.
 */
export const fracture = (outline: readonly Vec2[], holes: readonly (readonly Vec2[])[], size: number, seed: number): Vec2[][] => {
  const key = simHash(stableJson({ outline, holes, size, seed }));
  const hit = fractureCache.get(key);
  if (hit) return hit;
  const xs = outline.map((p) => p[0]), ys = outline.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  // Keep the number of pieces bounded.
  let s = Math.max(4, size);
  while (Math.ceil((x1 - x0) / s) * Math.ceil((y1 - y0) / s) > MAX_FRAGMENTS) s *= 1.15;
  const nx = Math.max(1, Math.ceil((x1 - x0) / s)), ny = Math.max(1, Math.ceil((y1 - y0) / s));
  const cw = (x1 - x0) / nx, ch = (y1 - y0) / ny;
  const seeds: Vec2[] = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) seeds.push([x0 + (i + 0.15 + 0.7 * rand01(seed, i, j, 1)) * cw, y0 + (j + 0.15 + 0.7 * rand01(seed, i, j, 2)) * ch]);
  const base = ccw([...outline]);
  const convexHoles = holes.filter((h) => h.length >= 3).map((h) => hull2(h));
  const pieces: Vec2[][] = [];
  for (let k = 0; k < seeds.length; k++) {
    const p = seeds[k]!;
    const i = k % nx, j = Math.floor(k / nx);
    let cell: Vec2[] = base;
    for (let dj = -2; dj <= 2 && cell.length >= 3; dj++)
      for (let di = -2; di <= 2 && cell.length >= 3; di++) {
        if (!di && !dj) continue;
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const q = seeds[jj * nx + ii]!;
        cell = clipHalf(cell, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], [q[0] - p[0], q[1] - p[1]]);
      }
    if (cell.length < 3) continue;
    let parts: Vec2[][] = [cell];
    for (const h of convexHoles) {
      const hx = h.map((v) => v[0]), hy = h.map((v) => v[1]);
      parts = parts.flatMap((part) => {
        const px = part.map((v) => v[0]), py = part.map((v) => v[1]);
        if (Math.max(...px) <= Math.min(...hx) || Math.min(...px) >= Math.max(...hx) || Math.max(...py) <= Math.min(...hy) || Math.min(...py) >= Math.max(...hy)) return [part];
        return subtractConvex(part, h);
      });
    }
    for (const part of parts) if (Math.abs(polyArea(part)) > 4) pieces.push(ccw(part));
  }
  fractureCache.set(key, pieces);
  if (fractureCache.size > 24) fractureCache.delete(fractureCache.keys().next().value!);
  return pieces;
};

/**
 * Break an outline like glass: cracks radiating from an impact point, crossed by jagged rings —
 * splinters near the impact, long narrow wedges toward the edge, some cut again across a diagonal.
 * `size` (canvas pixels) sets the spacing of the first rings. Seeded and deterministic; holes stay
 * empty.
 */
export const glassShards = (outline: readonly Vec2[], holes: readonly (readonly Vec2[])[], size: number, seed: number): Vec2[][] => {
  const key = simHash(stableJson({ glass: 1, outline, holes, size, seed }));
  const hit = fractureCache.get(key);
  if (hit) return hit;
  const r = (k: number, i = 0, j = 0) => rand01(seed, i, j, k);
  const xs = outline.map((p) => p[0]), ys = outline.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  // Struck a little off-centre.
  const impact: Vec2 = [x0 + (x1 - x0) * (0.36 + 0.28 * r(1)), y0 + (y1 - y0) * (0.34 + 0.3 * r(2))];
  const reach = 1.05 * Math.max(...[[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => Math.hypot(x! - impact[0], y! - impact[1])));
  const step = Math.max(6, size);
  const spokes = Math.max(10, Math.min(28, Math.round(9 + (2.2 * reach) / step)));
  const angle = Array.from({ length: spokes }, (_, i) => ((i + 0.2 + 0.6 * r(3, i)) / spokes) * 2 * Math.PI);
  const radii: number[] = [];
  for (let rad = step * 0.4; rad < reach; rad *= 1.45 + 0.4 * r(4, radii.length)) radii.push(rad);
  radii.push(reach);
  const at = (i: number, k: number): Vec2 => {
    const s = i % spokes;
    const rad = radii[k]! * (k === radii.length - 1 ? 1 : 0.8 + 0.4 * r(5, s, k));
    return [impact[0] + Math.cos(angle[s]!) * rad, impact[1] + Math.sin(angle[s]!) * rad];
  };
  const cells: Vec2[][] = [];
  for (let i = 0; i < spokes; i++) {
    cells.push([impact, at(i, 0), at(i + 1, 0)]);
    for (let k = 0; k + 1 < radii.length; k++) {
      const q: Vec2[] = [at(i, k), at(i, k + 1), at(i + 1, k + 1), at(i + 1, k)];
      if (r(6, i, k) < 0.45) cells.push([q[0]!, q[1]!, q[2]!], [q[0]!, q[2]!, q[3]!]);
      else cells.push(q);
    }
  }
  const ring = (pts: readonly Vec2[]): [number, number][] => pts.map((p) => [p[0], p[1]]);
  const open = (rg: [number, number][]): Vec2[] => (rg.length > 1 && rg[0]![0] === rg.at(-1)![0] && rg[0]![1] === rg.at(-1)![1] ? rg.slice(0, -1) : rg) as Vec2[];
  const pieces: Vec2[][] = [];
  try {
    const whole = polygonClipping.difference([ring(outline)], ...holes.filter((h) => h.length >= 3).map((h) => [ring(h)]));
    for (const c of cells) {
      for (const poly of polygonClipping.intersection([ring(c)], whole)) {
        const o = open(poly[0]!);
        if (o.length >= 3 && Math.abs(polyArea(o)) > 4) pieces.push(ccw(o));
      }
      if (pieces.length >= MAX_FRAGMENTS) break;
    }
  } catch {
    // Degenerate outline: fall back to ordinary pieces.
    return fracture(outline, holes, size, seed);
  }
  fractureCache.set(key, pieces);
  if (fractureCache.size > 24) fractureCache.delete(fractureCache.keys().next().value!);
  return pieces;
};

/**
 * Break an outline like a masonry wall: courses of blocks `size` long and about half as tall, every
 * other course offset by half a block (running bond), lengths varying a little so it doesn't look
 * ruled. Blocks are clipped to the outline; holes stay empty. Seeded and deterministic.
 */
export const brickPieces = (outline: readonly Vec2[], holes: readonly (readonly Vec2[])[], size: number, seed: number): Vec2[][] => {
  const key = simHash(stableJson({ bricks: 1, outline, holes, size, seed }));
  const hit = fractureCache.get(key);
  if (hit) return hit;
  const xs = outline.map((p) => p[0]), ys = outline.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  let len = Math.max(8, size);
  while (Math.ceil((x1 - x0) / len + 1) * Math.ceil((y1 - y0) / (len * 0.48)) > MAX_FRAGMENTS) len *= 1.12;
  const tall = len * 0.48;
  const rows = Math.max(1, Math.round((y1 - y0) / tall));
  const rh = (y1 - y0) / rows;
  const cells: Vec2[][] = [];
  for (let j = 0; j < rows; j++) {
    const top = y0 + j * rh, bottom = top + rh;
    // Running bond: every other course starts half a block along.
    let x = x0 - (j % 2 ? len / 2 : 0) - len * 0.25 * rand01(seed, j, 0, 11);
    for (let i = 0; x < x1; i++) {
      const w = len * (0.8 + 0.4 * rand01(seed, i, j, 12));
      cells.push([
        [x, top],
        [x + w, top],
        [x + w, bottom],
        [x, bottom],
      ]);
      x += w;
    }
  }
  const ring = (pts: readonly Vec2[]): [number, number][] => pts.map((p) => [p[0], p[1]]);
  const open = (rg: [number, number][]): Vec2[] => (rg.length > 1 && rg[0]![0] === rg.at(-1)![0] && rg[0]![1] === rg.at(-1)![1] ? rg.slice(0, -1) : rg) as Vec2[];
  const pieces: Vec2[][] = [];
  try {
    const whole = polygonClipping.difference([ring(outline)], ...holes.filter((h) => h.length >= 3).map((h) => [ring(h)]));
    for (const c of cells) {
      for (const poly of polygonClipping.intersection([ring(c)], whole)) {
        const o = open(poly[0]!);
        if (o.length >= 3 && Math.abs(polyArea(o)) > 4) pieces.push(ccw(o));
      }
      if (pieces.length >= MAX_FRAGMENTS) break;
    }
  } catch {
    return fracture(outline, holes, size, seed);
  }
  fractureCache.set(key, pieces);
  if (fractureCache.size > 24) fractureCache.delete(fractureCache.keys().next().value!);
  return pieces;
};

/**
 * Cut an outline (minus holes) into blocks: a grid of squares, full-height columns or full-width
 * rows, `size` apart with `gap` between them (canvas pixels). Blocks are clipped to the outline.
 */
export const blockCells = (outline: readonly Vec2[], holes: readonly (readonly Vec2[])[], b: Pick<Blocks3D, "shape" | "size" | "gap" | "height" | "bond" | "offset">): Vec2[][] => {
  const key = simHash(stableJson({ blocks: 1, outline, holes, shape: b.shape, size: b.size, gap: b.gap, height: b.height ?? null, bond: b.bond ?? 0, offset: b.offset ?? null }));
  const hit = fractureCache.get(key);
  if (hit) return hit;
  const xs = outline.map((p) => p[0]), ys = outline.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  let s = Math.max(4, b.size);
  const count = () => (b.shape === "cubes" ? Math.ceil((x1 - x0) / s) * Math.ceil((y1 - y0) / s) : Math.ceil((b.shape === "columns" ? x1 - x0 : y1 - y0) / s));
  while (count() > MAX_FRAGMENTS) s *= 1.15;
  const gap = Math.max(0, Math.min(b.gap, s * 0.45)) / 2;
  const nx = b.shape === "rows" ? 1 : Math.max(1, Math.round((x1 - x0) / s));
  const ny = b.shape === "columns" ? 1 : Math.max(1, Math.round((y1 - y0) / s));
  const cw = (x1 - x0) / nx, ch = (y1 - y0) / ny;
  const gx = b.shape === "rows" ? 0 : gap, gy = b.shape === "columns" ? 0 : gap;
  const ring = (pts: readonly Vec2[]): [number, number][] => pts.map((p) => [p[0], p[1]]);
  const open = (rg: [number, number][]): Vec2[] => (rg.length > 1 && rg[0]![0] === rg.at(-1)![0] && rg[0]![1] === rg.at(-1)![1] ? rg.slice(0, -1) : rg) as Vec2[];
  const cells: Vec2[][] = [];
  const exact = b.height !== undefined || !!b.bond || !!b.offset;
  try {
    const whole = polygonClipping.difference([ring(outline)], ...holes.filter((h) => h.length >= 3).map((h) => [ring(h)]));
    const keep = (ax: number, ay: number, bx: number, by: number) => {
      for (const poly of polygonClipping.intersection([[[ax, ay], [bx, ay], [bx, by], [ax, by]]], whole)) {
        const o = open(poly[0]!);
        if (o.length >= 3 && Math.abs(polyArea(o)) > 4) cells.push(ccw(o));
      }
    };
    if (exact) {
      // Blocks of exactly their size (scaled up only if there would be too many), lined up from the
      // offset, every other row shifted by the bond, cut where the area ends.
      let w = Math.max(4, b.size), h = Math.max(4, b.height ?? b.size);
      while ((b.shape === "rows" ? 1 : Math.ceil((x1 - x0) / w) + 1) * (b.shape === "columns" ? 1 : Math.ceil((y1 - y0) / h) + 1) > MAX_FRAGMENTS) {
        w *= 1.15;
        h *= 1.15;
      }
      const [ox, oy] = b.offset ?? [x0, y0];
      const gw = b.shape === "rows" ? 0 : Math.min(gap * 2, w * 0.45) / 2, gh = b.shape === "columns" ? 0 : Math.min(gap * 2, h * 0.45) / 2;
      const rows = b.shape === "columns" ? [[y0, y1, 0]] : Array.from({ length: Math.floor((y1 - oy) / h) - Math.floor((y0 - oy) / h) + 1 }, (_, k) => {
        const j = Math.floor((y0 - oy) / h) + k;
        return [oy + j * h, oy + (j + 1) * h, j];
      });
      for (const [ay, by, j] of rows) {
        const shift = b.shape === "columns" ? 0 : (((((j as number) % 2) + 2) % 2) * (b.bond ?? 0) * w);
        if (b.shape === "rows") {
          keep(x0, (ay as number) + gh, x1, (by as number) - gh);
          continue;
        }
        const sx = ox + shift;
        for (let i = Math.floor((x0 - sx) / w); sx + i * w < x1; i++) keep(sx + i * w + gw, (ay as number) + gh, sx + (i + 1) * w - gw, (by as number) - gh);
      }
      if (!cells.length) return [ccw([...outline])];
      fractureCache.set(key, cells);
      if (fractureCache.size > 24) fractureCache.delete(fractureCache.keys().next().value!);
      return cells;
    }
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const ax = x0 + i * cw + gx, bx = x0 + (i + 1) * cw - gx;
        const ay = y0 + j * ch + gy, by = y0 + (j + 1) * ch - gy;
        for (const poly of polygonClipping.intersection([[[ax, ay], [bx, ay], [bx, by], [ax, by]]], whole)) {
          const o = open(poly[0]!);
          if (o.length >= 3 && Math.abs(polyArea(o)) > 4) cells.push(ccw(o));
        }
      }
  } catch {
    return [ccw([...outline])];
  }
  fractureCache.set(key, cells);
  if (fractureCache.size > 24) fractureCache.delete(fractureCache.keys().next().value!);
  return cells;
};

const smoothstep = (a: number, b: number, x: number) => {
  if (b <= a) return x >= b ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** One block's offset at a moment: pushed out `dz` metres, turned `angle` radians about `axis` through its middle. */
export interface BlockPose {
  readonly dz: number;
  readonly angle: number;
  readonly axis: "x" | "y";
}

const blockFrames = new WeakMap<readonly ResolvedPiece[], { x0: number; x1: number; y0: number; y1: number }>();

/**
 * Where block `i` of `pieces` is at `t` seconds into the layer. Worked out from time (no state), so
 * any frame can be drawn on its own — seeking, preview and export agree.
 */
export const blockPose = (b: Blocks3D, pieces: readonly ResolvedPiece[], i: number, t: number): BlockPose => {
  const piece = pieces[i];
  const axis = b.shape === "rows" ? "x" : "y";
  if (!piece) return { dz: 0, angle: 0, axis };
  let f = blockFrames.get(pieces);
  if (!f) {
    const cx = pieces.map((p) => p.center[0]), cy = pieces.map((p) => p.center[1]);
    f = { x0: Math.min(...cx), x1: Math.max(...cx), y0: Math.min(...cy), y1: Math.max(...cy) };
    blockFrames.set(pieces, f);
  }
  const envelope = smoothstep(b.startAt, b.startAt + b.ramp, t) * (b.stopAt === null ? 1 : 1 - smoothstep(b.stopAt - b.ramp, b.stopAt, t));
  if (envelope <= 0) return { dz: 0, angle: 0, axis };
  const [x, y] = piece.center;
  const r1 = rand01(b.seed, i, 0, 11), r2 = rand01(b.seed, i, 0, 12);
  const lambda = Math.max(0.05, b.wavelength * METERS_PER_PIXEL);
  const tau = 2 * Math.PI;
  let v: number;
  switch (b.pattern) {
    case "ripple": {
      // The origin across the area (y runs down on the canvas, up in metres).
      const ox = f.x0 + (f.x1 - f.x0) * b.origin[0], oy = f.y1 - (f.y1 - f.y0) * b.origin[1];
      v = Math.sin(tau * (Math.hypot(x - ox, y - oy) / lambda - b.speed * t));
      break;
    }
    case "wave": {
      const a = (b.direction * Math.PI) / 180;
      v = Math.sin(tau * ((x * Math.cos(a) + y * Math.sin(a)) / lambda - b.speed * t));
      break;
    }
    case "random":
      v = Math.sin(tau * (b.speed * (0.7 + 0.6 * r1) * t + r2));
      break;
    case "checker": {
      const s = Math.max(0.01, b.size * METERS_PER_PIXEL);
      const odd = (Math.floor((x - f.x0) / s + 0.5) + Math.floor((y - f.y0) / s + 0.5)) % 2 === 1;
      v = (odd ? -1 : 1) * Math.sin(tau * b.speed * t);
      break;
    }
    default:
      // Together, with a little spread so it breathes rather than moving as one slab.
      v = Math.sin(tau * b.speed * t + 0.6 * (r1 - 0.5));
  }
  const m = (b.bothWays ? v : (v + 1) / 2) * envelope;
  return b.motion === "turn" ? { dz: 0, angle: (b.amount * m * Math.PI) / 180, axis } : { dz: b.amount * METERS_PER_PIXEL * m, angle: 0, axis };
};

// ---------------------------------------------------------------------------------------------
// Resolving a scene for rendering and physics

export interface Canvas {
  readonly width: number;
  readonly height: number;
}

/** Canvas pixels → metres on the building front (z = 0). */
export const canvasToWorld = (p: Vec2, c: Canvas): Vec2 => [(p[0] - c.width / 2) * METERS_PER_PIXEL, (c.height - p[1]) * METERS_PER_PIXEL];

/** A solid made from a 2D outline (metres, relative to `center`), extruded `depth` back from its front. */
export interface ResolvedPiece {
  readonly outline: readonly Vec2[];
  readonly holes: readonly (readonly Vec2[])[];
  /** Rest position of the piece's centre in the object's space (front face at z = 0, or at the stand-out). */
  readonly center: Vec3;
  readonly depth: number;
  readonly area: number;
  /** A piece standing out along the camera's lines of sight: its back face is the outline × `scale`,
   *  moved by `shift` (piece-local metres) — a slightly tapered solid. Absent: front and back match. */
  readonly back?: { readonly scale: number; readonly shift: Vec2 };
}

/**
 * Where a point of the building front appears when it stands `z` metres out toward the show camera
 * (`camD` metres away, looking at the middle of the canvas), so that the camera still sees it on its
 * picture: along the line of sight, (camD − z) / camD of the way.
 */
export const alongSight = (p: Vec2, z: number, camD: number, canvas: Canvas): Vec2 => {
  const ax = 0, ay = (canvas.height * METERS_PER_PIXEL) / 2;
  const k = Math.max(0.01, (camD - z) / camD);
  return [ax + (p[0] - ax) * k, ay + (p[1] - ay) * k];
};

export interface ResolvedObject {
  readonly object: Object3D;
  /** Area geometry: one piece, or the fragments when it breaks. */
  readonly pieces: readonly ResolvedPiece[];
  /** Index of the object's first moving body in the prepared motion (−1 = not moving by physics). */
  readonly poseIndex: number;
  /** First frame its pose comes from the prepared motion (until then it follows its own animation). */
  readonly motionFrom?: number;
  /** Particles: where they're born. */
  readonly emitter?: import("./particles3d.ts").ParticleEmitter;
  /** One of the venue's house lights (its brightness and flicker follow show time, not the layer's). */
  readonly house?: HouseLight;
  /** × the house light's brightness in this scene (Scene3D.houseLightStrength). */
  readonly houseScale?: number;
}

export type PhysicsShape =
  | { readonly kind: "box"; readonly half: Vec3 }
  | { readonly kind: "ball"; readonly radius: number }
  | { readonly kind: "hull"; readonly points: readonly number[] }
  | { readonly kind: "mesh"; readonly points: readonly number[]; readonly indices: readonly number[] };

export interface PhysicsBody {
  /**
   * "fixed" never moves · "kinematic" follows `path` · "dynamic" simulated · "fragment" fixed until
   * released (at `release`, or by an impact) · "released" follows `path` until `release`, then is
   * simulated from the speed and spin it had.
   */
  readonly kind: "fixed" | "kinematic" | "dynamic" | "fragment" | "released";
  readonly shape: PhysicsShape;
  readonly mass: number;
  readonly friction: number;
  readonly restitution: number;
  readonly p: Vec3;
  readonly q: Quat;
  /** Kinematic: pose per frame [x,y,z,qx,qy,qz,qw]. */
  readonly path?: readonly number[];
  /** Fragment: frame it lets go, its push and spin, and its fly-back. */
  readonly release?: number;
  readonly velocity?: Vec3;
  readonly spin?: Vec3;
  readonly rebuild?: { readonly start: number; readonly frames: number; readonly delay: number };
  /** Frames it's there [from, to) (Object3D.activeFrom / activeTo): outside them nothing touches it. Absent: always. */
  readonly active?: readonly [number, number];
  /** Fragment of a surface that breaks where it's hit (no `release`): which surface, and how. With a
   *  `path`, it follows that until it's hit. */
  readonly impact?: { readonly group: number; readonly radius: number; readonly speed: number };
  /** Fragment: damped as it slows to a stop, and from this frame, once stopped, it stays where it lies (Fracture3D.settleAt). */
  readonly settle?: number;
  /** Where its pose is recorded in the prepared motion (−1 = not recorded). */
  readonly poseIndex: number;
}

export interface ResolvedPhysics {
  readonly key: string;
  readonly fps: number;
  readonly substeps: number;
  readonly frames: number;
  readonly gravity: Vec3;
  readonly bodies: readonly PhysicsBody[];
  /** Number of recorded bodies (7 floats per body per frame). */
  readonly movers: number;
}

export interface ResolvedScene3D {
  readonly scene: Scene3D;
  readonly canvas: Canvas;
  /** The camera distance it's drawn with (its own, or the building's viewpoint). */
  readonly cameraDistance: number;
  readonly photoAssetId?: Id;
  readonly objects: readonly ResolvedObject[];
  readonly physics: ResolvedPhysics | null;
  readonly fps: number;
  /** The scene's own camera at a layer time (Scene3D.camera), or null: the show camera. */
  readonly cameraAt: (t: Flicks) => CameraNow | null;
}

const seconds = (t: Flicks) => t / FLICKS_PER_SECOND;
const flicks = (s: number) => Math.round(s * FLICKS_PER_SECOND);

const piecesCache = new WeakMap<Geometry3D, { fracture: Fracture3D | undefined; cut: string; venue: unknown; w: number; h: number; camD: number; pieces: ResolvedPiece[] }>();
/** What decides how blocks cut the surface (their motion settings don't change the pieces). */
const blockCut = (b: Blocks3D | undefined) => (b ? `${b.shape}|${b.size}|${b.gap}|${b.height ?? ""}|${b.bond ?? 0}|${b.offset?.join(",") ?? ""}` : "");

/**
 * The object's pieces in its own space (metres). Kept while the area, the venue and the way it
 * breaks are unchanged, so editing a light or a colour never rebuilds the pieces.
 */
const piecesFor = (project: Project, o: Object3D, canvas: Canvas, venueId: Id | undefined, camD = 0): ResolvedPiece[] => {
  const g = o.geometry;
  if (!isPieced(g)) return [];
  if (g.kind === "panel") {
    const hit = piecesCache.get(g);
    const cut = o.fracture ? "" : blockCut(o.blocks);
    if (hit && hit.fracture === o.fracture && hit.cut === cut) return hit.pieces;
    const pieces = panelPieces(g, o.fracture, o.fracture ? undefined : o.blocks);
    piecesCache.set(g, { fracture: o.fracture, cut, venue: null, w: 0, h: 0, camD: 0, pieces });
    return pieces;
  }
  const venue = venueId ? project.venues[venueId] : undefined;
  const hit = piecesCache.get(g);
  const cut = o.fracture ? "" : blockCut(o.blocks);
  if (hit && hit.fracture === o.fracture && hit.cut === cut && hit.venue === venue && hit.w === canvas.width && hit.h === canvas.height && hit.camD === camD) return hit.pieces;
  const pieces = computePieces(project, g, o.fracture, canvas, venueId, o.fracture ? undefined : o.blocks, camD);
  piecesCache.set(g, { fracture: o.fracture, cut, venue, w: canvas.width, h: canvas.height, camD, pieces });
  return pieces;
};

const computePieces = (project: Project, g: Extract<Geometry3D, { kind: "area" }>, fr: Fracture3D | undefined, canvas: Canvas, venueId: Id | undefined, blocks?: Blocks3D, camD = 0): ResolvedPiece[] => {
  const regions = refRegions(project, g.ref, venueId).filter((r) => r.path.closed);
  const vid = venueId ?? project.activeVenueId;
  const venue = vid ? project.venues[vid] : undefined;
  const depth = Math.max(0.01, g.depth);
  // Areas cut out of this solid (their own pieces in the scene).
  const cuts = g.cut ? refRegions(project, g.cut, venueId).filter((r) => r.path.closed).map((r) => closedPoints(r.path)).filter((h) => h.length >= 3) : [];
  const out0 = Math.max(0, g.standOut ?? 0);
  const standing = out0 > 0 && camD > out0;
  const out: ResolvedPiece[] = [];
  for (const r of regions) {
    const outline = closedPoints(r.path);
    const holes = [...regionHoles(r, venue).map((h) => closedPoints(h)).filter((h) => h.length >= 3), ...cuts];
    if (outline.length < 3) continue;
    const polys = fr
      ? (fr.pattern === "glass" ? glassShards : fr.pattern === "bricks" ? brickPieces : fracture)(outline, holes, fr.pieceSize, fr.seed).map((p) => ({ outline: p, holes: [] as Vec2[][] }))
      : blocks
        ? blockCells(outline, holes, blocks).map((p) => ({ outline: p, holes: [] as Vec2[][] }))
        : solidWithHoles(outline, holes);
    // Standing out: the front moves along the camera's lines of sight (it still covers its picture),
    // and the back, `depth` behind it, along them too — a slightly tapered solid.
    const front = (p: Vec2): Vec2 => (standing ? alongSight(canvasToWorld(p, canvas), out0, camD, canvas) : canvasToWorld(p, canvas));
    const kRatio = standing ? (camD - out0 + depth) / (camD - out0) : 1;
    const axis: Vec2 = [0, (canvas.height * METERS_PER_PIXEL) / 2];
    for (const poly of polys) {
      const w = poly.outline.map(front);
      const c = polyCentroid(w);
      out.push({
        outline: w.map((p) => [p[0] - c[0], p[1] - c[1]] as Vec2),
        holes: poly.holes.map((h) => h.map(front).map((p) => [p[0] - c[0], p[1] - c[1]] as Vec2)),
        center: [c[0], c[1], out0 - depth / 2],
        depth,
        area: Math.abs(polyArea(w)),
        ...(standing ? { back: { scale: kRatio, shift: [(c[0] - axis[0]) * (kRatio - 1), (c[1] - axis[1]) * (kRatio - 1)] as Vec2 } } : {}),
      });
    }
  }
  return out;
};

/**
 * A panel's pieces (its own metres). Cut like an area — the fracture and block sizes are in cm, as
 * they are for areas (where 1 canvas pixel is 1 cm).
 */
const panelPieces = (g: Extract<Geometry3D, { kind: "panel" }>, fr: Fracture3D | undefined, blocks?: Blocks3D): ResolvedPiece[] => {
  const cm = (p: Vec2): Vec2 => [p[0] * 100, p[1] * 100];
  const outline = g.outline.map(cm);
  if (outline.length < 3) return [];
  const holes = (g.holes ?? []).filter((h) => h.length >= 3).map((h) => h.map(cm));
  const depth = Math.max(0.005, g.depth);
  const polys = fr
    ? (fr.pattern === "glass" ? glassShards : fr.pattern === "bricks" ? brickPieces : fracture)(outline, holes, fr.pieceSize, fr.seed).map((p) => ({ outline: p, holes: [] as Vec2[][] }))
    : blocks
      ? blockCells(outline, holes, blocks).map((p) => ({ outline: p, holes: [] as Vec2[][] }))
      : solidWithHoles(outline, holes);
  const m = (p: Vec2): Vec2 => [p[0] / 100, p[1] / 100];
  return polys.map((poly) => {
    const w = poly.outline.map(m);
    const c = polyCentroid(w);
    return {
      outline: w.map((p) => [p[0] - c[0], p[1] - c[1]] as Vec2),
      holes: poly.holes.map((h) => h.map(m).map((p) => [p[0] - c[0], p[1] - c[1]] as Vec2)),
      center: [c[0], c[1], -depth / 2] as Vec3,
      depth,
      area: Math.abs(polyArea(w)),
    };
  });
};

const scaleOf = (o: Object3D, t: Flicks): Vec3 => evalProp(o.scale, t).map((s) => s / 100) as unknown as Vec3;

const chunk = <T>(a: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

const shapeFor = (o: Object3D, piece: ResolvedPiece | null, scale: Vec3, fixed: boolean, modelHull?: readonly number[]): PhysicsShape | null => {
  const g = o.geometry;
  if (!g) return null;
  const [sx, sy, sz] = scale;
  // A model: its measured hull (none until it has been measured, so it can't collide yet).
  if (g.kind === "model") return modelHull && modelHull.length >= 12 ? { kind: "hull", points: modelHull.map((v, i) => v * Math.abs(i % 3 === 0 ? sx : i % 3 === 1 ? sy : sz)) } : null;
  if (g.kind === "box") return { kind: "box", half: [(g.size[0] * Math.abs(sx)) / 2, (g.size[1] * Math.abs(sy)) / 2, (g.size[2] * Math.abs(sz)) / 2] };
  if (g.kind === "sphere") return { kind: "ball", radius: g.radius * Math.max(Math.abs(sx), Math.abs(sy), Math.abs(sz)) };
  if (g.kind === "plane") return { kind: "box", half: [(g.size[0] * Math.abs(sx)) / 2, (g.size[1] * Math.abs(sy)) / 2, 0.01] };
  if (!piece) return null;
  const d = piece.depth / 2;
  if (fixed && (piece.holes.length || polyArea(hull2(piece.outline)) > Math.abs(polyArea(piece.outline)) * 1.02)) {
    // A fixed wall with openings or notches keeps them open: an exact triangle mesh (outline and holes, front and back).
    const ring = (pts: readonly Vec2[]) => pts.map((p) => [p[0] * sx, p[1] * sy] as Vec2);
    const all = [ring(piece.outline), ...piece.holes.map(ring)];
    const points: number[] = [];
    const indices: number[] = [];
    for (const r of all) {
      const base = points.length / 3;
      for (const p of r) points.push(p[0], p[1], d * sz, p[0], p[1], -d * sz);
      for (let i = 0; i < r.length; i++) {
        const a = base + i * 2, b = base + ((i + 1) % r.length) * 2;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    // Front and back faces, triangulated with the holes left open (each ring's points come in front/back pairs).
    const flat: number[] = [];
    const starts: number[] = [];
    for (const [k, r] of all.entries()) {
      if (k) starts.push(flat.length / 2);
      for (const q of r) flat.push(q[0], q[1]);
    }
    for (const t of chunk(earcut(flat, starts), 3)) indices.push(t[0]! * 2, t[1]! * 2, t[2]! * 2, t[0]! * 2 + 1, t[2]! * 2 + 1, t[1]! * 2 + 1);
    return { kind: "mesh", points, indices };
  }
  // Slightly smaller than drawn, so neighbouring pieces don't start out overlapping.
  const k = 0.97;
  const points: number[] = [];
  for (const p of piece.outline) points.push(p[0] * sx * k, p[1] * sy * k, d * sz * k, p[0] * sx * k, p[1] * sy * k, -d * sz * k);
  return { kind: "hull", points };
};

/** Frames until an object's own animation stops changing (all of them when it rides on something). */
const animationFrames = (o: Object3D, fps: number, frames: number): number => {
  if (o.attach) return frames;
  const last = Math.max(0, ...[o.position, o.rotation, o.scale].flatMap((p) => (p.keyframes ?? []).map((k) => k.t)));
  return Math.max(1, Math.min(frames, Math.ceil(seconds(last) * fps) + 2));
};

/** The frames an object is there for physics (its active times), or undefined: always. */
const activeFrames = (o: Object3D, fps: number, frames: number): [number, number] | undefined => {
  if (o.activeFrom === undefined && o.activeTo === undefined) return undefined;
  const a = o.activeFrom === undefined ? 0 : Math.max(0, Math.ceil(o.activeFrom * fps - 1e-6));
  const b = o.activeTo === undefined ? frames : Math.min(frames, Math.ceil(o.activeTo * fps - 1e-6));
  return [a, Math.max(a, b)];
};

const resolveCache = new WeakMap<Scene3D, Array<{ sig: string; venue: unknown; result: ResolvedScene3D }>>();
let resolves = 0;
/** How many times a 3D scene has been worked out from scratch (not remembered) in this window (diagnostics: playing prepared frames needs none). */
export const scene3dResolves = (): number => resolves;

/**
 * Everything needed to draw and simulate a 3D scene shown in a layer `frames` frames long at `fps`.
 * Memoised on the scene and venue, so evaluating every frame stays cheap.
 */
export const resolveScene3D = (project: Project, scene: Scene3D, opts: { venueId?: Id; canvas: Canvas; fps: number; frames: number }): ResolvedScene3D => {
  const venue = opts.venueId ? project.venues[opts.venueId] : undefined;
  const sig = `${opts.venueId}|${opts.canvas.width}x${opts.canvas.height}|${opts.fps}|${opts.frames}|${venue?.referenceAssetId}|${venue?.cameraDistance}`;
  const list = resolveCache.get(scene) ?? [];
  const hit = list.find((e) => e.sig === sig && e.venue === venue);
  if (hit) return hit.result;

  resolves++;
  const { canvas, fps, frames } = opts;
  const camDist = sceneCameraDistance(project, scene, opts.venueId);
  const objects: ResolvedObject[] = [];
  const bodies: PhysicsBody[] = [];
  let movers = 0;
  const frameTime = (f: number) => flicks(f / fps);
  for (const id of scene.objectOrder) {
    const o = scene.objects[id];
    if (!o) continue;
    const pieces = piecesFor(project, o, canvas, opts.venueId, camDist * canvas.width * METERS_PER_PIXEL);
    const ph = o.kind === "mesh" ? o.physics : undefined;
    const modelHull = o.geometry?.kind === "model" ? project.assets[o.geometry.assetId]?.meta.model?.hull : undefined;
    let poseIndex = -1;
    let motionFrom: number | undefined;
    if (ph && o.geometry) {
      const fr = isPieced(o.geometry) ? o.fracture : undefined;
      const impact = fr?.trigger === "impact";
      // Pose of the object when it starts moving under physics (a surface broken by an impact: as it
      // stands at the start; it's fixed until hit).
      const t0 = fr && !impact ? flicks(fr.collapseAt) : 0;
      const pose0 = objectPose(scene, o, t0);
      const q = pose0.q;
      const sc = pose0.scale;
      const animated = animatedIn3D(o);
      const placed = pose0.place;
      const common = { friction: Math.max(0, ph.friction), restitution: Math.min(1, Math.max(0, ph.bounce)) };
      if (fr && ph.body === "dynamic" && pieces.length) {
        poseIndex = movers;
        motionFrom = impact ? 0 : Math.max(0, Math.round(fr.collapseAt * fps));
        const group = bodies.length;
        const total = pieces.reduce((s, p) => s + p.area, 0) || 1;
        const release0 = Math.max(0, Math.round(fr.collapseAt * fps));
        const rebuildStart = fr.rebuildAt !== null && fr.rebuildAt > fr.collapseAt ? Math.round(fr.rebuildAt * fps) : null;
        const rebuildFrames = Math.max(1, Math.round(fr.rebuildSeconds * fps));
        // Pieces return bottom-up, each a little after the one below.
        const order = pieces.map((p, i) => [p.center[1], i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        // Higher pieces are pushed harder, so the top topples outward and the rest loses its support.
        const ys = pieces.map((p) => p.center[1]);
        const yLo = Math.min(...ys), ySpan = Math.max(1e-6, Math.max(...ys) - yLo);
        const rank = new Map(order.map(([, i], r) => [i, r]));
        // A surface broken by an impact that moves (shaken by blows before it gives way): its pieces
        // follow its animation until they're hit.
        const poses = impact && animated ? Array.from({ length: animationFrames(o, fps, frames) }, (_, f) => objectPose(scene, o, frameTime(f))) : null;
        pieces.forEach((piece, i) => {
          const r1 = rand01(fr.seed, i, 11), r2 = rand01(fr.seed, i, 12), r3 = rand01(fr.seed, i, 13);
          const spin = fr.spin * 2 * Math.PI;
          const h = (piece.center[1] - yLo) / ySpan;
          // Crumbling: the top lets go first, the rest following down the wall.
          const release = fr.stagger ? release0 + Math.round(fr.stagger * fps * Math.min(1, Math.max(0, (1 - h) * (0.85 + 0.3 * r1)))) : release0;
          bodies.push({
            kind: "fragment",
            shape: shapeFor(o, piece, sc, false)!,
            mass: Math.max(0.01, (ph.mass * piece.area) / total),
            ...common,
            p: placed(piece.center),
            q,
            ...(poses ? { path: poses.flatMap((ps) => [...ps.place(piece.center), ...ps.q]) } : {}),
            ...(impact ? { impact: { group, radius: Math.max(0.05, fr.impactRadius ?? 0.8), speed: Math.max(0, fr.impactSpeed ?? 3) } } : { release }),
            velocity: [(r1 - 0.5) * fr.push * 0.5, (r2 - 0.3) * fr.push * 0.3, fr.push * (0.2 + 1.6 * h) * (0.7 + 0.6 * r3)],
            spin: [(r2 - 0.5) * spin, (r3 - 0.5) * spin, (r1 - 0.5) * spin],
            ...(rebuildStart !== null ? { rebuild: { start: rebuildStart, frames: rebuildFrames, delay: Math.round(((rank.get(i) ?? 0) / Math.max(1, pieces.length)) * rebuildFrames * 0.6) } } : {}),
            ...(fr.settleAt !== undefined && fr.settleAt !== null ? { settle: Math.max(0, Math.round(fr.settleAt * fps)) } : {}),
            poseIndex: movers++,
          });
        });
      } else {
        const fixed = ph.body === "static";
        const list = pieces.length ? pieces : [null];
        const moving = !fixed || animated;
        const list2 = list.filter((piece) => shapeFor(o, piece, sc, fixed, modelHull));
        if (moving && list2.length) {
          poseIndex = movers;
          motionFrom = 0;
        }
        const total = pieces.reduce((s, p) => s + p.area, 0) || 1;
        for (const piece of list2) {
          const shape = shapeFor(o, piece, sc, fixed, modelHull)!;
          const center: Vec3 = piece ? piece.center : [0, 0, 0];
          // A dynamic body that lets go later follows its animation until then.
          const releaseFrame = !fixed && ph.releaseAt !== undefined ? Math.min(frames - 1, Math.max(0, Math.round(ph.releaseAt * fps))) : -1;
          let path: number[] | undefined;
          let velocity: Vec3 | undefined;
          let spin: Vec3 | undefined;
          if ((fixed && animated) || releaseFrame >= 0) {
            path = [];
            const last = fixed ? frames - 1 : releaseFrame;
            for (let f = 0; f <= last; f++) {
              const pose = objectPose(scene, o, frameTime(f));
              path.push(...pose.place(center), ...pose.q);
            }
            if (releaseFrame >= 0) {
              // The speed and spin it has as it lets go.
              const a = objectPose(scene, o, frameTime(Math.max(0, releaseFrame - 1)));
              const b = objectPose(scene, o, frameTime(releaseFrame));
              const pa = a.place(center);
              const pb = b.place(center);
              const dt = releaseFrame > 0 ? 1 / fps : 1;
              velocity = releaseFrame > 0 ? [(pb[0] - pa[0]) / dt, (pb[1] - pa[1]) / dt, (pb[2] - pa[2]) / dt] : [0, 0, 0];
              spin = releaseFrame > 0 ? angularVelocity(a.q, b.q, dt) : [0, 0, 0];
            }
          }
          const p0: Vec3 = path ? [path[0]!, path[1]!, path[2]!] : placed(center);
          const active = activeFrames(o, fps, frames);
          const q0: Quat = path ? [path[3]!, path[4]!, path[5]!, path[6]!] : q;
          bodies.push({
            kind: releaseFrame >= 0 ? "released" : fixed ? (path ? "kinematic" : "fixed") : "dynamic",
            shape,
            mass: Math.max(0.01, piece ? (ph.mass * piece.area) / total : ph.mass),
            ...common,
            p: p0,
            q: q0,
            ...(path ? { path } : {}),
            ...(releaseFrame >= 0 ? { release: releaseFrame, velocity: velocity!, spin: spin! } : {}),
            ...(active ? { active } : {}),
            poseIndex: moving ? movers++ : -1,
          });
        }
      }
    }
    const m = motionFrom !== undefined && poseIndex >= 0 ? { motionFrom } : {};
    if (o.kind === "particles" && o.particles) {
      objects.push({ object: o, pieces, poseIndex, ...m, emitter: particleEmitter(project, o.particles, opts.venueId, canvas) });
      continue;
    }
    objects.push({ object: o, pieces, poseIndex, ...m });
  }
  // The venue's house lights (candles, torches), placed on this scene's camera line through each flame.
  if (scene.houseLights !== false && venue?.lights?.length) {
    const cam = sceneCameraAt(project, scene, 0);
    const show = showCamera(canvas, camDist);
    for (const L of venue.lights) {
      let eye: Vec3;
      let through: Vec3;
      if (cam) {
        const f = canvas.height / 2 / Math.tan((cam.fovY * Math.PI) / 360);
        const d = rotateByQuat([(L.at[0] - canvas.width / 2) / f, -(L.at[1] - canvas.height / 2) / f, -1], cam.q);
        eye = cam.eye;
        through = [eye[0] + d[0], eye[1] + d[1], eye[2] + d[2]];
      } else {
        const c = canvasToWorld([L.at[0], L.at[1]], canvas);
        eye = show.eye;
        through = [c[0], c[1], 0];
      }
      const position = houseLightPlace(eye, through, L.depth);
      const object = lightObject(`house-light:${L.id}`, L.name, { type: "point", color: L.color, intensity: staticProp(0), castShadow: L.castShadow, softness: L.softness, range: L.range, falloff: L.falloff, balance: false }, position);
      objects.push({ object, pieces: [], poseIndex: -1, house: L, houseScale: scene.houseLightStrength ?? 1 });
    }
  }
  const anyMoving = bodies.some((b) => b.kind === "dynamic" || b.kind === "fragment" || b.kind === "released");
  const physics: ResolvedPhysics | null = anyMoving
    ? (() => {
        const body = { v: PHYSICS_ENGINE_VERSION, fps, substeps: PHYSICS_SUBSTEPS, frames, gravity: scene.gravity, bodies };
        return { key: `phys-${simHash(stableJson(body))}`, fps, substeps: PHYSICS_SUBSTEPS, frames, gravity: scene.gravity, bodies, movers };
      })()
    : null;
  const cameraAt = (t: Flicks) => sceneCameraAt(project, scene, t);
  const result: ResolvedScene3D = { scene, canvas, cameraDistance: camDist, ...(venue?.referenceAssetId ? { photoAssetId: venue.referenceAssetId } : {}), objects, physics, fps, cameraAt };
  list.push({ sig, venue, result });
  // A scene shown by several layers of different lengths is resolved once for each; keep them all.
  if (list.length > 16) list.shift();
  resolveCache.set(scene, list);
  return result;
};

/** Pose of a recorded body at a frame from prepared motion (7 floats: x,y,z,qx,qy,qz,qw). */
export const poseAt = (data: Float32Array, movers: number, frame: number, index: number): { p: Vec3; q: Quat } => {
  const o = (frame * movers + index) * 7;
  return { p: [data[o]!, data[o + 1]!, data[o + 2]!], q: [data[o + 3]!, data[o + 4]!, data[o + 5]!, data[o + 6]!] };
};

/** Show camera for a canvas: looks straight at the building front, which exactly fills the frame. */
export const showCamera = (canvas: Canvas, distance: number): { eye: Vec3; target: Vec3; fovY: number; aspect: number } => {
  const w = canvas.width * METERS_PER_PIXEL;
  const h = canvas.height * METERS_PER_PIXEL;
  const d = Math.max(0.2, distance) * w;
  return { eye: [0, h / 2, d], target: [0, h / 2, 0], fovY: (2 * Math.atan(h / 2 / d) * 180) / Math.PI, aspect: canvas.width / canvas.height };
};

// ---------------------------------------------------------------------------------------------
// Presets (they produce ordinary, editable objects)

const grey = (v: number, a = 1): RGBA => [v, v, v, a];

const mesh = (id: Id, name: string, geometry: Geometry3D, position: Vec3, material: Partial<Material3D> = {}, extra: Partial<Object3D> = {}): Object3D => ({
  id,
  name,
  kind: "mesh",
  visible: true,
  position: staticProp(position, true),
  rotation: staticProp<Vec3>([0, 0, 0]),
  scale: staticProp<Vec3>([100, 100, 100]),
  geometry,
  material: { style: "color", color: staticProp(grey(0.6)), roughness: 0.85, metalness: 0, glow: staticProp(0), opacity: 1, ...material },
  castShadow: true,
  receiveShadow: true,
  ...extra,
});

export const lightObject = (id: Id, name: string, light: Partial<Light3D>, position: Vec3): Object3D => ({
  id,
  name,
  kind: "light",
  visible: true,
  position: staticProp(position, true),
  rotation: staticProp<Vec3>([0, 0, 0]),
  scale: staticProp<Vec3>([100, 100, 100]),
  light: { type: "directional", color: [1, 0.97, 0.92, 1], intensity: staticProp(3), castShadow: true, target: [0, 0, 0], angle: 35, softness: 0.4, ...light },
});

export const boxObject = (id: Id, name: string, size: Vec3, position: Vec3, physics?: Physics3D): Object3D =>
  mesh(id, name, { kind: "box", size }, position, {}, physics ? { physics } : {});

/** A traced area as its own solid in a scene (the building photo on it), optionally standing out toward
 *  the audience and with other areas cut out of it. Fixed in place until given physics. */
export const areaObject = (id: Id, name: string, ref: RegionRef, opts: { depth?: number; standOut?: number; cut?: RegionRef } = {}): Object3D =>
  mesh(id, name, { kind: "area", ref, depth: Math.max(0.01, opts.depth ?? 0.25), ...(opts.standOut ? { standOut: opts.standOut } : {}), ...(opts.cut ? { cut: opts.cut } : {}) }, [0, 0, 0], { style: "photo", color: staticProp<RGBA>([1, 1, 1, 1]), roughness: 0.9 });

/**
 * A 3D model from a file. With `heightM` (and the model's measurements) it's scaled to that height;
 * it stands with its lowest point at `position`'s height.
 */
export const modelObject = (id: Id, name: string, assetId: Id, info: import("./model.ts").ModelInfo | undefined, position: Vec3, heightM?: number): Object3D => {
  const h = info ? info.bounds[4] - info.bounds[1] : 0;
  const k = heightM && h > 1e-6 ? heightM / h : 1;
  const lift = info ? -info.bounds[1] * k : 0;
  return {
    id,
    name,
    kind: "mesh",
    visible: true,
    position: staticProp<Vec3>([position[0], position[1] + lift, position[2]], true),
    rotation: staticProp<Vec3>([0, 0, 0]),
    scale: staticProp<Vec3>([k * 100, k * 100, k * 100]),
    geometry: { kind: "model", assetId },
    castShadow: true,
    receiveShadow: true,
    clip: { speed: 1, offset: 0 },
  };
};

/**
 * A picture standing in the scene (a cut-out character or prop: a PNG's transparent parts are cut
 * out, from the picture and its shadow), `heightM` tall, `aspect` (width ÷ height) wide, standing
 * on `base` (the middle of its bottom edge). It casts shadows and shares the scene's depth.
 */
export const pictureObject = (id: Id, name: string, assetId: Id, aspect: number, heightM: number, base: Vec3): Object3D =>
  mesh(id, name, { kind: "plane", size: [heightM * Math.max(0.01, aspect), heightM] }, [base[0], base[1] + heightM / 2, base[2]], { style: "image", assetId, color: staticProp<RGBA>([1, 1, 1, 1]), roughness: 0.9 }, { receiveShadow: false });

/**
 * A flat solid in the scene's own space (see Geometry3D "panel"): `outline` in metres in its x–y
 * plane, standing at `position`. With a scene camera it shows the picture projected through it.
 */
export const panelObject = (id: Id, name: string, outline: readonly Vec2[], depth: number, position: Vec3, opts: { holes?: readonly (readonly Vec2[])[]; projected?: boolean } = {}): Object3D =>
  mesh(id, name, { kind: "panel", outline, ...(opts.holes?.length ? { holes: opts.holes } : {}), depth: Math.max(0.005, depth) }, position, opts.projected ? { style: "photo", color: staticProp<RGBA>([1, 1, 1, 1]), roughness: 0.9, mapping: "camera" } : {});

/** A controller (After Effects' null): only a position, turn and size over time, for others to ride on. */
export const nullObject = (id: Id, name: string, position: Vec3): Object3D => ({
  id,
  name,
  kind: "null",
  visible: true,
  position: staticProp(position, true),
  rotation: staticProp<Vec3>([0, 0, 0]),
  scale: staticProp<Vec3>([100, 100, 100]),
});

/**
 * Where the scene camera sees canvas point `px` on the plane z = `planeZ` (scene metres), or null
 * when that ray doesn't reach it in front of the camera: a traced outline laid onto a modelled wall.
 */
export const onPlaneThrough = (cam: CameraNow, canvas: Canvas, px: Vec2, planeZ: number): Vec3 | null => {
  const f = canvas.height / 2 / Math.tan((cam.fovY * Math.PI) / 360);
  const dir = rotateByQuat([(px[0] - canvas.width / 2) / f, -(px[1] - canvas.height / 2) / f, -1], cam.q);
  if (Math.abs(dir[2]) < 1e-9) return null;
  const k = (planeZ - cam.eye[2]) / dir[2];
  if (!(k > 0)) return null;
  return [cam.eye[0] + dir[0] * k, cam.eye[1] + dir[1] * k, planeZ];
};

export const ballObject = (id: Id, name: string, radius: number, position: Vec3, physics?: Physics3D): Object3D =>
  mesh(id, name, { kind: "sphere", radius }, position, { color: staticProp<RGBA>([0.9, 0.5, 0.2, 1]), roughness: 0.4 }, physics ? { physics } : {});

export const DEFAULT_FRACTURE: Fracture3D = { pieceSize: 70, seed: 1, collapseAt: 1, rebuildAt: 5, rebuildSeconds: 2, push: 0.6, spin: 0.25 };
/** Ways an area breaks apart, all with real physics (Rapier). */
export const FRACTURE_PRESETS: Record<"collapse" | "explode" | "crumble" | "shatter", { title: string; description: string; fracture: Fracture3D }> = {
  collapse: { title: "Collapse & rebuild (3D)", description: "The area becomes a solid slab that breaks into pieces, falls onto a ledge with real physics, then flies back.", fracture: DEFAULT_FRACTURE },
  explode: {
    title: "Explode (3D)",
    description: "The area bursts into small pieces that fly out toward the audience, tumbling, and fall — real physics.",
    fracture: { pieceSize: 45, seed: 1, collapseAt: 1, rebuildAt: null, rebuildSeconds: 2, push: 5, spin: 1.5 },
  },
  crumble: {
    title: "Crumble (3D)",
    description: "The area crumbles from the top down into small pieces that drop and pile up at its foot — real physics.",
    // A nudge off the wall, so each piece peels away in front of those still holding.
    fracture: { pieceSize: 35, seed: 1, collapseAt: 1, rebuildAt: null, rebuildSeconds: 2, push: 0.8, spin: 0.4, stagger: 1.8 },
  },
  shatter: {
    title: "Shatter like glass (3D)",
    description: "The area shatters like a pane of glass — thin, see-through shards burst out from where it's struck, tumble and fall — real physics.",
    fracture: { pieceSize: 22, seed: 1, collapseAt: 1, rebuildAt: null, rebuildSeconds: 2, push: 2.6, spin: 1.2, pattern: "glass" },
  },
};
/** Blocks: the surface as cubes, columns or slats moving in a pattern (procedural). */
export const DEFAULT_BLOCKS: Blocks3D = { shape: "cubes", size: 50, gap: 4, motion: "push", pattern: "pulse", amount: 40, bothWays: false, speed: 0.5, wavelength: 300, direction: 0, origin: [0.5, 0.5], startAt: 0.5, stopAt: 7.5, ramp: 1, seed: 1 };
export const BLOCK_PRESETS: Record<"pulse" | "ripple" | "wave" | "columns" | "slats", { title: string; description: string; blocks: Blocks3D }> = {
  pulse: { title: "Pulsing cubes (3D)", description: "The surface becomes a grid of cubes that push out of the wall and sink back, breathing together.", blocks: DEFAULT_BLOCKS },
  ripple: {
    title: "Cube ripple (3D)",
    description: "Cubes rise and fall in rings spreading out from a point, like a drop in water.",
    blocks: { ...DEFAULT_BLOCKS, pattern: "ripple", size: 40, amount: 45, speed: 0.6, wavelength: 260 },
  },
  wave: {
    title: "Cube wave (3D)",
    description: "A wave of cubes rolls across the surface, each one pushing out as it passes.",
    blocks: { ...DEFAULT_BLOCKS, pattern: "wave", size: 40, amount: 50, speed: 0.45, wavelength: 420 },
  },
  columns: {
    title: "Rising columns (3D)",
    description: "The surface splits into tall columns that push out one after another, like organ pipes.",
    blocks: { ...DEFAULT_BLOCKS, shape: "columns", size: 45, gap: 5, pattern: "wave", amount: 60, speed: 0.4, wavelength: 500 },
  },
  slats: {
    title: "Flipping slats (3D)",
    description: "The surface becomes tall slats that turn like louvres, showing their sides as a wave passes.",
    blocks: { ...DEFAULT_BLOCKS, shape: "columns", size: 35, gap: 3, motion: "turn", pattern: "wave", amount: 75, bothWays: true, speed: 0.35, wavelength: 600 },
  },
};

/** What a glass shatter is made of: a thin pane (cm) and a clear, glossy material. */
export const GLASS = { thicknessCm: 1.2, opacity: 0.6, roughness: 0.06, metalness: 0.15 };

export const DEFAULT_PHYSICS: Physics3D = { body: "dynamic", mass: 2000, friction: 0.7, bounce: 0.15 };

/** Bounds of areas on the canvas (pixels). */
const areaBounds = (project: Project, ref: RegionRef, venueId?: Id) => {
  const pts = refRegions(project, ref, venueId).flatMap((r) => flattenPath(r.path, 4));
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};

/**
 * A 3D scene for a building area given thickness: the area as a solid with the building photo on
 * its front, a dark space behind it, a ledge along its bottom, the ground, a key light and a soft
 * fill. With `collapse`, the area breaks into pieces that fall onto the ledge and fly back.
 */
export const areaScene = (
  project: Project,
  o: { sceneId: Id; idPrefix: string; name: string; ref: RegionRef; venueId?: Id; canvas: Canvas; depth?: number; collapse?: boolean; fracture?: Fracture3D; blocks?: Blocks3D },
): Scene3D => {
  const p = o.idPrefix;
  const b = areaBounds(project, o.ref, o.venueId) ?? { x0: o.canvas.width * 0.25, x1: o.canvas.width * 0.75, y0: o.canvas.height * 0.25, y1: o.canvas.height * 0.75 };
  // Glass is a thin, clear, glossy pane.
  const glass = !!o.collapse && o.fracture?.pattern === "glass";
  const depth = o.depth ?? (glass ? GLASS.thicknessCm / 100 : 0.3);
  const [lx0, ly] = canvasToWorld([b.x0, b.y1], o.canvas);
  const [lx1, top] = canvasToWorld([b.x1, b.y0], o.canvas);
  const width = lx1 - lx0;
  const cx = (lx0 + lx1) / 2;
  const ledgeH = ly > 0.05 && ly <= 1.5 ? ly : 0.3;
  const blocks = !!o.blocks && !o.collapse;
  const objects: Object3D[] = [
    mesh(`${p}-area`, glass ? "Glass (3D)" : o.blocks ? "Blocks (3D)" : "Wall (3D)", { kind: "area", ref: o.ref, depth }, [0, 0, 0], { style: "photo", color: staticProp(grey(1)), ...(glass ? { opacity: GLASS.opacity, roughness: GLASS.roughness, metalness: GLASS.metalness } : {}) }, {
      physics: o.collapse ? DEFAULT_PHYSICS : { ...DEFAULT_PHYSICS, body: "static" },
      ...(o.collapse ? { fracture: o.fracture ?? DEFAULT_FRACTURE } : {}),
      ...(o.blocks && !o.collapse ? { blocks: o.blocks } : {}),
    }),
    // Blocks need nothing behind or below them: the gaps stay empty (no light), and whatever is under
    // the layer shows through. Breaking apart needs the dark inside, a ledge and the ground to land on.
    ...(blocks
      ? []
      : [
          mesh(`${p}-inside`, "Inside (behind the wall)", { kind: "box", size: [width + 0.2, top - ly + 0.2, 0.2] }, [cx, (top + ly) / 2, -depth - 0.6], { color: staticProp(grey(0.08)), roughness: 1 }, { castShadow: false }),
          // A ledge along the bottom: a solid plinth when the area starts near the ground, else a 30 cm slab.
          mesh(`${p}-ledge`, "Ledge", { kind: "box", size: [width + 0.6, ledgeH, depth + 2] }, [cx, ly - ledgeH / 2, (2 - depth) / 2], { color: staticProp(grey(0.45)) }, {
            physics: { body: "static", mass: 1000, friction: 0.8, bounce: 0.1 },
          }),
          mesh(`${p}-ground`, "Ground", { kind: "box", size: [60, 0.2, 40] }, [0, -0.1, 0], { style: "shadow", opacity: 0.6 }, {
            physics: { body: "static", mass: 1000, friction: 0.9, bounce: 0.05 },
            castShadow: false,
          }),
        ]),
    // Blocks read by their shading and shadows: light from low and to the side.
    blocks
      ? lightObject(`${p}-key`, "Key light", { target: [cx, (top + ly) / 2, 0], intensity: staticProp(3.6) }, [cx - width * 0.75, top + 1.5, 3.2])
      : lightObject(`${p}-key`, "Key light", { target: [cx, (top + ly) / 2, 0] }, [cx - width * 0.6, top + 3, 6]),
    lightObject(`${p}-fill`, "Soft fill", { type: "ambient", intensity: staticProp(blocks ? 0.3 : 0.35), castShadow: false, color: [0.8, 0.86, 1, 1] }, [0, 0, 0]),
  ];
  return { id: o.sceneId, name: o.name, objectOrder: objects.map((x) => x.id), objects: Object.fromEntries(objects.map((x) => [x.id, x])), gravity: [0, -9.81, 0] };
};

// ---- the whole house in 3D ----------------------------------------------------------------------------

/** Usual depth of an area kind in 3D (metres): stands out (+) or is set back (−), and thickness. */
export const KIND_DEPTH: Partial<Record<import("./model.ts").RegionKind, { readonly standOut: number; readonly thickness: number }>> = {
  wall: { standOut: 0, thickness: 0.3 },
  roof: { standOut: 0, thickness: 0.3 },
  column: { standOut: 0.35, thickness: 0.35 },
  light: { standOut: 0.06, thickness: 0.12 },
  window: { standOut: -0.12, thickness: 0.05 },
  door: { standOut: -0.1, thickness: 0.06 },
  garage: { standOut: -0.08, thickness: 0.06 },
  vent: { standOut: -0.04, thickness: 0.05 },
};
/** Kinds that aren't solids (lines and keep-dark areas). */
const NOT_SOLID = new Set<string>(["roofline", "edge", "exclusion"]);

/** An area's depth in 3D, from the surface it's on: its own (Region.depth), else its kind's usual depth. */
export const regionDepth = (r: Pick<import("./model.ts").Region, "kind" | "depth">): { standOut: number; thickness: number } => ({
  standOut: r.depth?.standOut ?? KIND_DEPTH[r.kind]?.standOut ?? 0,
  thickness: Math.max(0.005, r.depth?.thickness ?? KIND_DEPTH[r.kind]?.thickness ?? 0.25),
});

const centroidOf = (pts: readonly (readonly [number, number])[]): [number, number] => {
  let x = 0, y = 0;
  for (const p of pts) (x += p[0]), (y += p[1]);
  return [x / Math.max(1, pts.length), y / Math.max(1, pts.length)];
};

/**
 * The house's physical parts and where each sits: walls, roof, columns, windows, doors, the garage,
 * vents and lights (custom areas only when given a depth), each's front measured from the building
 * front: its own depth added to that of the part it's on (the smallest part containing its middle).
 */
export const houseParts = (project: Project, venueId: Id): Array<{ region: import("./model.ts").Region; standOut: number; thickness: number; on?: Id }> => {
  const venue = project.venues[venueId];
  const regions = (venue?.regionOrder ?? []).map((id) => venue!.regions[id]!).filter((r) => r && r.path.closed && !NOT_SOLID.has(r.kind) && !r.proposal && (r.kind in KIND_DEPTH || r.depth));
  const pts = (r: (typeof regions)[number]): Vec2[] => r.path.vertices.map((v) => [v.p[0], v.p[1]] as Vec2);
  const area = (r: (typeof regions)[number]) => Math.abs(polyArea(pts(r)));
  // What each part is on: the smallest other part containing its middle (walls are on nothing).
  const on = new Map<string, (typeof regions)[number] | undefined>();
  for (const r of regions) {
    const c = centroidOf(pts(r));
    const holders = regions.filter((q) => q.id !== r.id && area(q) > area(r) && insidePoly(pts(q), c)).sort((a, b) => area(a) - area(b));
    on.set(r.id, holders[0]);
  }
  const front = new Map<string, number>();
  const frontOf = (r: (typeof regions)[number], depth = 0): number => {
    const known = front.get(r.id);
    if (known !== undefined) return known;
    const base = on.get(r.id);
    const v = regionDepth(r).standOut + (base && depth < 10 ? frontOf(base, depth + 1) : 0);
    front.set(r.id, v);
    return v;
  };
  return regions.map((r) => ({ region: r, standOut: frontOf(r), thickness: regionDepth(r).thickness, ...(on.get(r.id) ? { on: on.get(r.id)!.id } : {}) }));
};

/** How far the house's dark inside reaches behind its front (m). */
const INSIDE_DEPTH = 4;

/**
 * The canvas y where a house's outline meets the ground along most of its width: for each 5 cm of
 * width, the lowest point of the outline there; the most common of those (to 5 px). Steps that come
 * forward and roof overhangs at the sides are a small share of the width, so they don't decide it.
 */
export const houseFloorLine = (outlines: ReadonlyArray<ReadonlyArray<Vec2>>): number | null => {
  const xs = outlines.flat().map((q) => q[0]);
  if (!xs.length) return null;
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const counts = new Map<number, number>();
  for (let x = lo + 2.5; x < hi; x += 5) {
    let bottom = -Infinity;
    for (const poly of outlines)
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!;
        const b = poly[(i + 1) % poly.length]!;
        if ((a[0] <= x) === (b[0] <= x)) continue;
        bottom = Math.max(bottom, a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]));
      }
    if (bottom === -Infinity) continue;
    const bin = Math.round(bottom / 5) * 5;
    counts.set(bin, (counts.get(bin) ?? 0) + 1);
  }
  let best: number | null = null;
  for (const [bin, n] of counts) if (best === null || n > counts.get(best)! || (n === counts.get(best)! && bin > best)) best = bin;
  return best;
};

/**
 * The whole house as solids sharing one 3D space: every traced area at its depth (Region.depth, or
 * its kind's usual depth), each its own object (to light, animate, give physics or break on its own).
 * Areas set into or standing out of another (windows in a wall, a column on the porch) are cut out of
 * it, so each sits at its own depth. Each part is solid (fixed in place until given physics of its own). With a key light (the picture's own lighting), a soft fill, a
 * shadow-only ground for characters' shadows, and the dark inside behind it all (with a floor where
 * the house meets the ground).
 */
export const houseScene = (project: Project, o: { sceneId: Id; idPrefix: string; name: string; venueId: Id; canvas: Canvas }): Scene3D => {
  const p = o.idPrefix;
  const parts = houseParts(project, o.venueId);
  const regions = parts.map((x) => x.region);
  const pts = (r: (typeof regions)[number]): Vec2[] => r.path.vertices.map((v) => [v.p[0], v.p[1]] as Vec2);
  const objects: Object3D[] = [];
  const byId = new Map(parts.map((x) => [x.region.id, x]));
  for (const { region: r, standOut, thickness } of parts) {
    // Cut out of it: what's declared, plus every part that sits on it (directly or on something on
    // it) at another depth, so each sits at its own.
    const cut = new Set<string>((r.cutouts ?? []).filter((id) => regions.some((q) => q.id === id)));
    for (const q of parts) {
      if (q.region.id === r.id || Math.abs(q.standOut - standOut) < 1e-6) continue;
      for (let a = q.on, n = 0; a && n < 10; a = byId.get(a)?.on, n++)
        if (a === r.id) {
          cut.add(q.region.id);
          break;
        }
    }
    // Solid where it is: what's thrown or knocked loose hits it instead of passing through.
    const solid = areaObject(`${p}-${r.id}`, r.name, { role: "areas", regionIds: [r.id] }, { depth: thickness, ...(standOut ? { standOut } : {}), ...(cut.size ? { cut: { role: "areas", regionIds: [...cut] } } : {}) });
    objects.push({ ...solid, physics: { body: "static", mass: 1000, friction: 0.8, bounce: 0.05 } });
  }
  const all = regions.flatMap(pts);
  const xs = all.map((q) => q[0]);
  const ys = all.map((q) => q[1]);
  const [x0, groundY] = canvasToWorld([xs.length ? Math.min(...xs) : 0, ys.length ? Math.max(...ys) : o.canvas.height], o.canvas);
  const [x1, top] = canvasToWorld([xs.length ? Math.max(...xs) : o.canvas.width, ys.length ? Math.min(...ys) : 0], o.canvas);
  const cx = (x0 + x1) / 2;
  const width = Math.max(1, x1 - x0);
  // The dark inside, seen only through openings: black, the house's own outline just behind its
  // deepest back face, enlarged along the show camera's lines of sight so it covers exactly what the
  // house covers (nothing past its edges, where layers beneath show).
  const back = Math.max(0, ...parts.map((x) => x.thickness - x.standOut)) + 0.03;
  const camZ = sceneCameraDistance(project, {}, o.venueId) * o.canvas.width * METERS_PER_PIXEL;
  const k = (camZ + back) / camZ;
  const inside: Object3D = {
    ...areaObject(`${p}-inside`, "Inside (behind the house)", { role: "areas", regionIds: regions.map((r) => r.id) }, { depth: 0.02 }),
    material: { style: "color", color: staticProp<RGBA>([0, 0, 0, 1]), roughness: 1, metalness: 1, glow: staticProp(0), opacity: 1 },
    position: staticProp<Vec3>([0, 0, -back], true),
    scale: staticProp<Vec3>([k * 100, k * 100, 100]),
    pivot: [0, (o.canvas.height * METERS_PER_PIXEL) / 2, 0],
    castShadow: false,
    receiveShadow: false,
  };
  // Solid but unseen, a room's depth behind the front, so what's knocked in falls and lies there
  // instead of wedging: a floor where the house front meets the ground along most of its width
  // (steps that come forward and roof overhangs aside), reaching the front so nothing rolls out
  // under a door, and a back wall.
  const floorY = canvasToWorld([0, houseFloorLine(regions.map(pts)) ?? (ys.length ? Math.max(...ys) : o.canvas.height)], o.canvas)[1];
  const unseen = { castShadow: false, receiveShadow: false, visible: false, physics: { body: "static" as const, mass: 1000, friction: 0.8, bounce: 0.05 } };
  objects.push(
    inside,
    mesh(`${p}-floor`, "Inside floor (solid, unseen)", { kind: "box", size: [width + 4, 0.2, INSIDE_DEPTH] }, [cx, floorY - 0.1, -INSIDE_DEPTH / 2], {}, unseen),
    mesh(`${p}-back`, "Inside back wall (solid, unseen)", { kind: "box", size: [width + 4, Math.max(1, top - groundY) + 4, 0.2] }, [cx, (top + groundY) / 2, -INSIDE_DEPTH - 0.1], {}, unseen),
    mesh(`${p}-ground`, "Ground (shows shadows only)", { kind: "box", size: [80, 0.2, 40] }, [0, groundY - 0.1, 10], { style: "shadow", opacity: 0.55 }, { castShadow: false, physics: { body: "static", mass: 1000, friction: 0.9, bounce: 0.05 } }),
    lightObject(`${p}-key`, "Key light", { target: [cx, (top + groundY) / 2, 0], balance: true }, [cx - width * 0.6, top + 3, 8]),
    lightObject(`${p}-fill`, "Soft fill", { type: "ambient", intensity: staticProp(0.35), castShadow: false, color: [0.82, 0.88, 1, 1] }, [0, 0, 0]),
  );
  return { id: o.sceneId, name: o.name, objectOrder: objects.map((x) => x.id), objects: Object.fromEntries(objects.map((x) => [x.id, x])), gravity: [0, -9.81, 0] };
};

// ---------------------------------------------------------------------------------------------
// Operations

const sceneShape = z.custom<Scene3D>(
  (v) => {
    const s = v as Scene3D;
    return !!s && typeof s.id === "string" && Array.isArray(s.objectOrder) && typeof s.objects === "object" && Array.isArray(s.gravity) && s.objectOrder.every((id) => !!s.objects[id]);
  },
  { message: "Not a valid 3D scene." },
);
const objectShape = z.custom<Object3D>((v) => {
  const o = v as Object3D;
  return !!o && typeof o.id === "string" && (o.kind === "mesh" || o.kind === "light" || o.kind === "null" || (o.kind === "particles" && !!o.particles)) && !!o.position && !!o.rotation && !!o.scale;
}, { message: "Not a valid 3D object." });

const sceneOf = (d: { readonly scenes3d?: Readonly<Record<Id, Scene3D>> }, id: Id): Scene3D => {
  const s = d.scenes3d?.[id];
  if (!s) throw new OpError("That 3D scene no longer exists.");
  return s;
};

export const scene3dAdd = defineOp({
  type: "scene3d.add",
  title: "Add 3D scene",
  description: "Add an editable 3D scene (objects, lights, physics) to the project.",
  args: z.object({ scene: sceneShape }),
  apply: (d, a) => {
    const all = ((d as { scenes3d?: Record<Id, Scene3D> }).scenes3d ??= {});
    if (all[a.scene.id]) throw new OpError("A 3D scene with that id already exists.");
    all[a.scene.id] = a.scene as never;
  },
});

export const scene3dUpdate = defineOp({
  type: "scene3d.update",
  title: "Change 3D scene",
  description: "Rename a 3D scene or change its gravity (m/s², x right, y up, z toward the audience), show-camera distance (null: follow the building's viewpoint), its own camera (a model's camera, or one set by hand; null: the show camera), or whether the house's lights (its candles and torches) light it.",
  args: z.object({
    sceneId: z.string(),
    changes: z.object({
      name: z.string().min(1).optional(),
      gravity: z.tuple([z.number(), z.number(), z.number()]).optional(),
      cameraDistance: z.number().min(0.2).max(20).nullable().optional(),
      camera: z
        .union([
          z.object({ kind: z.literal("model"), objectId: z.string(), name: z.string().optional() }),
          z.object({ kind: z.literal("manual"), position: z.tuple([z.number(), z.number(), z.number()]), rotation: z.tuple([z.number(), z.number(), z.number()]), fovY: z.number().min(1).max(170) }),
        ])
        .nullable()
        .optional(),
      houseLights: z.boolean().optional(),
      houseLightStrength: z.number().min(0).max(100).optional(),
    }),
  }),
  apply: (d, a) => {
    const s = sceneOf(d as never, a.sceneId) as unknown as { -readonly [K in keyof Scene3D]: Scene3D[K] };
    if (a.changes.name !== undefined) s.name = a.changes.name;
    if (a.changes.houseLights !== undefined) {
      if (a.changes.houseLights) delete s.houseLights;
      else s.houseLights = false;
    }
    if (a.changes.houseLightStrength !== undefined) {
      if (a.changes.houseLightStrength === 1) delete s.houseLightStrength;
      else s.houseLightStrength = a.changes.houseLightStrength;
    }
    if (a.changes.gravity) s.gravity = a.changes.gravity;
    if (a.changes.cameraDistance === null) delete s.cameraDistance;
    else if (a.changes.cameraDistance !== undefined) s.cameraDistance = a.changes.cameraDistance;
    if (a.changes.camera === null) delete s.camera;
    else if (a.changes.camera) {
      if (a.changes.camera.kind === "model" && (s.objects[a.changes.camera.objectId] as Object3D | undefined)?.geometry?.kind !== "model") throw new OpError("A scene's camera from a model needs a model object of that scene.");
      s.camera = a.changes.camera as SceneCamera;
    }
  },
});

export const object3dAdd = defineOp({
  type: "object3d.add",
  title: "Add 3D object",
  description: "Add an object (solid, light or particles) to a 3D scene.",
  args: z.object({ sceneId: z.string(), object: objectShape }),
  apply: (d, a) => {
    const s = sceneOf(d as never, a.sceneId) as unknown as { objects: Record<Id, Object3D>; objectOrder: Id[] };
    if (s.objects[a.object.id]) throw new OpError("An object with that id already exists.");
    s.objects[a.object.id] = a.object;
    s.objectOrder.push(a.object.id);
  },
});

export const object3dUpdate = defineOp({
  type: "object3d.update",
  title: "Change 3D object",
  description: "Change an object's name, visibility, position (m), rotation (degrees), scale (%), shape, material, light, physical properties (mass kg, friction, bounce) or how it breaks apart.",
  args: z.object({ sceneId: z.string(), objectId: z.string(), changes: z.record(z.string(), z.unknown()) }),
  apply: (d, a) => {
    const s = sceneOf(d as never, a.sceneId) as unknown as { objects: Record<Id, Record<string, unknown>> };
    const o = s.objects[a.objectId];
    if (!o) throw new OpError("That 3D object no longer exists.");
    for (const [k, v] of Object.entries(a.changes)) {
      if (k === "id" || k === "kind") continue;
      if (v === null || v === undefined) delete o[k];
      else o[k] = v;
    }
  },
});

export const object3dRemove = defineOp({
  type: "object3d.remove",
  title: "Remove 3D object",
  description: "Remove an object from a 3D scene.",
  args: z.object({ sceneId: z.string(), objectId: z.string() }),
  apply: (d, a) => {
    const s = sceneOf(d as never, a.sceneId) as unknown as { objects: Record<Id, Object3D>; objectOrder: Id[] };
    if (!s.objects[a.objectId]) throw new OpError("That 3D object no longer exists.");
    delete s.objects[a.objectId];
    s.objectOrder.splice(s.objectOrder.indexOf(a.objectId), 1);
  },
});

export const world3dOps = [scene3dAdd, scene3dUpdate, object3dAdd, object3dUpdate, object3dRemove];

/** Seconds helper for UIs that show layer-local times. */
export const layerSeconds = seconds;
