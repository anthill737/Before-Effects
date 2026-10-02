/**
 * Smoke: a 2D grid fluid solver on the GPU ("stable fluids").
 *
 * Per sub-step: emit density, heat and velocity from the emitters → buoyancy (warm smoke rises),
 * wind and curl-noise gusts → vorticity confinement (keeps the curling detail) → semi-Lagrangian
 * advection of velocity → pressure projection (Jacobi) so the flow stays incompressible →
 * advection of density and temperature, with density fading over the "linger" time.
 *
 * Deterministic: fixed sub-steps per frame, no atomics, seeded hash noise. The bottom edge is a
 * floor; the other edges are open so smoke drifts out of frame.
 */
import { type ResolvedSim, simGrid } from "@be/core";
import type { Gpu } from "../gpu.ts";
import { ComputeKit } from "./kit.ts";

const HEADER = /* wgsl */ `
struct Params {
  nx: u32, ny: u32, seed: u32, frame: u32,
  dt: f32, time: f32, rise: f32, cool: f32,
  swirl: f32, turb: f32, windX: f32, windY: f32,
  windPull: f32, rate: f32, turbScale: f32, pad: f32,
};
@group(0) @binding(0) var<uniform> P: Params;
fn ci(x: i32, y: i32) -> u32 { return u32(clamp(y, 0, i32(P.ny) - 1)) * P.nx + u32(clamp(x, 0, i32(P.nx) - 1)); }
fn inside(x: i32, y: i32) -> bool { return x >= 0 && y >= 0 && x < i32(P.nx) && y < i32(P.ny); }
fn pcg(v: u32) -> u32 { let s = v * 747796405u + 2891336453u; let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
fn h2(ix: i32, iy: i32, t: u32) -> f32 { return f32(pcg(pcg(pcg(bitcast<u32>(ix) ^ P.seed) + bitcast<u32>(iy)) + t)) / 4294967295.0; }
fn vnoise(p: vec2f, t: u32) -> f32 {
  let i = floor(p); let f = p - i; let u = f * f * (3.0 - 2.0 * f);
  let x = i32(i.x); let y = i32(i.y);
  return mix(mix(h2(x, y, t), h2(x + 1, y, t), u.x), mix(h2(x, y + 1, t), h2(x + 1, y + 1, t), u.x), u.y);
}
/** Smoothly evolving noise: blend between integer time slices. */
fn tnoise(p: vec2f, time: f32) -> f32 {
  let s = time * 0.6; let k = floor(s); let f = s - k;
  return mix(vnoise(p, u32(k)), vnoise(p, u32(k) + 1u), f * f * (3.0 - 2.0 * f));
}
`;

const SOURCES = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read_write> vel: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> dens: array<f32>;
@group(0) @binding(3) var<storage, read_write> temp: array<f32>;
@group(0) @binding(4) var<storage, read> emit: array<vec4f>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.nx || g.y >= P.ny) { return; }
  let i = g.y * P.nx + g.x;
  let e = emit[i];
  let pc = vec2f(f32(g.x), f32(g.y));
  let flick = 0.55 + 0.45 * tnoise(pc * 0.18, P.time * 2.0);
  let m = e.x * flick;
  dens[i] = dens[i] + m * P.rate * P.dt;
  temp[i] = temp[i] + m * P.dt * 1.5;
  var v = vel[i];
  v = mix(v, e.zw, clamp(e.x * 6.0 * P.dt, 0.0, 1.0));
  v.y = v.y - P.rise * temp[i] * P.dt;
  v = v + (vec2f(P.windX, P.windY) - v) * P.windPull * P.dt;
  // Gusts: the curl of an evolving noise field (divergence-free, so it only stirs).
  let q = pc * P.turbScale;
  let eps = 0.5;
  let n1 = tnoise(q + vec2f(0.0, eps), P.time); let n2 = tnoise(q - vec2f(0.0, eps), P.time);
  let n3 = tnoise(q + vec2f(eps, 0.0), P.time); let n4 = tnoise(q - vec2f(eps, 0.0), P.time);
  v = v + vec2f(n1 - n2, -(n3 - n4)) / (2.0 * eps) * P.turb * P.dt;
  temp[i] = temp[i] * exp(-P.dt / P.cool);
  vel[i] = v;
}`;

const CURL = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read> vel: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> curl: array<f32>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.nx || g.y >= P.ny) { return; }
  let x = i32(g.x); let y = i32(g.y);
  curl[g.y * P.nx + g.x] = 0.5 * ((vel[ci(x + 1, y)].y - vel[ci(x - 1, y)].y) - (vel[ci(x, y + 1)].x - vel[ci(x, y - 1)].x));
}`;

