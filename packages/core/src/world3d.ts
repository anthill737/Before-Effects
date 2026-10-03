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
}

export type Geometry3D =
  /** A traced building area given thickness. Its front sits on the building front (z = 0). */
  | { readonly kind: "area"; readonly ref: RegionRef; readonly depth: number }
  | { readonly kind: "box"; readonly size: Vec3 }
  | { readonly kind: "sphere"; readonly radius: number }
  | { readonly kind: "plane"; readonly size: Vec2 };

export interface Physics3D {
  /** "dynamic" falls and collides; "static" stays put (or follows its animation) and others hit it. */
  readonly body: "dynamic" | "static";
  /** Kilograms for the whole object (split between its pieces by size). */
  readonly mass: number;
  readonly friction: number;
  /** 0 = no bounce, 1 = bounces back fully. */
  readonly bounce: number;
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
  /** Speed toward the audience when the pieces let go (m/s). */
  readonly push: number;
  /** Random tumbling when the pieces let go (turns per second). */
  readonly spin: number;
  /** Seconds over which the pieces let go, from the top down (0 or absent = all at once). */
  readonly stagger?: number;
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
}

export interface Object3D {
  readonly id: Id;
  readonly name: string;
  readonly kind: "mesh" | "light" | "particles";
  readonly visible: boolean;
  readonly position: AnimProp<Vec3>;
  readonly rotation: AnimProp<Vec3>;
  readonly scale: AnimProp<Vec3>;
  /** The point it turns and scales about (metres, in the scene's frame at rest) — a door's hinge. Default: its origin. */
  readonly pivot?: Vec3;
  readonly geometry?: Geometry3D;
  readonly material?: Material3D;
  readonly castShadow?: boolean;
  readonly receiveShadow?: boolean;
  readonly physics?: Physics3D;
  /** Break into pieces that fall (and optionally fly back). Areas only. */
  readonly fracture?: Fracture3D;
  readonly light?: Light3D;
  /** A moving part of the house made from a traced area (see parts3d.ts). */
  readonly part?: import("./parts3d.ts").PartInfo;
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
  /** The show camera stands this many building-widths in front of the building. */
  readonly cameraDistance: number;
}

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

/**
 * Where a point of an object (`c`, in its rest frame) ends up for a pose: scaled and turned about
 * the object's pivot, then moved. With no pivot this is position + rotation·(scale·c).
 */
export const placePoint = (c: Vec3, pos: Vec3, q: Quat, scale: Vec3, pivot: Vec3 = [0, 0, 0]): Vec3 => {
  const r = rotateByQuat([(c[0] - pivot[0]) * scale[0], (c[1] - pivot[1]) * scale[1], (c[2] - pivot[2]) * scale[2]], q);
  return [pos[0] + pivot[0] + r[0], pos[1] + pivot[1] + r[1], pos[2] + pivot[2] + r[2]];
};

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

const closedPoints = (path: { closed: boolean; vertices: readonly { p: Vec2 }[] } & Parameters<typeof flattenPath>[0]): Vec2[] => {
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
  /** Rest position of the piece's centre in the object's space (front face at z = 0). */
  readonly center: Vec3;
  readonly depth: number;
  readonly area: number;
}

export interface ResolvedObject {
  readonly object: Object3D;
  /** Area geometry: one piece, or the fragments when it breaks. */
  readonly pieces: readonly ResolvedPiece[];
  /** Index of the object's first moving body in the prepared motion (−1 = not moving by physics). */
  readonly poseIndex: number;
  /** Particles: where they're born. */
  readonly emitter?: import("./particles3d.ts").ParticleEmitter;
}

export type PhysicsShape =
  | { readonly kind: "box"; readonly half: Vec3 }
  | { readonly kind: "ball"; readonly radius: number }
  | { readonly kind: "hull"; readonly points: readonly number[] }
  | { readonly kind: "mesh"; readonly points: readonly number[]; readonly indices: readonly number[] };

export interface PhysicsBody {
  /** "fixed" never moves · "kinematic" follows `path` · "dynamic" simulated · "fragment" fixed until released. */
  readonly kind: "fixed" | "kinematic" | "dynamic" | "fragment";
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
  readonly photoAssetId?: Id;
  readonly objects: readonly ResolvedObject[];
  readonly physics: ResolvedPhysics | null;
  readonly fps: number;
}

