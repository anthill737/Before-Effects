/**
 * FrameRenderer: one entry point for preview, export and projector output, so they share the
 * same evaluation and GPU path.
 *
 *   renderContent()  evaluates and composites a frame at a chosen preview scale and quality.
 *                    The result can be cached and reused by every view.
 *   present()        draws a content frame into a canvas as one of three views:
 *                      "show"      the composition as exported
 *                      "3d"        the content on a 3D model of the venue (orbit camera)
 *                      "projector" the calibrated image a projector outputs
 *   renderPixels()   full-resolution, full-quality frames for encoders. Preview settings never apply.
 */
import { type EvaluatedComp, evaluateComp, type Flicks, type Id, type PathData, type Project, type ResolvedSim, type Venue } from "@be/core";

/** Venue areas marked "keep light off here" (applied only in projector output). */
const keepOffPaths = (venue: Venue | undefined): PathData[] =>
  venue ? venue.regionOrder.map((id) => venue.regions[id]).filter((r) => r?.kind === "exclusion").map((r) => r!.path) : [];
import { Compositor, type MediaProvider, srgbToLinear } from "./compositor.ts";
import { Gpu } from "./gpu.ts";
import { encodeForFile, type PixelFormat, readback, renderProjectorOutput } from "./output.ts";
import { PhysicsEngine } from "./physics.ts";
import { type Scene3DSource, SceneHost } from "./scene3d.ts";
import { SimEngine, type SimStore } from "./sim/engine.ts";
import { BUILDING_PREVIEW, ENCODE, IMPORT_PIXELS } from "./shaders.ts";
import { type OrbitCamera, VenuePreview3D } from "./venue3d.ts";

export interface PixelFrame {
  readonly width: number;
  readonly height: number;
  readonly format: PixelFormat;
  readonly data: Uint8Array;
}

export type FrameTarget =
  | { readonly kind: "master"; readonly keepAlpha: boolean }
  | { readonly kind: "projector"; readonly venueId: Id; readonly projectorId: Id; readonly showGrid?: boolean };

export type PreviewView = "show" | "venue" | "3d" | "projector";

export interface PresentOptions {
  readonly view: PreviewView;
  /** Venue reference image (surface colour) for the 3D view. */
  readonly reference?: GPUTexture | null;
  readonly ambient?: number;
  readonly orbit?: OrbitCamera;
  readonly projectorId?: Id;
  readonly showGrid?: boolean;
  /** Composition time: in the 3D view, scenes with 3D layers are inspected at this time. */
  readonly time?: Flicks;
}

/** Copy a display-encoded texture to the canvas, scaling to fit. */
const BLIT = /* wgsl */ `
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  o.uv = vec2f((p[vi].x + 1.0) * 0.5, 1.0 - (p[vi].y + 1.0) * 0.5);
  return o;
}
@fragment fn fs(i: VOut) -> @location(0) vec4f { return textureSampleLevel(src, samp, i.uv, 0.0); }
`;

export class FrameRenderer {
  private venue3d: VenuePreview3D | null = null;
  private grey: GPUTexture | null = null;

  private constructor(
    readonly gpu: Gpu,
    readonly compositor: Compositor,
    readonly scenes: SceneHost,
  ) {}

  static async create(): Promise<FrameRenderer> {
    const gpu = await Gpu.create();
    const scenes = await SceneHost.create(gpu);
    return new FrameRenderer(gpu, new Compositor(gpu, scenes), scenes);
  }

  /** Imported media source (images, video frames). Set by the host app. */
  setMedia(media: MediaProvider & { prepare?(project: Project, compId: Id, t: Flicks): Promise<void> }): void {
    this.compositor.media = media;
    this.mediaPrepare = media.prepare?.bind(media) ?? null;
  }
  private mediaPrepare: ((project: Project, compId: Id, t: Flicks) => Promise<void>) | null = null;