const VORTICITY = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read_write> vel: array<vec2f>;
@group(0) @binding(2) var<storage, read> curl: array<f32>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.nx || g.y >= P.ny) { return; }
  let x = i32(g.x); let y = i32(g.y);
  let grad = 0.5 * vec2f(abs(curl[ci(x + 1, y)]) - abs(curl[ci(x - 1, y)]), abs(curl[ci(x, y + 1)]) - abs(curl[ci(x, y - 1)]));
  let len = length(grad);
  if (len < 1e-5) { return; }
  let n = grad / len;
  let w = curl[g.y * P.nx + g.x];
  let i = g.y * P.nx + g.x;
  vel[i] = vel[i] + P.swirl * vec2f(n.y * w, -n.x * w) * P.dt;
}`;

const ADVECT_VEL = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read> velIn: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> velOut: array<vec2f>;
fn sampleV(p: vec2f) -> vec2f {
  let q = p - 0.5; let b = floor(q); let f = q - b; let x = i32(b.x); let y = i32(b.y);
  return mix(mix(velIn[ci(x, y)], velIn[ci(x + 1, y)], f.x), mix(velIn[ci(x, y + 1)], velIn[ci(x + 1, y + 1)], f.x), f.y);
}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.nx || g.y >= P.ny) { return; }
  let i = g.y * P.nx + g.x;
  let p = vec2f(f32(g.x) + 0.5, f32(g.y) + 0.5);
  // Second-order (midpoint) back-trace keeps swirls round.
  let mid = p - 0.5 * P.dt * velIn[i];
  velOut[i] = sampleV(p - P.dt * sampleV(mid));
}`;

const DIVERGENCE = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read> vel: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> div: array<f32>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.nx || g.y >= P.ny) { return; }
  let x = i32(g.x); let y = i32(g.y);
  var below = vel[ci(x, y + 1)].y;
  if (y + 1 >= i32(P.ny)) { below = 0.0; } // floor: nothing flows through it
  div[g.y * P.nx + g.x] = 0.5 * ((vel[ci(x + 1, y)].x - vel[ci(x - 1, y)].x) + (below - vel[ci(x, y - 1)].y));
}`;

const JACOBI = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read> pIn: array<f32>;
@group(0) @binding(2) var<storage, read_write> pOut: array<f32>;
@group(0) @binding(3) var<storage, read> div: array<f32>;
fn pv(x: i32, y: i32, c0: f32) -> f32 {
  if (y >= i32(P.ny)) { return c0; }  // floor: zero pressure gradient
  if (!inside(x, y)) { return 0.0; }    // open edges
  return pIn[u32(y) * P.nx + u32(x)];
}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.nx || g.y >= P.ny) { return; }
  let x = i32(g.x); let y = i32(g.y); let i = g.y * P.nx + g.x;
  let c = pIn[i];
  pOut[i] = (pv(x - 1, y, c) + pv(x + 1, y, c) + pv(x, y - 1, c) + pv(x, y + 1, c) - div[i]) * 0.25;
}`;