const seconds = (t: Flicks) => t / FLICKS_PER_SECOND;
const flicks = (s: number) => Math.round(s * FLICKS_PER_SECOND);

const piecesCache = new WeakMap<Geometry3D, { fracture: Fracture3D | undefined; venue: unknown; w: number; h: number; pieces: ResolvedPiece[] }>();

/**
 * The object's pieces in its own space (metres). Kept while the area, the venue and the way it
 * breaks are unchanged, so editing a light or a colour never rebuilds the pieces.
 */
const piecesFor = (project: Project, o: Object3D, canvas: Canvas, venueId: Id | undefined): ResolvedPiece[] => {
  const g = o.geometry;
  if (!g || g.kind !== "area") return [];
  const venue = venueId ? project.venues[venueId] : undefined;
  const hit = piecesCache.get(g);
  if (hit && hit.fracture === o.fracture && hit.venue === venue && hit.w === canvas.width && hit.h === canvas.height) return hit.pieces;
  const pieces = computePieces(project, g, o.fracture, canvas, venueId);
  piecesCache.set(g, { fracture: o.fracture, venue, w: canvas.width, h: canvas.height, pieces });
  return pieces;
};

const computePieces = (project: Project, g: Extract<Geometry3D, { kind: "area" }>, fr: Fracture3D | undefined, canvas: Canvas, venueId: Id | undefined): ResolvedPiece[] => {
  const regions = refRegions(project, g.ref, venueId).filter((r) => r.path.closed);
  const vid = venueId ?? project.activeVenueId;
  const venue = vid ? project.venues[vid] : undefined;
  const depth = Math.max(0.01, g.depth);
  const out: ResolvedPiece[] = [];
  for (const r of regions) {
    const outline = closedPoints(r.path);
    const holes = regionHoles(r, venue).map((h) => closedPoints(h)).filter((h) => h.length >= 3);
    if (outline.length < 3) continue;
    const polys = fr ? fracture(outline, holes, fr.pieceSize, fr.seed).map((p) => ({ outline: p, holes: [] as Vec2[][] })) : solidWithHoles(outline, holes);
    for (const poly of polys) {
      const w = poly.outline.map((p) => canvasToWorld(p, canvas));
      const c = polyCentroid(w);
      out.push({
        outline: w.map((p) => [p[0] - c[0], p[1] - c[1]] as Vec2),
        holes: poly.holes.map((h) => h.map((p) => canvasToWorld(p, canvas)).map((p) => [p[0] - c[0], p[1] - c[1]] as Vec2)),
        center: [c[0], c[1], -depth / 2],
        depth,
        area: Math.abs(polyArea(w)),
      });
    }
  }
  return out;
};

const scaleOf = (o: Object3D, t: Flicks): Vec3 => evalProp(o.scale, t).map((s) => s / 100) as unknown as Vec3;

