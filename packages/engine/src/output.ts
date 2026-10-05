/**
 * Output stages:
 *   - encodeForFile(): content master (composition) → display-encoded rgba8/rgba16 pixels, with
 *     or without alpha.
 *   - renderProjectorOutput(): venue content → one projector's output, through that projector's
 *     calibration (homography), output masks and output colour correction. This is the only place
 *     mapping and output correction are applied, so a projector output is never mapped twice.
 *   - readback(): GPU texture → CPU bytes for encoders (rows unpadded).
 */
import { flattenPath, type Mat3, mat3Invert, type PathData, type Projector, solveHomography, type Vec2 } from "@be/core";
import type { Gpu } from "./gpu.ts";
import type { CoverageRasterizer } from "./raster.ts";
import { ENCODE, OUTPUT_WARP } from "./shaders.ts";

export type PixelFormat = "rgba8" | "rgba16";

const gpuFormat = (f: PixelFormat): GPUTextureFormat => (f === "rgba8" ? "rgba8unorm" : "rgba16float");

export interface EncodeOptions {
  readonly keepAlpha: boolean;
  /** Linear background colour used when flattening (premultiplied), e.g. the comp background. */
  readonly background: readonly [number, number, number, number];
  readonly format: PixelFormat;
  /** Apply the sRGB display encoding (true for normal video/PNG; false for linear EXR). */
  readonly encodeSrgb?: boolean;
}

export const encodeForFile = (gpu: Gpu, encoder: GPUCommandEncoder, src: GPUTexture, o: EncodeOptions): GPUTexture => {
  const out = gpu.device.createTexture({
    label: "encoded",
    size: [src.width, src.height],
    format: gpuFormat(o.format),
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
  });
  const u = new ArrayBuffer(32);
  new Float32Array(u, 0, 4).set(o.background);
  new Uint32Array(u, 16, 2).set([o.keepAlpha ? 1 : 0, o.encodeSrgb === false ? 0 : 1]);
  gpu.pass(encoder, ENCODE, out, [src.createView(), gpu.samplerNearest, { buffer: gpu.uniform(u) }]);
  return out;
};

/** The calibration homography (content px → output px) and its inverse, or null when the points are degenerate. */
export const projectorHomography = (p: Projector): { h: Mat3; hinv: Mat3 } | null => {
  const pts = p.calibration.points;
  const h = solveHomography(
    pts.map((x) => x.content as Vec2),
    pts.map((x) => x.output as Vec2),
  );
  if (!h) return null;
  const hinv = mat3Invert(h);
  return hinv ? { h, hinv } : null;
};

export interface ProjectorOutputOptions {
  readonly format: PixelFormat;
  /** Render size; defaults to the projector's configured output size (preview may use a fraction). */
  readonly size?: { readonly width: number; readonly height: number };
  /** Areas of the venue (content space) where projected light must stay off, e.g. a neighbour's window. */
  readonly keepOff?: readonly PathData[];
  /** Overlay the content grid to help alignment. */
  readonly showGrid?: boolean;
  readonly encodeSrgb?: boolean;
  /** The venue's house areas (for alignments that correct some areas on their own: their outlines). */
  readonly regions?: Readonly<Record<string, { readonly path: PathData }>>;
  /** Edge blending with the other projectors lighting the same content (see core projection.ts). */
  readonly blend?: { readonly curve: number; readonly others: ReadonlyArray<{ readonly h: Mat3; readonly size: { readonly width: number; readonly height: number } }> };
}