const PROJECT = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read_write> vel: array<vec2f>;
@group(0) @binding(2) var<storage, read> p: array<f32>;
fn pv(x: i32, y: i32, c0: f32) -> f32 {
  if (y >= i32(P.ny)) { return c0; }
  if (!inside(x, y)) { return 0.0; }
  return p[u32(y) * P.nx + u32(x)];
}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.nx || g.y >= P.ny) { return; }
  let x = i32(g.x); let y = i32(g.y); let i = g.y * P.nx + g.x;
  let c = p[i];
  var v = vel[i] - 0.5 * vec2f(pv(x + 1, y, c) - pv(x - 1, y, c), pv(x, y + 1, c) - pv(x, y - 1, c));
  if (y == i32(P.ny) - 1) { v.y = min(v.y, 0.0); }
  vel[i] = v;
}`;

const ADVECT_SCALAR = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read> vel: array<vec2f>;
@group(0) @binding(2) var<storage, read> sIn: array<f32>;
@group(0) @binding(3) var<storage, read_write> sOut: array<f32>;
@group(0) @binding(4) var<uniform> fade: vec4f;
fn sv(x: i32, y: i32) -> f32 { if (!inside(x, y)) { return 0.0; } return sIn[u32(y) * P.nx + u32(x)]; }
fn sampleS(p: vec2f) -> f32 {
  let q = p - 0.5; let b = floor(q); let f = q - b; let x = i32(b.x); let y = i32(b.y);
  return mix(mix(sv(x, y), sv(x + 1, y), f.x), mix(sv(x, y + 1), sv(x + 1, y + 1), f.x), f.y);
}
fn sampleV(p: vec2f) -> vec2f {
  let q = p - 0.5; let b = floor(q); let f = q - b; let x = i32(b.x); let y = i32(b.y);
  return mix(mix(vel[ci(x, y)], vel[ci(x + 1, y)], f.x), mix(vel[ci(x, y + 1)], vel[ci(x + 1, y + 1)], f.x), f.y);
}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.nx || g.y >= P.ny) { return; }
  let i = g.y * P.nx + g.x;
  let p = vec2f(f32(g.x) + 0.5, f32(g.y) + 0.5);
  let mid = p - 0.5 * P.dt * vel[i];
  sOut[i] = max(0.0, sampleS(p - P.dt * sampleV(mid)) * fade.x);
}`;