  /** Smoke and water simulations: prepared frames are kept in `store` (set by the host app). */
  setSimStore(store: SimStore): SimEngine {
    this.compositor.sims?.dispose();
    this.compositor.sims = new SimEngine(this.gpu, store);
    // 3D physics motion is prepared and stored the same way.
    this.scenes.physics = new PhysicsEngine(store);
    return this.compositor.sims;
  }

  get physics(): PhysicsEngine | null {
    return this.scenes.physics;
  }

  /** 3D layers shown in a composition at time t (including nested compositions). */
  scenesAt(project: Project, compId: Id, t: Flicks): Scene3DSource[] {
    const comp = project.compositions[compId];
    if (!comp) return [];
    const venueId = comp.venueId ?? project.activeVenueId;
    const out: Scene3DSource[] = [];
    const walk = (ev: EvaluatedComp) => {
      for (const l of ev.layers) {
        if (l.source.kind === "scene3d") out.push(l.source);
        else if (l.source.kind === "comp") walk(l.source.comp);
      }
    };
    walk(evaluateComp(project, compId, t, venueId ? { venueId } : {}));
    return out;
  }

  get sims(): SimEngine | null {
    return this.compositor.sims;
  }

  /** True when the last renderContent() had footage or simulation frames that weren't ready (don't cache that frame). */
  get lastFrameIncomplete(): boolean {
    return this.compositor.stats.missingMedia > 0 || this.compositor.stats.simsPending > 0;
  }

  /** Simulations shown in a composition at time t (including nested compositions). */
  simsAt(project: Project, compId: Id, t: Flicks): Array<{ sim: ResolvedSim; frame: number }> {
    const comp = project.compositions[compId];
    if (!comp) return [];
    const venueId = comp.venueId ?? project.activeVenueId;
    const out: Array<{ sim: ResolvedSim; frame: number }> = [];
    const walk = (ev: EvaluatedComp) => {
      for (const l of ev.layers) {
        if (l.source.kind === "simulation") out.push({ sim: l.source.sim, frame: l.source.frame });
        else if (l.source.kind === "comp") walk(l.source.comp);
      }
    };
    walk(evaluateComp(project, compId, t, venueId ? { venueId } : {}));
    return out;
  }

  get maxTextureSize(): number {
    return this.gpu.device.limits.maxTextureDimension2D;
  }

  /** Composite one frame at `scale` × composition size. The caller owns the texture (release or cache it). */
  renderContent(project: Project, compId: Id, t: Flicks, scale = 1, quality: "full" | "draft" = "full"): GPUTexture | null {
    const comp = project.compositions[compId];
    if (!comp) return null;
    const venueId = comp.venueId ?? project.activeVenueId;
    const ev = evaluateComp(project, compId, t, venueId ? { venueId } : {});
    const encoder = this.gpu.device.createCommandEncoder();
    const content = this.compositor.render(ev, encoder, scale, quality);
    this.gpu.submit(encoder);
    return content;
  }

