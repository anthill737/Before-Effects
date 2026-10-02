/**
 * 3D projection preview: the venue as a solid object in space, its front lit by the projected
 * content (surface colour × (ambient + light)), with an orbit / pan / zoom camera.
 *
 * Flat venues (traced from a photo) become a facade slab whose front is the traced canvas. Model
 * venues will use their imported mesh and UVs (milestone D). This is a design aid for judging
 * the look from different viewpoints, not a measured lighting simulation.
 */
import { type Mat4, mat4Mul } from "@be/core";
import type { Gpu } from "./gpu.ts";
import { COMMON } from "./shaders.ts";

export interface OrbitCamera {
  /** Degrees around the vertical axis; 0 = straight in front. */
  readonly yaw: number;
  /** Degrees up from horizontal. */
  readonly pitch: number;
  /** Distance as a multiple of the facade width. */
  readonly distance: number;
  /** Look-at offset in facade widths (pan). */
  readonly panX: number;
  readonly panY: number;
}

export const DEFAULT_ORBIT: OrbitCamera = { yaw: -18, pitch: 8, distance: 1.55, panX: 0, panY: 0 };

const SHADER = /* wgsl */ `
${COMMON}
struct U { viewProj: mat4x4f, ambient: f32, exposure: f32, aspect: f32, _p: f32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var content: texture_2d<f32>;
@group(0) @binding(2) var albedo: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
struct VIn { @location(0) pos: vec3f, @location(1) uv: vec2f, @location(2) kind: f32 };
struct MeshOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) kind: f32, @location(2) world: vec3f };
@vertex fn vs(v: VIn) -> MeshOut {
  var o: MeshOut;
  o.pos = u.viewProj * vec4f(v.pos, 1.0);
  o.uv = v.uv;
  o.kind = v.kind;
  o.world = v.pos;
  return o;
}
@fragment fn fs(i: MeshOut) -> @location(0) vec4f {
  var rgb = vec3f(0.0);
  if (i.kind < 0.5) {
    // Front face: surface colour lit by ambient light plus the projected content.
    let light = textureSampleLevel(content, samp, i.uv, 0.0).rgb;
    let a = srgb_to_linear(textureSampleLevel(albedo, samp, i.uv, 0.0).rgb) * 1.6;
    rgb = a * (u.ambient + light * u.exposure);
  } else if (i.kind < 1.5) {
    // Sides and top: unlit surface, slightly shaded.
    let edge = srgb_to_linear(textureSampleLevel(albedo, samp, vec2f(0.5, 0.5), 0.0).rgb);
    rgb = edge * u.ambient * (0.55 + 0.25 * (i.kind - 1.0));
  } else {
    // Ground: dark with a soft 1-unit grid that fades with distance.
    let g = abs(fract(i.world.xz) - 0.5);
    let line = 1.0 - smoothstep(0.0, 0.03, min(g.x, g.y));
    let fade = clamp(1.0 - length(i.world.xz) / 30.0, 0.0, 1.0);
    rgb = vec3f(0.012, 0.014, 0.018) + vec3f(0.05, 0.06, 0.08) * line * fade;
  }
  return vec4f(linear_to_srgb(rgb), 1.0);
}
`;

const LINE_SHADER = /* wgsl */ `
${COMMON}
struct U { viewProj: mat4x4f, color: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@vertex fn vs(@location(0) pos: vec3f) -> @builtin(position) vec4f { return u.viewProj * vec4f(pos, 1.0); }
@fragment fn fs() -> @location(0) vec4f { return u.color; }
`;

const perspective = (fovYDeg: number, aspect: number, near: number, far: number): Mat4 => {
  const f = 1 / Math.tan((fovYDeg * Math.PI) / 360);
  const m = new Float64Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (near * far) / (near - far);
  return m;
};