const PACK = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read> a: array<f32>;
@group(0) @binding(2) var<storage, read> b: array<f32>;
@group(0) @binding(3) var<storage, read_write> outp: array<u32>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.nx || g.y >= P.ny) { return; }
  let i = g.y * P.nx + g.x;
  outp[i] = pack2x16float(vec2f(min(a[i], 60000.0), min(b[i], 60000.0)));
}`;

const SUBSTEPS = 2;
const JACOBI_ITERS = 40;

export class SmokeSolver {
  readonly nx: number;
  readonly ny: number;
  readonly cell: number;
  frame = 0;
  private readonly dev: GPUDevice;
  private readonly bufs: Record<string, GPUBuffer> = {};
  private readonly params: GPUBuffer[] = [];
  private readonly fadeD: GPUBuffer;
  private readonly fadeT: GPUBuffer;
  private readonly kit: ComputeKit;
  private readonly fps: number;

  constructor(
    gpu: Gpu,
    readonly sim: ResolvedSim,
  ) {
    this.dev = gpu.device;
    this.kit = new ComputeKit(this.dev);
    const g = simGrid(sim.width, sim.height, sim.settings.quality);
    this.nx = g.nx;
    this.ny = g.ny;
    this.cell = g.cell;
    this.fps = sim.frameRate.num / sim.frameRate.den;
    const n = this.nx * this.ny;
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    for (const [name, bytes] of [["vel0", 8], ["vel1", 8], ["dens0", 4], ["dens1", 4], ["temp0", 4], ["temp1", 4], ["curl", 4], ["div", 4], ["p0", 4], ["p1", 4], ["emit", 16], ["pack", 4]] as const) {
      this.bufs[name] = this.dev.createBuffer({ label: `smoke:${name}`, size: n * bytes, usage: storage });
    }
    this.bufs.read = this.dev.createBuffer({ label: "smoke:read", size: n * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    for (let s = 0; s < SUBSTEPS + 1; s++) this.params.push(this.dev.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    const dt = 1 / this.fps / SUBSTEPS;
    const linger = Math.max(0.2, sim.settings.forces.linger);
    this.fadeD = this.uniform(new Float32Array([Math.exp(-dt / linger), 0, 0, 0]));
    this.fadeT = this.uniform(new Float32Array([1, 0, 0, 0]));
  }

  private uniform(data: Float32Array): GPUBuffer {
    const b = this.dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.dev.queue.writeBuffer(b, 0, data);
    return b;
  }

  private run(pass: GPUComputePassEncoder, code: string, params: GPUBuffer, buffers: GPUBuffer[]) {
    this.kit.run(pass, code, [params, ...buffers], Math.ceil(this.nx / 8), Math.ceil(this.ny / 8));
  }

  private writeParams(buf: GPUBuffer, time: number, dt: number) {
    const f = this.sim.settings.forces;
    const c = this.cell;
    const data = new ArrayBuffer(64);
    const u = new Uint32Array(data);
    const fl = new Float32Array(data);
    u[0] = this.nx;
    u[1] = this.ny;
    u[2] = (this.sim.settings.seed * 2654435761) >>> 0;
    u[3] = this.frame;
    fl[4] = dt;
    fl[5] = time;
    fl[6] = (f.rise / 100) * 140; // cells/s² per unit of heat
    fl[7] = 1.2; // seconds for heat to cool
    fl[8] = (f.swirl / 100) * 14;
    fl[9] = (f.turbulence / 100) * 60;
    fl[10] = f.wind[0] / c;
    fl[11] = f.wind[1] / c;
    fl[12] = f.wind[0] || f.wind[1] ? 0.6 : 0;
    fl[13] = 1.6; // density added per second at full strength
    fl[14] = 0.07;
    this.dev.queue.writeBuffer(buf, 0, data);
  }

  /** Simulate one frame with the given emitter field (from emitterField()). */
  step(emit: Float32Array): void {
    const b = this.bufs;
    this.dev.queue.writeBuffer(b.emit!, 0, emit as Float32Array<ArrayBuffer>);
    const dt = 1 / this.fps / SUBSTEPS;
    const enc = this.dev.createCommandEncoder({ label: "smoke step" });
    for (let s = 0; s < SUBSTEPS; s++) {
      const params = this.params[s]!;
      this.writeParams(params, (this.frame + s / SUBSTEPS) / this.fps, dt);
      let pass = enc.beginComputePass();
      this.run(pass, SOURCES, params, [b.vel0!, b.dens0!, b.temp0!, b.emit!]);
      this.run(pass, CURL, params, [b.vel0!, b.curl!]);
      this.run(pass, VORTICITY, params, [b.vel0!, b.curl!]);
      this.run(pass, ADVECT_VEL, params, [b.vel0!, b.vel1!]);
      pass.end();
      enc.copyBufferToBuffer(b.vel1!, 0, b.vel0!, 0, b.vel0!.size);
      pass = enc.beginComputePass();
      this.run(pass, DIVERGENCE, params, [b.vel0!, b.div!]);
      for (let k = 0; k < JACOBI_ITERS; k++) this.run(pass, JACOBI, params, k % 2 === 0 ? [b.p0!, b.p1!, b.div!] : [b.p1!, b.p0!, b.div!]);
      this.run(pass, PROJECT, params, [b.vel0!, b.p0!]);
      this.run(pass, ADVECT_SCALAR, params, [b.vel0!, b.dens0!, b.dens1!, this.fadeD]);
      this.run(pass, ADVECT_SCALAR, params, [b.vel0!, b.temp0!, b.temp1!, this.fadeT]);
      pass.end();
      enc.copyBufferToBuffer(b.dens1!, 0, b.dens0!, 0, b.dens0!.size);
      enc.copyBufferToBuffer(b.temp1!, 0, b.temp0!, 0, b.temp0!.size);
    }
    this.dev.queue.submit([enc.finish()]);
    this.frame++;
  }

  /** The current frame as two half floats per cell (density, heat), for the cache. */
  async readFrame(): Promise<Uint8Array> {
    const b = this.bufs;
    const params = this.params[SUBSTEPS]!;
    this.writeParams(params, this.frame / this.fps, 0);
    const enc = this.dev.createCommandEncoder({ label: "smoke pack" });
    const pass = enc.beginComputePass();
    this.run(pass, PACK, params, [b.dens0!, b.temp0!, b.pack!]);
    pass.end();
    enc.copyBufferToBuffer(b.pack!, 0, b.read!, 0, b.read!.size);
    this.dev.queue.submit([enc.finish()]);
    await b.read!.mapAsync(GPUMapMode.READ);
    const out = new Uint8Array(b.read!.getMappedRange().slice(0));
    b.read!.unmap();
    return out;
  }

  /** Full solver state (to resume later from this frame). */
  async maintain(): Promise<void> {}

  async saveState(): Promise<Uint8Array> {
    return this.kit.read(["vel0", "dens0", "temp0", "p0"].map((n) => this.bufs[n]!));
  }

  loadState(bytes: Uint8Array, frame: number): void {
    this.kit.write(["vel0", "dens0", "temp0", "p0"].map((n) => this.bufs[n]!), bytes);
    this.frame = frame;
  }

  destroy(): void {
    for (const b of Object.values(this.bufs)) b.destroy();
    for (const b of this.params) b.destroy();
    this.fadeD.destroy();
    this.fadeT.destroy();
  }
}