  /** Draw a content frame into a canvas texture as the chosen view. */
  present(target: GPUTexture, project: Project, compId: Id, content: GPUTexture, o: PresentOptions): void {
    const { gpu, compositor } = this;
    const comp = project.compositions[compId];
    if (!comp) return;
    const venueId = comp.venueId ?? project.activeVenueId;
    const venue = venueId ? project.venues[venueId] : undefined;
    const encoder = gpu.device.createCommandEncoder();
    if (o.view === "projector" && venue) {
      const pid = o.projectorId ?? venue.projectorOrder[0];
      const projector = pid ? venue.projectors[pid] : undefined;
      if (projector) {
        const out = renderProjectorOutput(gpu, compositor.raster, encoder, content, { width: comp.width, height: comp.height }, projector, {
          format: "rgba8",
          size: { width: target.width, height: target.height },
          keepOff: keepOffPaths(venue),
          ...(o.showGrid ? { showGrid: true } : {}),
        });
        gpu.defer(out);
        gpu.pass(encoder, BLIT, target, [out.createView(), gpu.samplerLinear]);
      } else {
        gpu.pass(encoder, BLIT, target, [this.greyTexture().createView(), gpu.samplerLinear]);
      }
    } else if (o.view === "venue") {
      // Simulated view on the house: the photo stands in for surface colour, the content is the light.
      const u = new Float32Array([o.ambient ?? 0.08, 1.4, o.reference ? 1 : 0, 0]);
      gpu.pass(encoder, BUILDING_PREVIEW, target, [content.createView(), (o.reference ?? this.greyTexture()).createView(), gpu.samplerLinear, { buffer: gpu.uniform(u) }]);
    } else if (o.view === "3d" && o.time !== undefined && this.scenesAt(project, compId, o.time).length) {
      // A scene with 3D objects: inspect the 3D scene itself from the orbiting camera.
      const src = this.scenesAt(project, compId, o.time)[0]!;
      const r = this.scenes.renderInspection(src, o.orbit ?? { yaw: -18, pitch: 8, distance: 1.55, panX: 0, panY: 0 }, target.width, target.height);
      const u = new ArrayBuffer(32);
      new Float32Array(u, 0, 4).set([0.004, 0.005, 0.008, 1]);
      new Uint32Array(u, 16, 2).set([0, 1]);
      gpu.pass(encoder, ENCODE, target, [(r?.texture ?? this.greyTexture()).createView(), gpu.samplerLinear, { buffer: gpu.uniform(u) }]);
    } else if (o.view === "3d") {
      this.venue3d ??= new VenuePreview3D(gpu, target.format);
      this.venue3d.draw(encoder, target, content, o.reference ?? this.greyTexture(), venue?.canvas ?? { width: comp.width, height: comp.height }, o.orbit ?? { yaw: -18, pitch: 8, distance: 1.55, panX: 0, panY: 0 }, {
        ...(o.ambient !== undefined ? { ambient: o.ambient } : {}),
        showProjector: !!venue && venue.projectorOrder.length > 0,
      });
    } else {
      const bg = comp.background;
      const u = new ArrayBuffer(32);
      new Float32Array(u, 0, 4).set([srgbToLinear(bg[0]), srgbToLinear(bg[1]), srgbToLinear(bg[2]), 1]);
      new Uint32Array(u, 16, 2).set([0, 1]);
      gpu.pass(encoder, ENCODE, target, [content.createView(), gpu.samplerLinear, { buffer: gpu.uniform(u) }]);
    }
    gpu.submit(encoder);
  }

  private greyTexture(): GPUTexture {
    if (!this.grey) {
      this.grey = this.gpu.device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      this.gpu.device.queue.writeTexture({ texture: this.grey }, new Uint8Array([150, 150, 150, 255]), { bytesPerRow: 4 }, [1, 1]);
    }
    return this.grey;
  }

  /** Render a composition and the chosen output stage at full size and quality. */
  private renderTarget(project: Project, compId: Id, t: Flicks, target: FrameTarget, format: PixelFormat): { tex: GPUTexture; encoder: GPUCommandEncoder } {
    const { gpu, compositor } = this;
    const comp = project.compositions[compId];
    if (!comp) throw new Error(`Scene ${compId} not found`);
    const venueId = target.kind === "projector" ? target.venueId : (comp.venueId ?? project.activeVenueId);
    const ev = evaluateComp(project, compId, t, venueId ? { venueId } : {});
    const encoder = gpu.device.createCommandEncoder();
    const content = compositor.render(ev, encoder, 1, "full");
    let out: GPUTexture;
    if (target.kind === "master") {
      const bg = comp.background;
      out = encodeForFile(gpu, encoder, content, { keepAlpha: target.keepAlpha, background: [srgbToLinear(bg[0]), srgbToLinear(bg[1]), srgbToLinear(bg[2]), 1], format });
    } else {
      const projector = project.venues[target.venueId]?.projectors[target.projectorId];
      if (!projector) throw new Error(`Projector ${target.projectorId} not found`);
      out = renderProjectorOutput(gpu, compositor.raster, encoder, content, { width: comp.width, height: comp.height }, projector, {
        format,
        keepOff: keepOffPaths(project.venues[target.venueId]),
        ...(target.showGrid ? { showGrid: true } : {}),
      });
    }
    gpu.release(content);
    gpu.defer(out);
    return { tex: out, encoder };
  }

