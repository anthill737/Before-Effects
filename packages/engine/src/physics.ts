/**
 * Rigid-body physics for 3D scenes, with Rapier (deterministic build).
 *
 *   prepare(): steps the world frame by frame in order and records the pose of every moving body
 *              (7 floats: position, rotation quaternion). Work is done in slices so the editor stays
 *              responsive; finished motion is written to the store, so reopening a show or
 *              exporting from another window reads it instead of simulating again.
 *   motion():  the recorded poses and how many frames are ready, synchronously, for drawing.
 *   ensure():  for export: waits until every frame is recorded.
 *
 * The motion depends only on the physics description's key (shapes, masses, friction, bounce,
 * gravity, timing, frame rate) — never on preview size, lights or colours — so seeking, preview at
 * any size, and export all show the same motion. The deterministic Rapier build gives the same
 * result for the same input on any run.
 *
 * Pieces of a breaking object start fixed in place, let go at their release frame with a push and
 * spin, and, when they rebuild, are moved back along an eased path to where they started.
 */
import RAPIER from "@dimforge/rapier3d-deterministic-compat";
import type { PhysicsBody, Quat, ResolvedPhysics, Vec3 } from "@be/core";
import type { SimStore } from "./sim/engine.ts";

let ready: Promise<void> | null = null;
/** Load the physics engine (WebAssembly, inlined). */
export const initPhysics = (): Promise<void> => (ready ??= RAPIER.init());

interface Run {
  readonly physics: ResolvedPhysics;
  world: RAPIER.World | null;
  bodies: RAPIER.RigidBody[];
  readonly data: Float32Array;
  /** Frames recorded so far. */
  done: number;
  /** Poses of rebuilding pieces when their rebuild started. */
  readonly from: Map<number, { p: Vec3; q: Quat }>;
  busy: Promise<void> | null;
  saved: boolean;
  /** Reading previously prepared motion from the store. */
  loading: Promise<void>;
}

const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

const slerp = (a: Quat, b: Quat, t: number): Quat => {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cos > 0.9995) {
    const r: Quat = [a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t, a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t];
    const l = Math.hypot(...r) || 1;
    return [r[0] / l, r[1] / l, r[2] / l, r[3] / l];
  }
  const th = Math.acos(cos);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
};

const colliderFor = (b: PhysicsBody): RAPIER.ColliderDesc => {
  const s = b.shape;
  let cd: RAPIER.ColliderDesc | null = null;
  if (s.kind === "box") cd = RAPIER.ColliderDesc.cuboid(Math.max(0.005, s.half[0]), Math.max(0.005, s.half[1]), Math.max(0.005, s.half[2]));
  else if (s.kind === "ball") cd = RAPIER.ColliderDesc.ball(Math.max(0.005, s.radius));
  else if (s.kind === "hull") cd = RAPIER.ColliderDesc.convexHull(new Float32Array(s.points));
  else if (s.kind === "mesh") cd = RAPIER.ColliderDesc.trimesh(new Float32Array(s.points), new Uint32Array(s.indices));
  // A degenerate outline can't make a hull: fall back to a small ball so the piece still exists.
  cd ??= RAPIER.ColliderDesc.ball(0.02);
  return cd.setFriction(b.friction).setRestitution(b.restitution).setMass(b.mass);
};

export class PhysicsEngine {
  private runs = new Map<string, Run>();

  constructor(private readonly store: SimStore | null) {}

  /** Recorded motion and how many frames of it are ready (null when nothing has been prepared). */
  motion(key: string): { data: Float32Array; ready: number } | null {
    const r = this.runs.get(key);
    return r ? { data: r.data, ready: r.done } : null;
  }

  progress(p: ResolvedPhysics): { done: number; total: number } {
    return { done: this.runs.get(p.key)?.done ?? 0, total: p.frames };
  }

  /** Forget motion that's no longer used (keeps memory bounded while editing). */
  retain(keys: ReadonlySet<string>): void {
    for (const [k, r] of this.runs) {
      if (keys.has(k) || r.busy) continue;
      r.world?.free();
      this.runs.delete(k);
    }
  }

