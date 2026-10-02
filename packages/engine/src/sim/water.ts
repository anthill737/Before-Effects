/**
 * Water: a 2D FLIP liquid solver on the GPU.
 *
 * Particles carry the water; a staggered (MAC) grid enforces incompressibility each sub-step:
 *   particles → grid (weights summed with integer atomics, so the result doesn't depend on the
 *   order threads run in) → gravity → walls → pressure solve on water cells (Jacobi, open air
 *   surface) → grid → particles (95% FLIP / 5% PIC) → move particles (midpoint) and keep them out
 *   of solids. Emitters top up cells that have room, so containers (e.g. windows) fill up and stay
 *   full instead of overflowing endlessly.
 *
 * Output per frame (for the cache): smoothed liquid amount and speed per cell (two half floats).
 */
import { type ResolvedSim, simGrid } from "@be/core";
import type { Gpu } from "../gpu.ts";
import { ComputeKit } from "./kit.ts";

const SCALE = 131072.0; // fixed point for velocity/weight sums
const SUBSTEPS = 4;
const JACOBI_ITERS = 70;

const HEADER = /* wgsl */ `
struct Params {
  nx: u32, ny: u32, seed: u32, frame: u32,
  dt: f32, gravity: f32, cap: u32, openEdges: u32,
  spawnChance: f32, sub: u32, windX: f32, pad1: f32,
};
@group(0) @binding(0) var<uniform> P: Params;
const SCALE: f32 = ${SCALE};
fn cidx(x: i32, y: i32) -> u32 { return u32(clamp(y, 0, i32(P.ny) - 1)) * P.nx + u32(clamp(x, 0, i32(P.nx) - 1)); }
fn uidx(x: i32, y: i32) -> u32 { return u32(clamp(y, 0, i32(P.ny) - 1)) * (P.nx + 1u) + u32(clamp(x, 0, i32(P.nx))); }
fn vidx(x: i32, y: i32) -> u32 { return u32(clamp(y, 0, i32(P.ny))) * P.nx + u32(clamp(x, 0, i32(P.nx) - 1)); }
fn pcg(v: u32) -> u32 { let s = v * 747796405u + 2891336453u; let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
fn rnd(a: u32, b: u32, c: u32) -> f32 { return f32(pcg(pcg(pcg(a ^ P.seed) + b) + c) >> 8u) / 16777216.0; }
`;

/** Bilinear interpolation of a face-velocity array (u: offset (0, .5), v: offset (.5, 0)). */
const INTERP = (name: string, kind: "u" | "v") => /* wgsl */ `
fn i_${name}(p: vec2f) -> f32 {
  let q = p - ${kind === "u" ? "vec2f(0.0, 0.5)" : "vec2f(0.5, 0.0)"};
  let b = floor(q); let f = q - b; let x = i32(b.x); let y = i32(b.y);
  let a00 = ${name}[${kind}idx(x, y)]; let a10 = ${name}[${kind}idx(x + 1, y)];
  let a01 = ${name}[${kind}idx(x, y + 1)]; let a11 = ${name}[${kind}idx(x + 1, y + 1)];
  return mix(mix(a00, a10, f.x), mix(a01, a11, f.x), f.y);
}`;

