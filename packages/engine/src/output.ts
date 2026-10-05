/**
 * Output stages:
 *   - encodeForFile(): content master (composition) → display-encoded rgba8/rgba16 pixels, with
 *     or without alpha.
 *   - renderProjectorOutput(): venue content → one projector's output, through that projector's
 *     calibration (homography), output masks and output colour correction. This is the only place
 *     mapping and output correction are applied, so a projector output is never mapped twice.
 *   - readback(): GPU texture → CPU bytes for encoders (rows unpadded).
 */
import { type Mat3, mat3Invert, type PathData, type Projector, solveHomography, type Vec2 } from "@be/core";
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
  // 96 bytes of warp and correction, then the blend: vec4 + 7 mat3x3 (48 bytes each) + 7 vec4.
  const u = new ArrayBuffer(96 + 16 + 7 * 48 + 7 * 16);
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
  gpu.pass(encoder, OUTPUT_WARP, out, [content.createView(), gpu.samplerLinear, { buffer: gpu.uniform(u) }, mask.createView(), keepOff.createView()]);
  return out;
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