  private async open(p: ResolvedPhysics): Promise<Run> {
    const existing = this.runs.get(p.key);
    if (existing) {
      await existing.loading;
      return existing;
    }
    const data = new Float32Array(Math.max(1, p.frames * p.movers * 7));
    const r: Run = { physics: p, world: null, bodies: [], data, done: 0, from: new Map(), busy: null, saved: false, loading: Promise.resolve() };
    this.runs.set(p.key, r);
    // Already prepared (this session in another window, or a previous session)?
    r.loading = (async () => {
      const stored = await this.store?.read(p.key, "motion.bin").catch(() => null);
      if (stored && stored.byteLength === data.byteLength) {
        data.set(new Float32Array(stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.byteLength)));
        r.done = p.frames;
        r.saved = true;
      }
    })();
    await r.loading;
    return r;
  }

  private build(r: Run): void {
    const p = r.physics;
    const world = new RAPIER.World({ x: p.gravity[0], y: p.gravity[1], z: p.gravity[2] });
    world.timestep = 1 / (p.fps * p.substeps);
    r.bodies = p.bodies.map((b) => {
      const desc = b.kind === "dynamic" ? RAPIER.RigidBodyDesc.dynamic() : b.kind === "kinematic" ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.fixed();
      desc.setTranslation(b.p[0], b.p[1], b.p[2]).setRotation({ x: b.q[0], y: b.q[1], z: b.q[2], w: b.q[3] });
      const body = world.createRigidBody(desc);
      world.createCollider(colliderFor(b), body);
      return body;
    });
    r.world = world;
  }

  /** Apply what happens at frame f before it is recorded: releases, rebuilds, animated obstacles. */
  private control(r: Run, f: number): void {
    const p = r.physics;
    p.bodies.forEach((b, i) => {
      const body = r.bodies[i]!;
      if (b.kind === "fragment") {
        if (f === b.release) {
          body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
          const v = b.velocity ?? [0, 0, 0];
          const w = b.spin ?? [0, 0, 0];
          body.setLinvel({ x: v[0], y: v[1], z: v[2] }, true);
          body.setAngvel({ x: w[0], y: w[1], z: w[2] }, true);
        }
        const rb = b.rebuild;
        if (rb && f >= rb.start) {
          if (f === rb.start || !r.from.has(i)) {
            const t = body.translation();
            const q = body.rotation();
            r.from.set(i, { p: [t.x, t.y, t.z], q: [q.x, q.y, q.z, q.w] });
            body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
          }
          const a = r.from.get(i)!;
          const dur = Math.max(1, rb.frames - Math.round(rb.frames * 0.6));
          const u = easeInOut(Math.min(1, Math.max(0, (f - rb.start - rb.delay) / dur)));
          const pos: Vec3 = [a.p[0] + (b.p[0] - a.p[0]) * u, a.p[1] + (b.p[1] - a.p[1]) * u, a.p[2] + (b.p[2] - a.p[2]) * u];
          const q = slerp(a.q, b.q, u);
          body.setTranslation({ x: pos[0], y: pos[1], z: pos[2] }, true);
          body.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }, true);
        }
      } else if (b.kind === "kinematic" && b.path) {
        const o = Math.min(f, r.physics.frames - 1) * 7;
        const n = Math.min(f + 1, r.physics.frames - 1) * 7;
        if (f === 0) {
          body.setTranslation({ x: b.path[o]!, y: b.path[o + 1]!, z: b.path[o + 2]! }, true);
          body.setRotation({ x: b.path[o + 3]!, y: b.path[o + 4]!, z: b.path[o + 5]!, w: b.path[o + 6]! }, true);
        }
        body.setNextKinematicTranslation({ x: b.path[n]!, y: b.path[n + 1]!, z: b.path[n + 2]! });
        body.setNextKinematicRotation({ x: b.path[n + 3]!, y: b.path[n + 4]!, z: b.path[n + 5]!, w: b.path[n + 6]! });
      }
    });
  }

  private record(r: Run, f: number): void {
    const p = r.physics;
    p.bodies.forEach((b, i) => {
      if (b.poseIndex < 0) return;
      const body = r.bodies[i]!;
      const t = body.translation();
      const q = body.rotation();
      r.data.set([t.x, t.y, t.z, q.x, q.y, q.z, q.w], (f * p.movers + b.poseIndex) * 7);
    });
  }

  /** Simulate for up to `budgetMs` (Infinity = to the end). Safe to call repeatedly. */
  async prepare(p: ResolvedPhysics, budgetMs: number): Promise<{ done: number; total: number }> {
    await initPhysics();
    const r = await this.open(p);
    while (r.busy) await r.busy;
    if (r.done >= p.frames) {
      await this.save(r);
      return { done: r.done, total: p.frames };
    }
    let release!: () => void;
    r.busy = new Promise<void>((res) => (release = res));
    try {
      if (!r.world) {
        // Motion is recorded from frame 0, so a fresh world starts at the beginning.
        r.done = 0;
        r.from.clear();
        this.build(r);
      }
      const world = r.world!;
      const t0 = performance.now();
      while (r.done < p.frames && performance.now() - t0 < budgetMs) {
        const f = r.done;
        this.control(r, f);
        this.record(r, f);
        if (f < p.frames - 1) for (let s = 0; s < p.substeps; s++) world.step();
        r.done = f + 1;
      }
      if (r.done >= p.frames) {
        world.free();
        r.world = null;
        r.bodies = [];
        await this.save(r);
      }
    } finally {
      r.busy = null;
      release();
    }
    return { done: r.done, total: p.frames };
  }

  private async save(r: Run): Promise<void> {
    if (r.saved || !this.store) return;
    r.saved = true;
    await this.store.write(r.physics.key, "motion.bin", new Uint8Array(r.data.buffer.slice(0))).catch(() => {
      r.saved = false;
    });
  }

  /** Export: wait until the motion is fully prepared. */
  async ensure(p: ResolvedPhysics): Promise<Float32Array> {
    while (this.progress(p).done < p.frames) await this.prepare(p, Infinity);
    return this.runs.get(p.key)!.data;
  }
}