const P2G = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read> parts: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> uSum: array<atomic<i32>>;
@group(0) @binding(3) var<storage, read_write> uW: array<atomic<i32>>;
@group(0) @binding(4) var<storage, read_write> vSum: array<atomic<i32>>;
@group(0) @binding(5) var<storage, read_write> vW: array<atomic<i32>>;
@group(0) @binding(6) var<storage, read_write> count: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> counter: array<atomic<u32>>;
fn splatU(q: vec2f, val: f32) {
  let b = floor(q); let f = q - b; let x = i32(b.x); let y = i32(b.y);
  var w = array<f32, 4>((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
  var ix = array<i32, 4>(x, x + 1, x, x + 1); var iy = array<i32, 4>(y, y, y + 1, y + 1);
  for (var k = 0; k < 4; k++) {
    if (ix[k] < 0 || iy[k] < 0 || ix[k] > i32(P.nx) || iy[k] >= i32(P.ny)) { continue; }
    let j = uidx(ix[k], iy[k]);
    atomicAdd(&uSum[j], i32(round(w[k] * val * SCALE)));
    atomicAdd(&uW[j], i32(round(w[k] * SCALE)));
  }
}
fn splatV(q: vec2f, val: f32) {
  let b = floor(q); let f = q - b; let x = i32(b.x); let y = i32(b.y);
  var w = array<f32, 4>((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
  var ix = array<i32, 4>(x, x + 1, x, x + 1); var iy = array<i32, 4>(y, y, y + 1, y + 1);
  for (var k = 0; k < 4; k++) {
    if (ix[k] < 0 || iy[k] < 0 || ix[k] >= i32(P.nx) || iy[k] > i32(P.ny)) { continue; }
    let j = vidx(ix[k], iy[k]);
    atomicAdd(&vSum[j], i32(round(w[k] * val * SCALE)));
    atomicAdd(&vW[j], i32(round(w[k] * SCALE)));
  }
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
  let n = atomicLoad(&counter[0]);
  if (g.x >= n) { return; }
  let p = parts[g.x];
  if (p.x < 0.0) { return; }
  atomicAdd(&count[cidx(i32(floor(p.x)), i32(floor(p.y)))], 1u);
  splatU(p.xy - vec2f(0.0, 0.5), p.z);
  splatV(p.xy - vec2f(0.5, 0.0), p.w);
}`;

const SOLID_FN = /* wgsl */ `
fn isSolid(x: i32, y: i32) -> bool {
  if (x < 0 || y < 0 || x >= i32(P.nx) || y >= i32(P.ny)) { return P.openEdges == 0u; }
  return solid[u32(y) * P.nx + u32(x)] > 0.5;
}`;

/** Normalise u-face sums into velocities, zero faces touching solids/edges; keep a copy for FLIP. */
const GRID_U = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read_write> sum: array<atomic<i32>>;
@group(0) @binding(2) var<storage, read_write> wsum: array<atomic<i32>>;
@group(0) @binding(3) var<storage, read_write> u: array<f32>;
@group(0) @binding(4) var<storage, read_write> uOld: array<f32>;
@group(0) @binding(5) var<storage, read> solid: array<f32>;
${SOLID_FN}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  let x = i32(g.x); let y = i32(g.y);
  if (x > i32(P.nx) || y >= i32(P.ny)) { return; }
  let j = uidx(x, y);
  let w = f32(atomicLoad(&wsum[j]));
  var val = select(0.0, f32(atomicLoad(&sum[j])) / w, w > 0.0);
  uOld[j] = val;
  if (isSolid(x - 1, y) || isSolid(x, y)) { val = 0.0; }
  u[j] = val;
}`;

/** Same for v faces, plus gravity. */
const GRID_V = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read_write> sum: array<atomic<i32>>;
@group(0) @binding(2) var<storage, read_write> wsum: array<atomic<i32>>;
@group(0) @binding(3) var<storage, read_write> v: array<f32>;
@group(0) @binding(4) var<storage, read_write> vOld: array<f32>;
@group(0) @binding(5) var<storage, read> solid: array<f32>;
${SOLID_FN}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  let x = i32(g.x); let y = i32(g.y);
  if (x >= i32(P.nx) || y > i32(P.ny)) { return; }
  let j = vidx(x, y);
  let w = f32(atomicLoad(&wsum[j]));
  var val = select(0.0, f32(atomicLoad(&sum[j])) / w, w > 0.0);
  vOld[j] = val;
  val = val + P.gravity * P.dt;
  if (isSolid(x, y - 1) || isSolid(x, y)) { val = 0.0; }
  v[j] = val;
}`;

const DIVERGENCE = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read> u: array<f32>;
@group(0) @binding(2) var<storage, read> v: array<f32>;
@group(0) @binding(3) var<storage, read_write> count: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> div: array<f32>;
@group(0) @binding(5) var<storage, read> solid: array<f32>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.nx || g.y >= P.ny) { return; }
  let x = i32(g.x); let y = i32(g.y); let i = g.y * P.nx + g.x;
  let fluid = atomicLoad(&count[i]) > 0u && solid[i] < 0.5;
  // Slightly over-full cells push outward, which keeps the water's volume from drifting.
  let crowd = max(0.0, f32(atomicLoad(&count[i])) - 4.0) * 1.2;
  div[i] = select(0.0, (u[uidx(x + 1, y)] - u[uidx(x, y)]) + (v[vidx(x, y + 1)] - v[vidx(x, y)]) - crowd, fluid);
}`;

const JACOBI = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read> pIn: array<f32>;
@group(0) @binding(2) var<storage, read_write> pOut: array<f32>;
@group(0) @binding(3) var<storage, read> div: array<f32>;
@group(0) @binding(4) var<storage, read_write> count: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> solid: array<f32>;
fn kind(x: i32, y: i32) -> u32 { // 0 air, 1 water, 2 solid
  if (x < 0 || y < 0 || x >= i32(P.nx) || y >= i32(P.ny)) { return select(2u, 0u, P.openEdges == 1u); }
  let i = u32(y) * P.nx + u32(x);
  if (solid[i] > 0.5) { return 2u; }
  return select(0u, 1u, atomicLoad(&count[i]) > 0u);
}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.nx || g.y >= P.ny) { return; }
  let x = i32(g.x); let y = i32(g.y); let i = g.y * P.nx + g.x;
  if (kind(x, y) != 1u) { pOut[i] = 0.0; return; }
  var sum = 0.0; var n = 0.0;
  var nb = array<vec2i, 4>(vec2i(-1, 0), vec2i(1, 0), vec2i(0, -1), vec2i(0, 1));
  for (var k = 0; k < 4; k++) {
    let q = vec2i(x, y) + nb[k];
    let t = kind(q.x, q.y);
    if (t == 2u) { continue; }
    n += 1.0;
    if (t == 1u) { sum += pIn[u32(q.y) * P.nx + u32(q.x)]; }
  }
  pOut[i] = select(0.0, (sum - div[i]) / n, n > 0.0);
}`;

const GRADIENT = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read_write> u: array<f32>;
@group(0) @binding(2) var<storage, read_write> v: array<f32>;
@group(0) @binding(3) var<storage, read> p: array<f32>;
@group(0) @binding(4) var<storage, read_write> count: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> solid: array<f32>;
fn kind(x: i32, y: i32) -> u32 {
  if (x < 0 || y < 0 || x >= i32(P.nx) || y >= i32(P.ny)) { return select(2u, 0u, P.openEdges == 1u); }
  let i = u32(y) * P.nx + u32(x);
  if (solid[i] > 0.5) { return 2u; }
  return select(0u, 1u, atomicLoad(&count[i]) > 0u);
}
fn pr(x: i32, y: i32) -> f32 { if (kind(x, y) != 1u) { return 0.0; } return p[u32(y) * P.nx + u32(x)]; }
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  let x = i32(g.x); let y = i32(g.y);
  if (x <= i32(P.nx) && y < i32(P.ny)) {
    let a = kind(x - 1, y); let b = kind(x, y);
    let j = uidx(x, y);
    if (a == 2u || b == 2u) { u[j] = 0.0; } else if (a == 1u || b == 1u) { u[j] = u[j] - (pr(x, y) - pr(x - 1, y)); }
  }
  if (x < i32(P.nx) && y <= i32(P.ny)) {
    let a = kind(x, y - 1); let b = kind(x, y);
    let j = vidx(x, y);
    if (a == 2u || b == 2u) { v[j] = 0.0; } else if (a == 1u || b == 1u) { v[j] = v[j] - (pr(x, y) - pr(x, y - 1)); }
  }
}`;

const G2P = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read_write> parts: array<vec4f>;
@group(0) @binding(2) var<storage, read> u: array<f32>;
@group(0) @binding(3) var<storage, read> v: array<f32>;
@group(0) @binding(4) var<storage, read> uOld: array<f32>;
@group(0) @binding(5) var<storage, read> vOld: array<f32>;
@group(0) @binding(6) var<storage, read> solid: array<f32>;
@group(0) @binding(7) var<storage, read_write> counter: array<atomic<u32>>;
${INTERP("u", "u")}
${INTERP("v", "v")}
${INTERP("uOld", "u")}
${INTERP("vOld", "v")}
fn vel(p: vec2f) -> vec2f { return vec2f(i_u(p), i_v(p)); }
fn blocked(p: vec2f) -> bool {
  let x = i32(floor(p.x)); let y = i32(floor(p.y));
  if (x < 0 || y < 0 || x >= i32(P.nx) || y >= i32(P.ny)) { return P.openEdges == 0u; }
  return solid[u32(y) * P.nx + u32(x)] > 0.5;
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= atomicLoad(&counter[0])) { return; }
  var p = parts[g.x];
  if (p.x < 0.0) { return; }
  let pic = vel(p.xy);
  let flip = p.zw + (pic - vec2f(i_uOld(p.xy), i_vOld(p.xy)));
  var nv = mix(flip, pic, 0.05);
  // Move with the grid flow (midpoint), then keep out of solids.
  let mid = p.xy + 0.5 * P.dt * vel(p.xy);
  var np = p.xy + P.dt * vel(mid);
  if (blocked(np)) {
    let tx = vec2f(np.x, p.y); let ty = vec2f(p.x, np.y);
    if (!blocked(ty)) { np = ty; nv.x = 0.0; } else if (!blocked(tx)) { np = tx; nv.y = 0.0; } else { np = p.xy; nv = vec2f(0.0); }
  }
  // Leaving the picture through an open edge: the particle is gone.
  if (np.x < 0.0 || np.y < 0.0 || np.x >= f32(P.nx) || np.y >= f32(P.ny)) {
    if (P.openEdges == 1u) { parts[g.x] = vec4f(-1.0, -1.0, 0.0, 0.0); return; }
    np = clamp(np, vec2f(0.01), vec2f(f32(P.nx) - 0.01, f32(P.ny) - 0.01));
  }
  parts[g.x] = vec4f(np, nv);
}`;

/** Pour from emitter cells unless they're full (deterministic positions; slot order doesn't matter). */
const EMIT = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read_write> parts: array<vec4f>;
@group(0) @binding(2) var<storage, read> emit: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> count: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> counter: array<atomic<u32>>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.nx || g.y >= P.ny) { return; }
  let i = g.y * P.nx + g.x;
  let e = emit[i];
  if (e.x <= 0.0) { return; }
  if (rnd(i, P.frame, 7u) > e.x * P.spawnChance) { return; }
  // A steady pour; it stops only where the water has already filled up to the source.
  let have = atomicLoad(&count[i]);
  if (have >= 6u) { return; }
  for (var k = 0u; k < 2u; k++) {
    let slot = atomicAdd(&counter[0], 1u);
    if (slot >= P.cap) { atomicSub(&counter[0], 1u); return; }
    let jitter = vec2f(rnd(i, P.frame, k * 2u + 11u), rnd(i, P.frame, k * 2u + 12u));
    parts[slot] = vec4f(vec2f(f32(g.x), f32(g.y)) + jitter, e.zw);
  }
}`;

