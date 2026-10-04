/**
 * WebGPU device, texture pool and a tiny helper for full-screen passes.
 * One device is shared by the compositor, three.js (3D scenes) and the projector output stage,
 * so 3D renders and layer textures flow between them with no copies.
 */
export const WORK_FORMAT: GPUTextureFormat = "rgba16float";
export const COVERAGE_FORMAT: GPUTextureFormat = "r8unorm";

export interface GpuInfo {
  readonly vendor: string;
  readonly architecture: string;
  readonly description: string;
  readonly features: readonly string[];
}

export class GpuError extends Error {
  readonly userMessage: string;
  constructor(userMessage: string, detail?: string) {
    super(detail ? `${userMessage} (${detail})` : userMessage);
    this.userMessage = userMessage;
  }
}

interface PooledTexture {
  readonly texture: GPUTexture;
  readonly key: string;
}

export class Gpu {
  readonly samplerLinear: GPUSampler;
  readonly samplerNearest: GPUSampler;
  private readonly modules = new Map<string, GPUShaderModule>();
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly free = new Map<string, GPUTexture[]>();
  private readonly inUse = new Set<GPUTexture>();
  /** Per-frame transient resources, destroyed after the frame's commands are submitted. */
  private garbage: Array<GPUTexture | GPUBuffer> = [];
  private lost = false;
  /** WebGPU validation errors seen so far (should always be empty). */
  readonly validationErrors: string[] = [];

  private constructor(
    readonly device: GPUDevice,
    readonly info: GpuInfo,
  ) {
    this.samplerLinear = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    this.samplerNearest = device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
    void device.lost.then((l) => {
      this.lost = true;
      console.error(`[gpu] device lost: ${l.reason} ${l.message}`);
    });
  }

  static async create(): Promise<Gpu> {
    if (!("gpu" in navigator)) throw new GpuError("This computer's graphics driver doesn't offer WebGPU, which Before Effects needs for rendering.");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new GpuError("No graphics adapter was available. Update the graphics driver and restart Before Effects.");
    const wanted: GPUFeatureName[] = ["float32-filterable", "rg11b10ufloat-renderable", "timestamp-query"];
    const features = wanted.filter((f) => adapter.features.has(f));
    const device = await adapter.requestDevice({
      requiredFeatures: features,
      requiredLimits: {
        maxTextureDimension2D: Math.min(16384, adapter.limits.maxTextureDimension2D),
        maxBufferSize: adapter.limits.maxBufferSize,
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      },
    });
    device.onuncapturederror = (e) => console.error("[gpu] uncaptured error:", e.error.message);
    const ai = adapter.info;
    const gpu = new Gpu(device, { vendor: ai.vendor, architecture: ai.architecture, description: ai.description, features });
    // Recorded even when another library (three.js) installs its own handler: a shader or pipeline
    // mistake must never go unnoticed (tests fail on any).
    device.addEventListener("uncapturederror", (e) => gpu.validationErrors.push((e as GPUUncapturedErrorEvent).error.message.slice(0, 300)));
    return gpu;
  }

  get isLost(): boolean {
    return this.lost;
  }

  module(code: string): GPUShaderModule {
    let m = this.modules.get(code);
    if (!m) {
      m = this.device.createShaderModule({ code });
      this.modules.set(code, m);
    }
    return m;
  }

