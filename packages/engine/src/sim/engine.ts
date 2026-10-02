/**
 * Preparing and showing simulations.
 *
 *   prepare(): simulates frames in order and stores each one (two half floats per grid cell) in the
 *              SimStore, plus a checkpoint of the full solver state every 30 frames so an
 *              interrupted preparation resumes where it stopped instead of starting over.
 *   render():  draws a prepared frame with the simulation's look at any size. Frames come from a
 *              small GPU cache or are loaded from the store (onFrameReady fires when one arrives).
 *   ensure():  for export: waits until a frame is prepared and loaded, simulating if necessary.
 *
 * Preparation is separate from the preview frame cache: it depends only on the simulation's
 * settings (its key), never on preview size or quality, so preview and export read the same data.
 */
import { type ResolvedSim, simGrid } from "@be/core";
import { toLinearPremul } from "../compositor.ts";
import type { Gpu } from "../gpu.ts";
import { COMMON } from "../shaders.ts";
import { emitterField, shapeMask } from "./masks.ts";
import { SmokeSolver } from "./smoke.ts";
import { WaterSolver } from "./water.ts";

export interface SimStore {
  read(key: string, name: string): Promise<Uint8Array | null>;
  write(key: string, name: string, data: Uint8Array): Promise<void>;
}

export interface SimProgress {
  readonly done: number;
  readonly total: number;
}

type Solver = SmokeSolver | WaterSolver;

interface Run {
  readonly sim: ResolvedSim;
  readonly solver: Solver;
  readonly emitCache: Map<number, Float32Array>;
  done: number;
  busy: boolean;
}

const CHECKPOINT_EVERY = 30;
const LRU_LIMIT = 240;

const LOOK = /* wgsl */ `
${COMMON}
struct U { c1: vec4f, c2: vec4f, texel: vec2f, kind: f32, opacity: f32 };
@group(0) @binding(0) var field: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut { return fullscreen(vi); }
fn f(uv: vec2f) -> vec2f { return textureSampleLevel(field, samp, uv, 0.0).rg; }
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let v = f(i.uv);
  let gx = f(i.uv + vec2f(u.texel.x, 0.0)).r - f(i.uv - vec2f(u.texel.x, 0.0)).r;
  let gy = f(i.uv + vec2f(0.0, u.texel.y)).r - f(i.uv - vec2f(0.0, u.texel.y)).r;
  if (u.kind < 0.5) {
    // Smoke: soft, lit from above, denser parts take the second colour.
    let d = v.r;
    let a = 1.0 - exp(-d * 1.6);
    let lit = clamp(0.85 + 1.4 * gy - 0.3 * gx, 0.5, 1.25);
    let col = mix(u.c1.rgb, u.c2.rgb, clamp(smoothstep(0.4, 2.5, d) * 0.7 + v.g * 0.15, 0.0, 1.0)) * lit;
    return vec4f(col * a, a) * u.opacity;
  }
  // Water: a surface where enough liquid is, with depth shading, highlights and foam.
  let r = v.r;
  let a = smoothstep(0.32, 0.55, r);
  let n = normalize(vec3f(-gx * 2.5, -gy * 2.5, 1.0));
  let spec = pow(max(dot(n, normalize(vec3f(-0.35, -0.6, 0.72))), 0.0), 18.0);
  let depth = smoothstep(0.5, 2.2, r);
  let foam = smoothstep(4.0, 14.0, v.g) * 0.55;
  let col = mix(u.c1.rgb * 1.05, u.c1.rgb * 0.55, depth) + u.c2.rgb * (spec * 0.6 + foam * 0.7);
  return vec4f(col * a, a) * u.opacity;
}`;

export class SimEngine {
  private readonly runs = new Map<string, Run>();
  private readonly prepared = new Map<string, number>();
  private readonly lru = new Map<string, GPUTexture>();
  private readonly loading = new Set<string>();
  /** Called when a frame finished loading or preparing, so views can redraw. */
  onFrameReady: (() => void) | null = null;

  constructor(
    private readonly gpu: Gpu,
    private readonly store: SimStore,
  ) {}

  /** Prepared frames so far (known after the first status() or prepare()). */
  preparedFrames(key: string): number | undefined {
    return this.prepared.get(key);
  }