export const renderProjectorOutput = (
  gpu: Gpu,
  raster: CoverageRasterizer,
  encoder: GPUCommandEncoder,
  content: GPUTexture,
  contentSize: { width: number; height: number },
  projector: Projector,
  o: ProjectorOutputOptions,
): GPUTexture => {
  const { width, height } = o.size ?? projector.output;
  const out = gpu.device.createTexture({
    label: `output:${projector.name}`,
    size: [width, height],
    format: gpuFormat(o.format),
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
  });
  const hom = projectorHomography(projector);
  const hinv = hom?.hinv ?? Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  // 96 bytes of warp and correction, then the blend: vec4 + 7 mat3x3 (48 bytes each) + 7 vec4; then the residual grid's size.
  const u = new ArrayBuffer(96 + 16 + 7 * 48 + 7 * 16 + 16 + 16);
  const f = new Float32Array(u);
  // mat3x3f: three vec3 columns, each padded to 16 bytes.
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) f[c * 4 + r] = hinv[c * 3 + r]!;
  // The warp works in projector pixel units; a smaller preview target samples the same mapping.
  f.set([contentSize.width, contentSize.height, projector.output.width, projector.output.height], 12);
  f.set(projector.outputColor.gain, 16);
  f[20] = projector.outputColor.gamma;
  f[21] = projector.outputColor.blackLevel;
  new Uint32Array(u, 88, 2).set([o.encodeSrgb === false ? 0 : 1, o.showGrid ? 1 : 0]);
  const others = (o.blend?.others ?? []).slice(0, 7);
  f.set([others.length, o.blend?.curve ?? 2, 0, 0], 24);
  others.forEach((x, k) => {
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) f[28 + k * 12 + c * 4 + r] = x.h[c * 3 + r]!;
    f.set([x.size.width, x.size.height, 0, 0], 28 + 7 * 12 + k * 4);
  });
  // The camera-measured residual grid (alignment "mesh"), when there is one.
  const mesh = projector.calibration.mode === "mesh" ? projector.calibration.mesh : undefined;
  const meshTex = mesh && mesh.cols >= 2 && mesh.rows >= 2 && mesh.offsets.length === mesh.cols * mesh.rows ? meshTexture(gpu, mesh) : null;
  // Surface labels: per grid point (in the grid texture) and over the content (a label map of the areas).
  const labelTex = meshTex && mesh!.labels?.length === mesh!.offsets.length && mesh!.surfaces?.length && o.regions ? surfaceLabelTexture(gpu, mesh!.surfaces, o.regions, contentSize) : null;
  f.set([meshTex ? mesh!.cols : 1, meshTex ? mesh!.rows : 1, meshTex ? 1 : 0, labelTex ? 1 : 0], 140);
  if (labelTex) f.set([labelTex.width / contentSize.width, labelTex.height / contentSize.height, labelTex.width, labelTex.height], 144);
  else f.set([0, 0, 1, 1], 144);
  // Output masks are areas (in projector pixels) where light is blocked; none = nothing blocked.
  let mask: GPUTexture;
  if (projector.outputMasks.length) {
    mask = raster.mask(projector.outputMasks, 0, { x: 0, y: 0, w: projector.output.width, h: projector.output.height, scale: width / projector.output.width }, "outmask");
  } else {
    mask = blackTexture(gpu);
  }
  let keepOff: GPUTexture = blackTexture(gpu);
  if (o.keepOff?.length) {
    const k = Math.min(1, 2048 / Math.max(contentSize.width, contentSize.height));
    keepOff = raster.mask(o.keepOff, 0, { x: 0, y: 0, w: contentSize.width, h: contentSize.height, scale: k }, "keepoff");
  }
  gpu.pass(encoder, OUTPUT_WARP, out, [content.createView(), gpu.samplerLinear, { buffer: gpu.uniform(u) }, mask.createView(), keepOff.createView(), (meshTex ?? halfZero(gpu)).createView(), (labelTex ?? blackTexture(gpu)).createView(), (labelTex && mesh!.base?.length === mesh!.offsets.length ? meshTexture(gpu, { cols: mesh!.cols, rows: mesh!.rows, offsets: mesh!.base! }) : (meshTex ?? halfZero(gpu))).createView()]);
  return out;
};

/** Float → IEEE half (round to nearest). */
const toHalf = (v: number): number => {
  const f = new Float32Array([v]);
  const x = new Uint32Array(f.buffer)[0]!;
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (e <= 0) return sign;
  if (e >= 31) return sign | 0x7c00;
  m += 0x1000;
  if (m & 0x800000) {
    m = 0;
    e++;
    if (e >= 31) return sign | 0x7c00;
  }
  return sign | (e << 10) | (m >> 13);
};

/** The residual grid as a texture (half floats: offsets are small, so ~0.03 px precision), one per grid. */
const meshTextures = new WeakMap<object, { device: GPUDevice; tex: GPUTexture }>();
const meshTexture = (gpu: Gpu, mesh: NonNullable<Projector["calibration"]["mesh"]>): GPUTexture => {
  const hit = meshTextures.get(mesh.offsets);
  if (hit && hit.device === gpu.device) return hit.tex;
  const tex = gpu.device.createTexture({ label: "alignment-grid", size: [mesh.cols, mesh.rows], format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  const data = new Uint16Array(mesh.cols * mesh.rows * 4);
  mesh.offsets.forEach((o, i) => {
    data[i * 4] = toHalf(o[0]);
    data[i * 4 + 1] = toHalf(o[1]);
    data[i * 4 + 2] = toHalf(mesh.labels?.[i] ?? 0);
  });
  gpu.device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: mesh.cols * 8 }, [mesh.cols, mesh.rows]);
  meshTextures.set(mesh.offsets, { device: gpu.device, tex });
  return tex;
};
/**
 * Which surface each content point is on, as a texture (label k = the alignment's surfaces[k − 1]; 0 =
 * the main wall). Larger areas first, smaller over them: the most specific area wins, as in core
 * autoAlign.ts surfaceLabeler.
 */