const SPLAT = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read> parts: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> amount: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> speed: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> counter: array<atomic<u32>>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= atomicLoad(&counter[0])) { return; }
  let p = parts[g.x];
  if (p.x < 0.0) { return; }
  let q = p.xy - 0.5; let b = floor(q); let f = q - b; let x = i32(b.x); let y = i32(b.y);
  var w = array<f32, 4>((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
  var ix = array<i32, 4>(x, x + 1, x, x + 1); var iy = array<i32, 4>(y, y, y + 1, y + 1);
  let s = min(length(p.zw), 2000.0);
  for (var k = 0; k < 4; k++) {
    if (ix[k] < 0 || iy[k] < 0 || ix[k] >= i32(P.nx) || iy[k] >= i32(P.ny)) { continue; }
    let j = u32(iy[k]) * P.nx + u32(ix[k]);
    atomicAdd(&amount[j], u32(round(w[k] * 65536.0)));
    atomicAdd(&speed[j], u32(round(w[k] * s * 64.0)));
  }
}`;

const PACK = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read_write> amount: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> speed: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> outp: array<u32>;
fn a(x: i32, y: i32) -> f32 { return f32(atomicLoad(&amount[cidx(x, y)])) / 65536.0; }
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.nx || g.y >= P.ny) { return; }
  let x = i32(g.x); let y = i32(g.y); let i = g.y * P.nx + g.x;
  // Light 3x3 smoothing gives a clean surface; ~4 particles per cell = 1.0.
  let sm = (4.0 * a(x, y) + 2.0 * (a(x - 1, y) + a(x + 1, y) + a(x, y - 1) + a(x, y + 1)) + a(x - 1, y - 1) + a(x + 1, y - 1) + a(x - 1, y + 1) + a(x + 1, y + 1)) / 16.0;
  let w = max(a(x, y), 1e-3);
  let sp = f32(atomicLoad(&speed[i])) / 64.0 / w;
  outp[i] = pack2x16float(vec2f(sm / 4.0, min(sp, 60000.0)));
}`;

export class WaterSolver {
  readonly nx: number;
  readonly ny: number;
  readonly cell: number;
  frame = 0;
  private readonly kit: ComputeKit;
  private readonly dev: GPUDevice;
  private readonly b: Record<string, GPUBuffer> = {};
  private readonly params: GPUBuffer[] = [];
  private readonly cap: number;
  private readonly fps: number;

  constructor(
    gpu: Gpu,
    readonly sim: ResolvedSim,
    solidMask: Float32Array,
  ) {
    this.dev = gpu.device;
    this.kit = new ComputeKit(this.dev);
    const g = simGrid(sim.width, sim.height, sim.settings.quality);
    this.nx = g.nx;
    this.ny = g.ny;
    this.cell = g.cell;
    this.fps = sim.frameRate.num / sim.frameRate.den;
    this.cap = Math.min(600_000, this.nx * this.ny * 5);
    const n = this.nx * this.ny;
    const nu = (this.nx + 1) * this.ny;
    const nv = this.nx * (this.ny + 1);
    const st = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const mk = (name: string, size: number) => (this.b[name] = this.dev.createBuffer({ label: `water:${name}`, size, usage: st }));
    mk("parts", this.cap * 16);
    mk("counter", 16);
    for (const [k, s] of [["uSum", nu], ["uW", nu], ["u", nu], ["uOld", nu], ["vSum", nv], ["vW", nv], ["v", nv], ["vOld", nv]] as const) mk(k, s * 4);
    for (const k of ["count", "div", "p0", "p1", "solid", "amount", "speed", "pack"]) mk(k, n * 4);
    mk("emit", n * 16);
    this.dev.queue.writeBuffer(this.b.solid!, 0, solidMask as Float32Array<ArrayBuffer>);
    for (let s = 0; s < SUBSTEPS + 1; s++) this.params.push(this.dev.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
  }

  private writeParams(buf: GPUBuffer, sub: number) {
    const f = this.sim.settings.forces;
    const data = new ArrayBuffer(48);
    const u = new Uint32Array(data);
    const fl = new Float32Array(data);
    u[0] = this.nx;
    u[1] = this.ny;
    u[2] = (this.sim.settings.seed * 2654435761) >>> 0;
    u[3] = this.frame;
    fl[4] = 1 / this.fps / SUBSTEPS;
    fl[5] = ((f.gravity / 50) * 1400) / this.cell; // px/s² → cells/s²
    u[6] = this.cap;
    u[7] = this.sim.containers.length ? 0 : 1;
    fl[8] = 0.15 + ((this.sim.emitters[0]?.emitter.amount ?? 50) / 100) * 0.6;
    u[9] = sub;
    this.dev.queue.writeBuffer(buf, 0, data);
  }

  step(emit: Float32Array): void {
    const b = this.b;
    const k = this.kit;
    this.dev.queue.writeBuffer(b.emit!, 0, emit as Float32Array<ArrayBuffer>);
    const gx = Math.ceil((this.nx + 1) / 8);
    const gy = Math.ceil((this.ny + 1) / 8);
    const gp = Math.ceil(this.cap / 64);
    const enc = this.dev.createCommandEncoder({ label: "water step" });
    for (let s = 0; s < SUBSTEPS; s++) {
      const P = this.params[s]!;
      this.writeParams(P, s);
      for (const name of ["uSum", "uW", "vSum", "vW", "count"]) enc.clearBuffer(b[name]!);
      const pass = enc.beginComputePass();
      k.run(pass, P2G, [P, b.parts!, b.uSum!, b.uW!, b.vSum!, b.vW!, b.count!, b.counter!], gp);
      k.run(pass, GRID_U, [P, b.uSum!, b.uW!, b.u!, b.uOld!, b.solid!], gx, gy);
      k.run(pass, GRID_V, [P, b.vSum!, b.vW!, b.v!, b.vOld!, b.solid!], gx, gy);
      k.run(pass, DIVERGENCE, [P, b.u!, b.v!, b.count!, b.div!, b.solid!], gx, gy);
      for (let i = 0; i < JACOBI_ITERS; i++) k.run(pass, JACOBI, i % 2 === 0 ? [P, b.p0!, b.p1!, b.div!, b.count!, b.solid!] : [P, b.p1!, b.p0!, b.div!, b.count!, b.solid!], gx, gy);
      k.run(pass, GRADIENT, [P, b.u!, b.v!, b.p0!, b.count!, b.solid!], gx, gy);
      k.run(pass, G2P, [P, b.parts!, b.u!, b.v!, b.uOld!, b.vOld!, b.solid!, b.counter!], gp);
      if (s === SUBSTEPS - 1) k.run(pass, EMIT, [P, b.parts!, b.emit!, b.count!, b.counter!], gx, gy);
      pass.end();
    }
    this.dev.queue.submit([enc.finish()]);
    this.frame++;
  }

  async readFrame(): Promise<Uint8Array> {
    const b = this.b;
    const P = this.params[SUBSTEPS]!;
    this.writeParams(P, 0);
    const enc = this.dev.createCommandEncoder({ label: "water pack" });
    enc.clearBuffer(b.amount!);
    enc.clearBuffer(b.speed!);
    const pass = enc.beginComputePass();
    this.kit.run(pass, SPLAT, [P, b.parts!, b.amount!, b.speed!, b.counter!], Math.ceil(this.cap / 64));
    this.kit.run(pass, PACK, [P, b.amount!, b.speed!, b.pack!], Math.ceil(this.nx / 8), Math.ceil(this.ny / 8));
    pass.end();
    this.dev.queue.submit([enc.finish()]);
    return this.kit.read([b.pack!]);
  }

  /**
   * With open edges, water that leaves the picture frees its slot: every 15 frames the live
   * particles are packed to the front, in order, so long waterfalls never run out.
   */
  async maintain(): Promise<void> {
    if (this.sim.containers.length || this.frame % 15 !== 0) return;
    const bytes = await this.kit.read([this.b.parts!, this.b.counter!]);
    const parts = new Float32Array(bytes.buffer, bytes.byteOffset, this.cap * 4);
    const count = new Uint32Array(bytes.buffer, bytes.byteOffset + this.cap * 16, 1)[0]!;
    const out = new Float32Array(this.cap * 4);
    let n = 0;
    for (let i = 0; i < Math.min(count, this.cap); i++) {
      if (parts[i * 4]! < 0) continue;
      out.set(parts.subarray(i * 4, i * 4 + 4), n * 4);
      n++;
    }
    this.dev.queue.writeBuffer(this.b.parts!, 0, out);
    this.dev.queue.writeBuffer(this.b.counter!, 0, new Uint32Array([n, 0, 0, 0]));
  }

  async saveState(): Promise<Uint8Array> {
    return this.kit.read([this.b.parts!, this.b.counter!]);
  }

  loadState(bytes: Uint8Array, frame: number): void {
    this.kit.write([this.b.parts!, this.b.counter!], bytes);
    this.frame = frame;
  }

  destroy(): void {
    for (const b of Object.values(this.b)) b.destroy();
    for (const p of this.params) p.destroy();
  }
}
