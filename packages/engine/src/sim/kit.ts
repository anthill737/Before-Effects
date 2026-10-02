/** Small helper for the simulation compute passes: cached pipelines and bind groups. */
export class ComputeKit {
  private readonly pipes = new Map<string, GPUComputePipeline>();
  private readonly groups = new Map<string, GPUBindGroup>();
  private readonly ids = new WeakMap<GPUBuffer, number>();
  private nextId = 1;

  constructor(readonly dev: GPUDevice) {}

  private id(b: GPUBuffer): number {
    let i = this.ids.get(b);
    if (!i) this.ids.set(b, (i = this.nextId++));
    return i;
  }

  pipe(code: string): GPUComputePipeline {
    let p = this.pipes.get(code);
    if (!p) {
      p = this.dev.createComputePipeline({ layout: "auto", compute: { module: this.dev.createShaderModule({ code }), entryPoint: "main" } });
      this.pipes.set(code, p);
    }
    return p;
  }

  /** Dispatch `code` with buffers bound in order (binding 0, 1, …). */
  run(pass: GPUComputePassEncoder, code: string, buffers: readonly GPUBuffer[], x: number, y = 1): void {
    const p = this.pipe(code);
    const key = `${code.length}:${code.slice(-40)}|${buffers.map((b) => this.id(b)).join(",")}`;
    let g = this.groups.get(key);
    if (!g) {
      g = this.dev.createBindGroup({ layout: p.getBindGroupLayout(0), entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
      this.groups.set(key, g);
    }
    pass.setPipeline(p);
    pass.setBindGroup(0, g);
    pass.dispatchWorkgroups(x, y);
  }

  /** Read buffers back to the CPU, concatenated. */
  async read(buffers: readonly GPUBuffer[]): Promise<Uint8Array> {
    const total = buffers.reduce((s, b) => s + b.size, 0);
    const staging = this.dev.createBuffer({ size: total, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.dev.createCommandEncoder();
    let off = 0;
    for (const b of buffers) {
      enc.copyBufferToBuffer(b, 0, staging, off, b.size);
      off += b.size;
    }
    this.dev.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new Uint8Array(staging.getMappedRange().slice(0));
    staging.destroy();
    return out;
  }

  /** Inverse of read(): fill buffers from concatenated bytes. */
  write(buffers: readonly GPUBuffer[], bytes: Uint8Array): void {
    let off = 0;
    for (const b of buffers) {
      this.dev.queue.writeBuffer(b, 0, bytes.buffer as ArrayBuffer, bytes.byteOffset + off, b.size);
      off += b.size;
    }
  }
}