const lookAt = (eye: number[], target: number[], up: number[]): Mat4 => {
  const sub = (a: number[], b: number[]) => a.map((x, i) => x - b[i]!);
  const norm = (a: number[]) => {
    const l = Math.hypot(...a) || 1;
    return a.map((x) => x / l);
  };
  const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
  const z = norm(sub(eye, target));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  const m = new Float64Array(16);
  m[0] = x[0]!;
  m[4] = x[1]!;
  m[8] = x[2]!;
  m[1] = y[0]!;
  m[5] = y[1]!;
  m[9] = y[2]!;
  m[2] = z[0]!;
  m[6] = z[1]!;
  m[10] = z[2]!;
  m[12] = -dot(x, eye);
  m[13] = -dot(y, eye);
  m[14] = -dot(z, eye);
  m[15] = 1;
  return m;
};

/** World size of a flat venue: 10 units wide, height from the canvas aspect, fixed depth. */
const venueSize = (canvasW: number, canvasH: number) => {
  const w = 10;
  return { w, h: (w * canvasH) / canvasW, d: 0.8 };
};

export class VenuePreview3D {
  private pipeline: GPURenderPipeline;
  private linePipeline: GPURenderPipeline;
  private depth: GPUTexture | null = null;
  private meshKey = "";
  private vbuf: GPUBuffer | null = null;
  private vcount = 0;
  private lbuf: GPUBuffer | null = null;
  private lcount = 0;