  /** Cached full-screen (or custom-vertex) render pipeline. */
  pipeline(code: string, format: GPUTextureFormat, blend?: GPUBlendState, key = ""): GPURenderPipeline {
    const k = `${format}|${JSON.stringify(blend ?? null)}|${key}|${code.length}|${code.slice(-64)}|${hashCode(code)}`;
    let p = this.pipelines.get(k);
    if (!p) {
      const module = this.module(code);
      p = this.device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format, ...(blend ? { blend } : {}) }] },
        primitive: { topology: "triangle-list" },
      });
      this.pipelines.set(k, p);
    }
    return p;
  }

  /**
   * Returned textures kept for reuse: when each came back (oldest first) and their size. A layer's
   * texture is sized to the layer, so over a long show textures of ever more sizes come back; those
   * not reused for a while, and the oldest past a limit, are freed (see tidy).
   */
  private readonly freeAt = new Map<GPUTexture, number>();
  private freeBytes = 0;
  private lastTidy = 0;
  /** Returned textures are freed after this long unused (ms), and beyond this many bytes, oldest first. */
  static readonly FREE_AFTER_MS = 2000;
  static readonly FREE_LIMIT_BYTES = 768 * 1024 * 1024;

  /** Borrow a render-target texture; return it with release(). */
  acquire(width: number, height: number, format: GPUTextureFormat = WORK_FORMAT, label = "work"): GPUTexture {
    const w = Math.max(1, Math.ceil(width));
    const h = Math.max(1, Math.ceil(height));
    const key = `${w}x${h}:${format}`;
    const list = this.free.get(key);
    const reused = list?.pop();
    if (reused) {
      this.freeAt.delete(reused);
      this.freeBytes -= texBytes(reused);
      if (list!.length === 0) this.free.delete(key);
    }
    const t =
      reused ??
      this.device.createTexture({
        label,
        size: [w, h],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
      });
    this.inUse.add(t);
    return t;
  }

  /** Take a texture out of the pool for good (e.g. into the frame cache); the new owner destroys it. */
  detach(t: GPUTexture): GPUTexture {
    this.inUse.delete(t);
    return t;
  }

  /** Approximate bytes of all pooled textures (in use + free), for memory reporting. */
  pooledBytes(): number {
    let n = this.freeBytes;
    for (const t of this.inUse) n += texBytes(t);
    return n;
  }

  /** What the pool holds: textures lent out (in use) and kept for reuse (free). */
  poolReport(): { inUse: number; inUseBytes: number; free: number; freeBytes: number } {
    let inUseBytes = 0;
    for (const t of this.inUse) inUseBytes += texBytes(t);
    return { inUse: this.inUse.size, inUseBytes, free: this.freeAt.size, freeBytes: this.freeBytes };
  }

  release(t: GPUTexture | undefined | null): void {
    if (!t || !this.inUse.has(t)) return;
    this.inUse.delete(t);
    const key = `${t.width}x${t.height}:${t.format}`;
    const list = this.free.get(key) ?? [];
    list.push(t);
    this.free.set(key, list);
    this.freeAt.set(t, performance.now());
    this.freeBytes += texBytes(t);
  }

  /** Free pooled textures that are not in use (call when memory is tight or sizes change). */
  trim(): void {
    for (const list of this.free.values()) for (const t of list) t.destroy();
    this.free.clear();
    this.freeAt.clear();
    this.freeBytes = 0;
  }

  /**
   * After a submit: free returned textures unused for FREE_AFTER_MS, and the oldest beyond
   * FREE_LIMIT_BYTES (only ones returned at least a quarter second ago, so no command still waiting
   * to be submitted uses them).
   */
  private tidy(): void {
    const now = performance.now();
    if (now - this.lastTidy < 250 && this.freeBytes <= Gpu.FREE_LIMIT_BYTES) return;
    this.lastTidy = now;
    for (const [t, at] of this.freeAt) {
      const old = now - at;
      if (old < 250) break;
      if (old < Gpu.FREE_AFTER_MS && this.freeBytes <= Gpu.FREE_LIMIT_BYTES) break;
      const key = `${t.width}x${t.height}:${t.format}`;
      const list = this.free.get(key);
      if (list) {
        const i = list.indexOf(t);
        if (i >= 0) list.splice(i, 1);
        if (list.length === 0) this.free.delete(key);
      }
      this.freeAt.delete(t);
      this.freeBytes -= texBytes(t);
      t.destroy();
    }
  }

  /** A small uniform buffer that lives until the current frame is submitted. */
  uniform(data: ArrayBuffer | ArrayBufferView): GPUBuffer {
    const size = Math.ceil(data.byteLength / 16) * 16;
    const buf = this.device.createBuffer({ size: Math.max(16, size), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buf, 0, data instanceof ArrayBuffer ? data : (data.buffer as ArrayBuffer), data instanceof ArrayBuffer ? 0 : data.byteOffset, data.byteLength);
    this.garbage.push(buf);
    return buf;
  }

  /** Destroy a non-pooled resource once the current frame has been submitted. */
  defer(resource: GPUTexture | GPUBuffer): void {
    this.garbage.push(resource);
  }

  /** Submit the frame's commands, then free its transient resources (safe: work already queued keeps them alive). */
  submit(encoder: GPUCommandEncoder): void {
    this.device.queue.submit([encoder.finish()]);
    for (const r of this.garbage.splice(0)) r.destroy();
    this.tidy();
  }

  /**
   * Run a full-screen pass: bind entries (in binding order) and draw into `target`.
   * `clear` clears the target first; otherwise existing content is kept (for blending).
   */
  pass(
    encoder: GPUCommandEncoder,
    code: string,
    target: GPUTexture,
    entries: Array<GPUBindingResource>,
    opts: { clear?: GPUColor | null; blend?: GPUBlendState; vertexCount?: number; key?: string } = {},
  ): void {
    const pipe = this.pipeline(code, target.format, opts.blend, opts.key);
    const bind = this.device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: entries.map((resource, binding) => ({ binding, resource })),
    });
    const rp = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target.createView(),
          loadOp: opts.clear === undefined || opts.clear !== null ? "clear" : "load",
          clearValue: opts.clear ?? { r: 0, g: 0, b: 0, a: 0 },
          storeOp: "store",
        },
      ],
    });
    rp.setPipeline(pipe);
    rp.setBindGroup(0, bind);
    rp.draw(opts.vertexCount ?? 3);
    rp.end();
  }
}

const hashCode = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
};

/** Bytes a texture takes (colour formats used here). */
const texBytes = (t: GPUTexture): number => t.width * t.height * (t.format === "rgba16float" ? 8 : t.format === "rgba32float" ? 16 : 4) * Math.max(1, t.depthOrArrayLayers);

/** Premultiplied "over" (normal) and additive blend states for hardware compositing. */
export const BLEND_OVER: GPUBlendState = {
  color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
};
export const BLEND_ADD: GPUBlendState = {
  color: { srcFactor: "one", dstFactor: "one", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
};
export const BLEND_SCREEN: GPUBlendState = {
  color: { srcFactor: "one", dstFactor: "one-minus-src", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
};
export const BLEND_MULTIPLY: GPUBlendState = {
  color: { srcFactor: "dst", dstFactor: "one-minus-src-alpha", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
};