const labelTextures = new WeakMap<object, { device: GPUDevice; regions: object; w: number; h: number; tex: GPUTexture }>();
const surfaceLabelTexture = (gpu: Gpu, surfaces: readonly string[], regions: Readonly<Record<string, { readonly path: PathData }>>, size: { width: number; height: number }): GPUTexture | null => {
  const hit = labelTextures.get(surfaces);
  if (hit && hit.device === gpu.device && hit.regions === regions && hit.w === size.width && hit.h === size.height) return hit.tex;
  const k = Math.min(1, 1024 / Math.max(size.width, size.height));
  const w = Math.max(1, Math.ceil(size.width * k)), h = Math.max(1, Math.ceil(size.height * k));
  const data = new Uint8Array(w * h * 4);
  const polys = surfaces
    .map((id, i) => ({ label: i + 1, poly: regions[id] ? flattenPath(regions[id]!.path, 8).map((p) => [p[0] * k, p[1] * k] as Vec2) : [] }))
    .filter((x) => x.poly.length >= 3)
    .map((x) => ({ ...x, area: Math.abs(x.poly.reduce((s, p, i) => { const q = x.poly[(i + 1) % x.poly.length]!; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2) }))
    .sort((a, b) => b.area - a.area);
  for (const { label, poly } of polys) {
    // Scanline fill at pixel centres.
    for (let y = 0; y < h; y++) {
      const yc = y + 0.5;
      const xs: number[] = [];
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i]!, b = poly[j]!;
        if (a[1] > yc !== b[1] > yc) xs.push(a[0] + ((yc - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
      xs.sort((p, q) => p - q);
      for (let s = 0; s + 1 < xs.length; s += 2) for (let x = Math.max(0, Math.ceil(xs[s]! - 0.5)); x < Math.min(w, Math.ceil(xs[s + 1]! - 0.5)); x++) data[(y * w + x) * 4] = label;
    }
  }
  const tex = gpu.device.createTexture({ label: "surface-labels", size: [w, h], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  gpu.device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: w * 4 }, [w, h]);
  labelTextures.set(surfaces, { device: gpu.device, regions, w: size.width, h: size.height, tex });
  return tex;
};

const halfZeroByDevice = new WeakMap<GPUDevice, GPUTexture>();
const halfZero = (gpu: Gpu): GPUTexture => {
  let t = halfZeroByDevice.get(gpu.device);
  if (!t) {
    t = gpu.device.createTexture({ size: [1, 1], format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    gpu.device.queue.writeTexture({ texture: t }, new Uint16Array(4), { bytesPerRow: 8 }, [1, 1]);
    halfZeroByDevice.set(gpu.device, t);
  }
  return t;
};

const blackByDevice = new WeakMap<GPUDevice, GPUTexture>();
const blackTexture = (gpu: Gpu): GPUTexture => {
  let t = blackByDevice.get(gpu.device);
  if (!t) {
    t = gpu.device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    gpu.device.queue.writeTexture({ texture: t }, new Uint8Array([0, 0, 0, 0]), { bytesPerRow: 4 }, [1, 1]);
    blackByDevice.set(gpu.device, t);
  }
  return t;
};

/** Read a texture back to CPU memory with row padding removed. rgba16float → Uint16Array of half floats. */
export const readback = async (gpu: Gpu, tex: GPUTexture): Promise<Uint8Array> => {
  const bpp = tex.format.startsWith("rgba8") || tex.format.startsWith("bgra8") ? 4 : tex.format === "rgba16float" ? 8 : 16;
  const rowBytes = tex.width * bpp;
  const padded = Math.ceil(rowBytes / 256) * 256;
  const buf = gpu.device.createBuffer({ size: padded * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = gpu.device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: padded }, [tex.width, tex.height]);
  gpu.device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(buf.getMappedRange());
  const out = new Uint8Array(rowBytes * tex.height);
  if (padded === rowBytes) out.set(src.subarray(0, out.length));
  else for (let y = 0; y < tex.height; y++) out.set(src.subarray(y * padded, y * padded + rowBytes), y * rowBytes);
  buf.unmap();
  buf.destroy();
  return out;
};

/** Convert half floats (0..1 display-encoded) to 16-bit unsigned integers for rgba64le encoders. */
export const halfToU16 = (bytes: Uint8Array): Uint8Array => {
  const h = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const out = new Uint16Array(h.length);
  for (let i = 0; i < h.length; i++) {
    const v = h[i]!;
    const s = v & 0x8000 ? -1 : 1;
    const e = (v >> 10) & 0x1f;
    const m = v & 0x3ff;
    const f = e === 0 ? s * 2 ** -14 * (m / 1024) : e === 31 ? (m ? 0 : s * Infinity) : s * 2 ** (e - 15) * (1 + m / 1024);
    out[i] = Math.max(0, Math.min(65535, Math.round(f * 65535)));
  }
  return new Uint8Array(out.buffer);
};