  constructor(
    private readonly gpu: Gpu,
    private readonly format: GPUTextureFormat,
  ) {
    const module = gpu.device.createShaderModule({ code: SHADER });
    this.pipeline = gpu.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 24,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x2" },
              { shaderLocation: 2, offset: 20, format: "float32" },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    });
    const lm = gpu.device.createShaderModule({ code: LINE_SHADER });
    this.linePipeline = gpu.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: lm, entryPoint: "vs", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
      fragment: { module: lm, entryPoint: "fs", targets: [{ format, blend: { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one" } } }] },
      primitive: { topology: "line-list" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less" },
    });
  }

  private buildMesh(canvasW: number, canvasH: number, withProjector: boolean) {
    const key = `${canvasW}x${canvasH}:${withProjector}`;
    if (key === this.meshKey) return;
    this.meshKey = key;
    const { w, h, d } = venueSize(canvasW, canvasH);
    const x0 = -w / 2;
    const x1 = w / 2;
    const v: number[] = [];
    const quad = (a: number[], b: number[], c: number[], e: number[], uv: number[][], kind: number) => {
      const pts = [a, b, c, a, c, e];
      const uvs = [uv[0]!, uv[1]!, uv[2]!, uv[0]!, uv[2]!, uv[3]!];
      pts.forEach((p, i) => v.push(p[0]!, p[1]!, p[2]!, uvs[i]![0]!, uvs[i]![1]!, kind));
    };
    const U = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    // Front (z = 0), uv (0,0) at top-left of the traced canvas.
    quad([x0, h, 0], [x1, h, 0], [x1, 0, 0], [x0, 0, 0], U, 0);
    // Sides, top, back.
    quad([x0, h, -d], [x0, h, 0], [x0, 0, 0], [x0, 0, -d], U, 1);
    quad([x1, h, 0], [x1, h, -d], [x1, 0, -d], [x1, 0, 0], U, 1);
    quad([x0, h, -d], [x1, h, -d], [x1, h, 0], [x0, h, 0], U, 1.8);
    quad([x1, h, -d], [x0, h, -d], [x0, 0, -d], [x1, 0, -d], U, 1);
    // Ground.
    const g = 40;
    quad([-g, 0, -g], [g, 0, -g], [g, 0, g], [-g, 0, g], U, 2);
    this.vbuf?.destroy();
    this.vbuf = this.gpu.device.createBuffer({ size: v.length * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.gpu.device.queue.writeBuffer(this.vbuf, 0, new Float32Array(v));
    this.vcount = v.length / 6;

    // Projector marker and light cone (position assumed, not measured).
    const l: number[] = [];
    if (withProjector) {
      const p = [0, h * 0.45, w * 1.35];
      const corners = [
        [x0, h, 0.01],
        [x1, h, 0.01],
        [x1, 0, 0.01],
        [x0, 0, 0.01],
      ];
      for (const c of corners) l.push(...p, ...c);
      const s = w * 0.035;
      const box = [
        [p[0]! - s, p[1]! - s * 0.6, p[2]! - s],
        [p[0]! + s, p[1]! - s * 0.6, p[2]! - s],
        [p[0]! + s, p[1]! + s * 0.6, p[2]! - s],
        [p[0]! - s, p[1]! + s * 0.6, p[2]! - s],
        [p[0]! - s, p[1]! - s * 0.6, p[2]! + s],
        [p[0]! + s, p[1]! - s * 0.6, p[2]! + s],
        [p[0]! + s, p[1]! + s * 0.6, p[2]! + s],
        [p[0]! - s, p[1]! + s * 0.6, p[2]! + s],
      ];
      const edges = [
        [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7],
      ];
      for (const [a, b] of edges) l.push(...box[a!]!, ...box[b!]!);
    }
    this.lbuf?.destroy();
    this.lbuf = l.length ? this.gpu.device.createBuffer({ size: l.length * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }) : null;
    if (this.lbuf) this.gpu.device.queue.writeBuffer(this.lbuf, 0, new Float32Array(l));
    this.lcount = l.length / 3;
  }

  /** View-projection for an orbit camera framing a venue canvas of the given size. */
  static viewProj(canvasW: number, canvasH: number, cam: OrbitCamera, aspect: number): Mat4 {
    const { w, h } = venueSize(canvasW, canvasH);
    const target = [cam.panX * w, h / 2 + cam.panY * w, -0.4];
    const yaw = (cam.yaw * Math.PI) / 180;
    const pitch = (Math.max(-5, Math.min(85, cam.pitch)) * Math.PI) / 180;
    const dist = Math.max(0.2, cam.distance) * w;
    const eye = [target[0]! + dist * Math.sin(yaw) * Math.cos(pitch), target[1]! + dist * Math.sin(pitch), target[2]! + dist * Math.cos(yaw) * Math.cos(pitch)];
    return mat4Mul(perspective(40, aspect, 0.05, 400), lookAt(eye, target, [0, 1, 0]));
  }

  draw(
    encoder: GPUCommandEncoder,
    target: GPUTexture,
    content: GPUTexture,
    albedo: GPUTexture,
    venueCanvas: { width: number; height: number },
    cam: OrbitCamera,
    opts: { ambient?: number; showProjector?: boolean } = {},
  ): void {
    const { gpu } = this;
    this.buildMesh(venueCanvas.width, venueCanvas.height, !!opts.showProjector);
    if (!this.depth || this.depth.width !== target.width || this.depth.height !== target.height) {
      this.depth?.destroy();
      this.depth = gpu.device.createTexture({ size: [target.width, target.height], format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT });
    }
    const vp = VenuePreview3D.viewProj(venueCanvas.width, venueCanvas.height, cam, target.width / target.height);
    const u = new Float32Array(20);
    u.set(Float32Array.from(vp), 0);
    u[16] = opts.ambient ?? 0.1;
    u[17] = 1;
    u[18] = target.width / target.height;
    const bind = gpu.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: gpu.uniform(u) } },
        { binding: 1, resource: content.createView() },
        { binding: 2, resource: albedo.createView() },
        { binding: 3, resource: gpu.samplerLinear },
      ],
    });
    const rp = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: "clear", clearValue: { r: 0.02, g: 0.025, b: 0.035, a: 1 }, storeOp: "store" }],
      depthStencilAttachment: { view: this.depth.createView(), depthLoadOp: "clear", depthClearValue: 1, depthStoreOp: "store" },
    });
    rp.setPipeline(this.pipeline);
    rp.setBindGroup(0, bind);
    rp.setVertexBuffer(0, this.vbuf!);
    rp.draw(this.vcount);
    if (this.lbuf && this.lcount) {
      const lu = new Float32Array(20);
      lu.set(Float32Array.from(vp), 0);
      lu.set([1, 0.77, 0.42, 0.55], 16);
      rp.setPipeline(this.linePipeline);
      rp.setBindGroup(0, gpu.device.createBindGroup({ layout: this.linePipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: gpu.uniform(lu) } }] }));
      rp.setVertexBuffer(0, this.lbuf);
      rp.draw(this.lcount);
    }
    rp.end();
  }
}