  async status(sim: ResolvedSim): Promise<SimProgress> {
    if (!this.prepared.has(sim.key)) {
      const meta = await this.readMeta(sim.key);
      this.prepared.set(sim.key, Math.min(meta?.done ?? 0, sim.frames));
    }
    return { done: this.prepared.get(sim.key)!, total: sim.frames };
  }

  isPreparing(key: string): boolean {
    return !!this.runs.get(key)?.busy;
  }

  private async readMeta(key: string): Promise<{ done: number; checkpoint: number } | null> {
    const b = await this.store.read(key, "meta.json");
    if (!b) return null;
    try {
      return JSON.parse(new TextDecoder().decode(b)) as { done: number; checkpoint: number };
    } catch {
      return null;
    }
  }

  private newSolver(sim: ResolvedSim): Solver {
    if (sim.settings.type === "water") {
      const g = simGrid(sim.width, sim.height, sim.settings.quality);
      const solid = sim.containers.length ? shapeMask(sim.containers, g.nx, g.ny, g.cell).map((v) => (v > 0.5 ? 0 : 1)) : new Float32Array(g.nx * g.ny);
      return new WaterSolver(this.gpu, sim, solid);
    }
    return new SmokeSolver(this.gpu, sim);
  }

  private async startRun(sim: ResolvedSim): Promise<Run> {
    let run = this.runs.get(sim.key);
    if (run) return run;
    const solver = this.newSolver(sim);
    run = { sim, solver, emitCache: new Map(), done: 0, busy: false };
    this.runs.set(sim.key, run);
    const meta = await this.readMeta(sim.key);
    if (meta && meta.done > 0) {
      // Resume: restore the last checkpoint, then re-simulate (without saving) up to the saved frames.
      const state = meta.checkpoint > 0 ? await this.store.read(sim.key, "state.bin") : null;
      if (state) solver.loadState(state, meta.checkpoint);
      while (solver.frame < meta.done) await this.advance(run);
      run.done = meta.done;
    }
    return run;
  }

  private stepSolver(run: Run) {
    const s = run.solver;
    const fps = run.sim.frameRate.num / run.sim.frameRate.den;
    const seconds = s.frame / fps - run.sim.settings.preroll;
    s.step(emitterField(run.sim, s.nx, s.ny, s.cell, seconds, run.emitCache));
  }

  private async advance(run: Run) {
    this.stepSolver(run);
    await run.solver.maintain();
  }

  /** Simulate and store frames for up to `budgetMs`. Safe to call repeatedly; resumes where it stopped. */
  async prepare(sim: ResolvedSim, budgetMs = 12): Promise<SimProgress> {
    const total = sim.frames;
    if ((this.prepared.get(sim.key) ?? (await this.status(sim)).done) >= total) return { done: total, total };
    const run = await this.startRun(sim);
    if (run.busy) return { done: run.done, total };
    run.busy = true;
    try {
      const t0 = performance.now();
      while (run.done < total && performance.now() - t0 < budgetMs) {
        await this.advance(run);
        const frame = run.done;
        const bytes = await run.solver.readFrame();
        await this.store.write(sim.key, `f${frame}.bin`, bytes);
        this.put(`${sim.key}:${frame}`, this.upload(bytes, run.solver.nx, run.solver.ny));
        run.done++;
        const checkpoint = run.done % CHECKPOINT_EVERY === 0;
        if (checkpoint) await this.store.write(sim.key, "state.bin", await run.solver.saveState());
        if (checkpoint || run.done === total || run.done % 10 === 0) {
          const meta = await this.readMeta(sim.key);
          await this.store.write(sim.key, "meta.json", new TextEncoder().encode(JSON.stringify({ done: run.done, total, checkpoint: checkpoint ? run.done : (meta?.checkpoint ?? 0) })));
        }
        this.prepared.set(sim.key, run.done);
        this.onFrameReady?.();
      }
    } finally {
      run.busy = false;
    }
    if (run.done >= total) {
      run.solver.destroy();
      this.runs.delete(sim.key);
    }
    return { done: run.done, total };
  }

  /** Stop preparing simulations that are no longer used (keeps their stored frames). */
  retain(keys: ReadonlySet<string>): void {
    for (const [k, r] of this.runs) {
      if (keys.has(k) || r.busy) continue;
      r.solver.destroy();
      this.runs.delete(k);
    }
  }