const chunk = <T>(a: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

const shapeFor = (o: Object3D, piece: ResolvedPiece | null, scale: Vec3, fixed: boolean): PhysicsShape | null => {
  const g = o.geometry;
  if (!g) return null;
  const [sx, sy, sz] = scale;
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

const resolveCache = new WeakMap<Scene3D, Array<{ sig: string; venue: unknown; result: ResolvedScene3D }>>();

/**
 * Everything needed to draw and simulate a 3D scene shown in a layer `frames` frames long at `fps`.
 * Memoised on the scene and venue, so evaluating every frame stays cheap.
 */
export const resolveScene3D = (project: Project, scene: Scene3D, opts: { venueId?: Id; canvas: Canvas; fps: number; frames: number }): ResolvedScene3D => {
  const venue = opts.venueId ? project.venues[opts.venueId] : undefined;
  const sig = `${opts.venueId}|${opts.canvas.width}x${opts.canvas.height}|${opts.fps}|${opts.frames}|${venue?.referenceAssetId}`;
  const list = resolveCache.get(scene) ?? [];
  const hit = list.find((e) => e.sig === sig && e.venue === venue);
  if (hit) return hit.result;

  const { canvas, fps, frames } = opts;
  const objects: ResolvedObject[] = [];
  const bodies: PhysicsBody[] = [];
  let movers = 0;
  const frameTime = (f: number) => flicks(f / fps);
  for (const id of scene.objectOrder) {
    const o = scene.objects[id];
    if (!o) continue;
    const pieces = piecesFor(project, o, canvas, opts.venueId);
    const ph = o.kind === "mesh" ? o.physics : undefined;
    let poseIndex = -1;
    if (ph && o.geometry) {
      const fr = o.geometry.kind === "area" ? o.fracture : undefined;
      // Pose of the object when it starts moving under physics.
      const t0 = fr ? flicks(fr.collapseAt) : 0;
      const pos = evalProp(o.position, t0);
      const q = eulerDegToQuat(evalProp(o.rotation, t0));
      const sc = scaleOf(o, t0);
      const animated = (o.position.keyframes?.length ?? 0) > 0 || (o.rotation.keyframes?.length ?? 0) > 0;
      const placed = (c: Vec3): Vec3 => placePoint(c, pos, q, sc, o.pivot);
      const common = { friction: Math.max(0, ph.friction), restitution: Math.min(1, Math.max(0, ph.bounce)) };
      if (fr && ph.body === "dynamic" && pieces.length) {
        poseIndex = movers;
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
            release,
            velocity: [(r1 - 0.5) * fr.push * 0.5, (r2 - 0.3) * fr.push * 0.3, fr.push * (0.2 + 1.6 * h) * (0.7 + 0.6 * r3)],
            spin: [(r2 - 0.5) * spin, (r3 - 0.5) * spin, (r1 - 0.5) * spin],
            ...(rebuildStart !== null ? { rebuild: { start: rebuildStart, frames: rebuildFrames, delay: Math.round(((rank.get(i) ?? 0) / Math.max(1, pieces.length)) * rebuildFrames * 0.6) } } : {}),
            poseIndex: movers++,
          });
        });
      } else {
        const fixed = ph.body === "static";
        const list = pieces.length ? pieces : [null];
        const moving = !fixed || animated;
        if (moving) poseIndex = movers;
        const total = pieces.reduce((s, p) => s + p.area, 0) || 1;
        for (const piece of list) {
          const shape = shapeFor(o, piece, sc, fixed);
          if (!shape) continue;
          const center: Vec3 = piece ? piece.center : [0, 0, 0];
          let path: number[] | undefined;
          if (fixed && animated) {
            path = [];
            for (let f = 0; f < frames; f++) {
              const t = frameTime(f);
              const pp = evalProp(o.position, t);
              const qq = eulerDegToQuat(evalProp(o.rotation, t));
              path.push(...placePoint(center, pp, qq, sc, o.pivot), ...qq);
            }
          }
          bodies.push({
            kind: fixed ? (path ? "kinematic" : "fixed") : "dynamic",
            shape,
            mass: Math.max(0.01, piece ? (ph.mass * piece.area) / total : ph.mass),
            ...common,
            p: placed(center),
            q,
            ...(path ? { path } : {}),
            poseIndex: moving ? movers++ : -1,
          });
        }
      }
    }
    if (o.kind === "particles" && o.particles) {
      objects.push({ object: o, pieces, poseIndex, emitter: particleEmitter(project, o.particles, opts.venueId, canvas) });
      continue;
    }
    objects.push({ object: o, pieces, poseIndex });
  }
  const anyMoving = bodies.some((b) => b.kind === "dynamic" || b.kind === "fragment");
  const physics: ResolvedPhysics | null = anyMoving
    ? (() => {
        const body = { v: PHYSICS_ENGINE_VERSION, fps, substeps: PHYSICS_SUBSTEPS, frames, gravity: scene.gravity, bodies };
        return { key: `phys-${simHash(stableJson(body))}`, fps, substeps: PHYSICS_SUBSTEPS, frames, gravity: scene.gravity, bodies, movers };
      })()
    : null;
  const result: ResolvedScene3D = { scene, canvas, ...(venue?.referenceAssetId ? { photoAssetId: venue.referenceAssetId } : {}), objects, physics, fps };
  list.push({ sig, venue, result });
  if (list.length > 4) list.shift();
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

export const ballObject = (id: Id, name: string, radius: number, position: Vec3, physics?: Physics3D): Object3D =>
  mesh(id, name, { kind: "sphere", radius }, position, { color: staticProp<RGBA>([0.9, 0.5, 0.2, 1]), roughness: 0.4 }, physics ? { physics } : {});