  /** Render one exact frame to CPU pixels (for encoders and verification). Always full resolution and quality. */
  async renderPixels(project: Project, compId: Id, t: Flicks, target: FrameTarget, format: PixelFormat = "rgba8"): Promise<PixelFrame> {
    // Exports wait for every image and video frame they need; previews may draw before media loads.
    if (this.mediaPrepare) await this.mediaPrepare(project, compId, t);
    // ...and for every simulation frame, preparing the simulation first if needed.
    for (const { sim, frame } of this.simsAt(project, compId, t)) {
      if (!this.compositor.sims) throw new Error("Simulations can't be rendered here.");
      await this.compositor.sims.ensure(sim, frame);
    }
    // ...and for 3D scenes' building photo and prepared physics motion.
    for (const src of this.scenesAt(project, compId, t)) await this.scenes.prepare(src);
    const { tex, encoder } = this.renderTarget(project, compId, t, target, format);
    if (this.compositor.stats.missingMedia > 0) {
      this.gpu.submit(encoder);
      const m = this.compositor.stats.missing[0];
      const what = m ? `“${project.assets[m.assetId]?.name ?? m.assetId}” (frame ${m.frame + 1})` : "A media file";
      throw new Error(`${what} couldn't be read for this moment of the export. Check that the file still exists (Relink media), then try again.`);
    }
    if (this.compositor.stats.simsPending > 0) {
      this.gpu.submit(encoder);
      throw new Error("A simulation or 3D physics frame wasn't ready. Prepare it again, then retry the export.");
    }
    const keep = this.gpu.device.createTexture({ size: [tex.width, tex.height], format: tex.format, usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
    encoder.copyTextureToTexture({ texture: tex }, { texture: keep }, [tex.width, tex.height]);
    this.gpu.submit(encoder);
    const data = await readback(this.gpu, keep);
    keep.destroy();
    return { width: keep.width, height: keep.height, format, data };
  }

  /** Read back whatever a canvas-sized preview texture shows (for tests and snapshots). */
  async readTexture(tex: GPUTexture): Promise<Uint8Array> {
    return readback(this.gpu, tex);
  }

  /** Upload an image (venue photo, imported still) as a texture. */
  async loadImageTexture(src: Blob | string): Promise<GPUTexture> {
    const blob = typeof src === "string" ? await (await fetch(src)).blob() : src;
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none" });
    const tex = this.gpu.device.createTexture({
      label: "image",
      size: [bmp.width, bmp.height],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.gpu.device.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex }, [bmp.width, bmp.height]);
    bmp.close();
    return tex;
  }

  /**
   * Turn imported pixels (sRGB-encoded, straight alpha: an ImageBitmap or raw RGBA bytes) into a
   * working-space texture (linear, premultiplied). The caller owns the result.
   */
  importPixels(src: ImageBitmap | { data: Uint8Array; width: number; height: number }): GPUTexture {
    const { gpu } = this;
    const w = src.width;
    const h = src.height;
    const raw = gpu.device.createTexture({ size: [w, h], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    if ("data" in src) gpu.device.queue.writeTexture({ texture: raw }, src.data as Uint8Array<ArrayBuffer>, { bytesPerRow: w * 4 }, [w, h]);
    else gpu.device.queue.copyExternalImageToTexture({ source: src }, { texture: raw }, [w, h]);
    const out = gpu.device.createTexture({ label: "media", size: [w, h], format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const enc = gpu.device.createCommandEncoder();
    gpu.pass(enc, IMPORT_PIXELS, out, [raw.createView(), gpu.samplerNearest]);
    gpu.defer(raw);
    gpu.submit(enc);
    return out;
  }

  /** Configure a canvas for preview with the platform's preferred format. */
  configureCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): GPUCanvasContext {
    const ctx = canvas.getContext("webgpu") as GPUCanvasContext;
    ctx.configure({ device: this.gpu.device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST });
    return ctx;
  }
}