  private upload(bytes: Uint8Array, nx: number, ny: number): GPUTexture {
    const t = this.gpu.device.createTexture({ label: "sim frame", size: [nx, ny], format: "rg16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.gpu.device.queue.writeTexture({ texture: t }, bytes as Uint8Array<ArrayBuffer>, { bytesPerRow: nx * 4 }, [nx, ny]);
    return t;
  }

  private put(id: string, t: GPUTexture) {
    this.lru.get(id)?.destroy();
    this.lru.delete(id);
    this.lru.set(id, t);
    while (this.lru.size > LRU_LIMIT) {
      const [k, old] = this.lru.entries().next().value as [string, GPUTexture];
      old.destroy();
      this.lru.delete(k);
    }
  }

  /** The field texture of a prepared frame, or null (and starts loading it) if it isn't ready. */
  field(sim: ResolvedSim, frame: number): GPUTexture | null {
    const id = `${sim.key}:${frame}`;
    const hit = this.lru.get(id);
    if (hit) {
      this.lru.delete(id);
      this.lru.set(id, hit);
      return hit;
    }
    const done = this.prepared.get(sim.key);
    if (done === undefined) {
      void this.status(sim).then(() => this.onFrameReady?.());
      return null;
    }
    if (frame >= done) {
      this.refresh(sim);
      return null;
    }
    if (this.loading.has(id)) return null;
    this.loading.add(id);
    const g = simGrid(sim.width, sim.height, sim.settings.quality);
    void this.store
      .read(sim.key, `f${frame}.bin`)
      .then((bytes) => {
        if (bytes && bytes.byteLength === g.nx * g.ny * 4) {
          this.put(id, this.upload(bytes, g.nx, g.ny));
          this.onFrameReady?.();
        } else if (!bytes) this.prepared.set(sim.key, Math.min(frame, done)); // the stored frames were cleared
      })
      .finally(() => this.loading.delete(id));
    return null;
  }

  private readonly lastCheck = new Map<string, number>();
  /** Another window may be preparing: look for newly stored frames now and then. */
  private refresh(sim: ResolvedSim) {
    if (this.runs.has(sim.key)) return;
    const now = performance.now();
    if ((this.lastCheck.get(sim.key) ?? -Infinity) > now - 1000) return;
    this.lastCheck.set(sim.key, now);
    void this.readMeta(sim.key).then((m) => {
      if (m && m.done > (this.prepared.get(sim.key) ?? 0)) {
        this.prepared.set(sim.key, Math.min(m.done, sim.frames));
        this.onFrameReady?.();
      }
    });
  }

  /** Make a frame available before rendering it (export): simulate and load as needed. */
  async ensure(sim: ResolvedSim, frame: number): Promise<void> {
    for (;;) {
      const { done } = await this.status(sim);
      if (done > frame) break;
      await this.prepare(sim, 1000);
    }
    if (this.field(sim, frame)) return;
    const g = simGrid(sim.width, sim.height, sim.settings.quality);
    const bytes = await this.store.read(sim.key, `f${frame}.bin`);
    if (!bytes || bytes.byteLength !== g.nx * g.ny * 4) throw new Error("A prepared simulation frame couldn't be read. Prepare the simulation again.");
    this.put(`${sim.key}:${frame}`, this.upload(bytes, g.nx, g.ny));
  }

  /** Draw a frame with the simulation's look into a new texture of the given size (caller releases), or null if not prepared. */
  render(sim: ResolvedSim, frame: number, width: number, height: number, encoder: GPUCommandEncoder): GPUTexture | null {
    const field = this.field(sim, frame);
    if (!field) return null;
    const look = sim.settings.look;
    const out = this.gpu.acquire(width, height, undefined, "sim look");
    const c1 = toLinearPremul(look.color);
    const c2 = toLinearPremul(look.color2);
    const u = new Float32Array([...c1, ...c2, 1 / field.width, 1 / field.height, sim.settings.type === "water" ? 1 : 0, Math.max(0, Math.min(100, look.opacity)) / 100]);
    this.gpu.pass(encoder, LOOK, out, [field.createView(), this.gpu.samplerLinear, { buffer: this.gpu.uniform(u) }], { clear: { r: 0, g: 0, b: 0, a: 0 } });
    return out;
  }

  dispose(): void {
    for (const r of this.runs.values()) r.solver.destroy();
    this.runs.clear();
    for (const t of this.lru.values()) t.destroy();
    this.lru.clear();
  }
}