export const DEFAULT_FRACTURE: Fracture3D = { pieceSize: 70, seed: 1, collapseAt: 1, rebuildAt: 5, rebuildSeconds: 2, push: 0.6, spin: 0.25 };
/** Ways an area breaks apart, all with real physics (Rapier). */
export const FRACTURE_PRESETS: Record<"collapse" | "explode" | "crumble", { title: string; description: string; fracture: Fracture3D }> = {
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
};

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
  o: { sceneId: Id; idPrefix: string; name: string; ref: RegionRef; venueId?: Id; canvas: Canvas; depth?: number; collapse?: boolean; fracture?: Fracture3D },
): Scene3D => {
  const p = o.idPrefix;
  const b = areaBounds(project, o.ref, o.venueId) ?? { x0: o.canvas.width * 0.25, x1: o.canvas.width * 0.75, y0: o.canvas.height * 0.25, y1: o.canvas.height * 0.75 };
  const depth = o.depth ?? 0.3;
  const [lx0, ly] = canvasToWorld([b.x0, b.y1], o.canvas);
  const [lx1, top] = canvasToWorld([b.x1, b.y0], o.canvas);
  const width = lx1 - lx0;
  const cx = (lx0 + lx1) / 2;
  const ledgeH = ly > 0.05 && ly <= 1.5 ? ly : 0.3;
  const objects: Object3D[] = [
    mesh(`${p}-area`, "Wall (3D)", { kind: "area", ref: o.ref, depth }, [0, 0, 0], { style: "photo", color: staticProp(grey(1)) }, {
      physics: o.collapse ? DEFAULT_PHYSICS : { ...DEFAULT_PHYSICS, body: "static" },
      ...(o.collapse ? { fracture: o.fracture ?? DEFAULT_FRACTURE } : {}),
    }),
    mesh(`${p}-inside`, "Inside (behind the wall)", { kind: "box", size: [width + 0.2, top - ly + 0.2, 0.2] }, [cx, (top + ly) / 2, -depth - 0.6], { color: staticProp(grey(0.08)), roughness: 1 }, { castShadow: false }),
    // A ledge along the bottom: a solid plinth when the area starts near the ground, else a 30 cm slab.
    mesh(`${p}-ledge`, "Ledge", { kind: "box", size: [width + 0.6, ledgeH, depth + 2] }, [cx, ly - ledgeH / 2, (2 - depth) / 2], { color: staticProp(grey(0.45)) }, {
      physics: { body: "static", mass: 1000, friction: 0.8, bounce: 0.1 },
    }),
    mesh(`${p}-ground`, "Ground", { kind: "box", size: [60, 0.2, 40] }, [0, -0.1, 0], { style: "shadow", opacity: 0.6 }, {
      physics: { body: "static", mass: 1000, friction: 0.9, bounce: 0.05 },
      castShadow: false,
    }),
    lightObject(`${p}-key`, "Key light", { target: [cx, (top + ly) / 2, 0] }, [cx - width * 0.6, top + 3, 6]),
    lightObject(`${p}-fill`, "Soft fill", { type: "ambient", intensity: staticProp(0.35), castShadow: false, color: [0.8, 0.86, 1, 1] }, [0, 0, 0]),
  ];
  return { id: o.sceneId, name: o.name, objectOrder: objects.map((x) => x.id), objects: Object.fromEntries(objects.map((x) => [x.id, x])), gravity: [0, -9.81, 0], cameraDistance: 1.6 };
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
  return !!o && typeof o.id === "string" && (o.kind === "mesh" || o.kind === "light" || (o.kind === "particles" && !!o.particles)) && !!o.position && !!o.rotation && !!o.scale;
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
  description: "Rename a 3D scene or change its gravity (m/s², x right, y up, z toward the audience) or show-camera distance.",
  args: z.object({ sceneId: z.string(), changes: z.object({ name: z.string().min(1).optional(), gravity: z.tuple([z.number(), z.number(), z.number()]).optional(), cameraDistance: z.number().min(0.2).max(20).optional() }) }),
  apply: (d, a) => {
    const s = sceneOf(d as never, a.sceneId) as unknown as { -readonly [K in keyof Scene3D]: Scene3D[K] };
    if (a.changes.name !== undefined) s.name = a.changes.name;
    if (a.changes.gravity) s.gravity = a.changes.gravity;
    if (a.changes.cameraDistance !== undefined) s.cameraDistance = a.changes.cameraDistance;
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
