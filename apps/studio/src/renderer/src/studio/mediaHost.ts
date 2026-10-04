/**
 * Supplies imported images and video frames to the renderer.
 *
 *   Images      decoded once into working-space textures.
 *   Video       frames decoded by FFmpeg in the desktop process at the size the preview needs
 *               (lighter "proxy" sizes while previewing), cached on the GPU and prefetched ahead.
 *               How much graphics memory they may use is a preview setting ("Video frames").
 *   Exports     call prepare() before each frame. It waits for full-size frames, so the preview
 *               size never lowers export quality.
 */
import { evaluateComp, type EvaluatedComp, type Flicks, type Id, type Project } from "@be/core";
import type { FrameRenderer, MediaProvider } from "@be/engine";
import { MIN_MEMORY_MB, usePreview } from "../preview/settings.ts";

interface Entry {
  tex: GPUTexture;
  bytes: number;
  used: number;
}

const budget = () => Math.max(MIN_MEMORY_MB, usePreview.getState().videoCacheMB) * 1024 * 1024;

export class MediaHost implements MediaProvider {
  project: Project | null = null;
  private images = new Map<string, Entry>();
  private frames = new Map<string, Entry>();
  private loading = new Map<string, Promise<void>>();
  private failed = new Set<string>();
  private bytes = 0;
  private tick = 0;
  private listeners = new Set<() => void>();

  constructor(private readonly renderer: FrameRenderer) {
    // A smaller amount applies right away.
    usePreview.subscribe((s, prev) => {
      if (s.videoCacheMB < prev.videoCacheMB) this.trim();
    });
  }

  /** Graphics memory for pictures and decoded video frames, against the video cache amount. */
  memoryReport(): { images: number; videoFrames: number; bytes: number; budget: number } {
    return { images: this.images.size, videoFrames: this.frames.size, bytes: this.bytes, budget: budget() };
  }

  /** Diagnostics: what's loaded, loading and failed. */
  stats(): { images: number; frames: number; loading: number; failed: string[]; keys: string[] } {
    return { images: this.images.size, frames: this.frames.size, loading: this.loading.size, failed: [...this.failed], keys: [...this.frames.keys()].slice(0, 6) };
  }

  onLoaded(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  /** Decode width: the requested size rounded up (lighter proxies), or full size when proxies are off. */
  private decodeWidth(srcW: number, maxWidth: number): number {
    if (!usePreview.getState().useProxies) return srcW;
    const w = Math.ceil(Math.max(64, maxWidth) / 64) * 64;
    return Math.min(srcW, w);
  }

  /**
   * The compositor asks with maxWidth = the pixels it will draw; reduced previews get lighter proxy
   * sizes. Exports prepare full-size frames first, and those serve every request for that frame.
   */
  footage(assetId: string, frame: number, still: boolean, maxWidth: number): GPUTexture | null {
    const asset = this.project?.assets[assetId];
    if (!asset || this.failed.has(assetId)) return null;
    if (still) {
      const e = this.images.get(assetId);
      if (e) {
        e.used = ++this.tick;
        return e.tex;
      }
      void this.loadImage(assetId, asset.path);
      return null;
    }
    const srcW = asset.meta.width ?? 1920;
    const w = this.decodeWidth(srcW, maxWidth);
    const key = `${assetId}|${frame}|${w}`;
    // A full-size frame (what exports prepare) serves any smaller request, e.g. video drawn into a small area.
    const e = this.frames.get(key) ?? this.frames.get(`${assetId}|${frame}|${srcW}`);
    // Not decoded yet: the renderer marks the frame incomplete (never cached) and redraws when it arrives.
    // Ask for this frame before the ones ahead, so the decoder reads them in order.
    if (!e) void this.loadFrame(assetId, frame, w);
    // Keep a few frames ahead decoding so playback stays smooth.
    for (let k = 1; k <= 3; k++) void this.loadFrame(assetId, frame + k, w);
    if (e) {
      e.used = ++this.tick;
      return e.tex;
    }
    return null;
  }

  private store(map: Map<string, Entry>, key: string, tex: GPUTexture) {
    const bytes = tex.width * tex.height * 8;
    map.set(key, { tex, bytes, used: ++this.tick });
    this.bytes += bytes;
    this.trim();
  }

  /** Over the budget: drop the least recently used video frames (images stay). */
  private trim() {
    const limit = budget();
    if (this.bytes <= limit) return;
    const all = [...this.frames.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [k, ent] of all) {
      if (this.bytes <= limit * 0.85) break;
      this.renderer.gpu.defer(ent.tex);
      this.frames.delete(k);
      this.bytes -= ent.bytes;
    }
  }

  private loadImage(assetId: string, path: string): Promise<void> {
    const key = `img:${assetId}`;
    let p = this.loading.get(key);
    if (p) return p;
    p = (async () => {
      try {
        const bytes = await window.be.files.readFile(path);
        const bmp = await createImageBitmap(new Blob([bytes as BlobPart]), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
        this.store(this.images, assetId, this.renderer.importPixels(bmp));
        bmp.close();
        this.notify();
      } catch (e) {
        this.failed.add(assetId);
        window.be.app.log(`media: could not load image ${path}: ${String(e)}`);
        this.notify();
      } finally {
        this.loading.delete(key);
      }
    })();
    this.loading.set(key, p);
    return p;
  }

  private loadFrame(assetId: string, frame: number, width: number): Promise<void> {
    const asset = this.project?.assets[assetId];
    if (!asset || frame < 0 || (asset.meta.frameCount && frame >= asset.meta.frameCount)) return Promise.resolve();
    const key = `${assetId}|${frame}|${width}`;
    if (this.frames.has(key)) return Promise.resolve();
    let p = this.loading.get(key);
    if (p) return p;
    const rate = asset.meta.frameRate ?? { num: 30, den: 1 };
    p = (async () => {
      try {
        const r = await window.be.media.decodeFrame(asset.path, frame, rate.num / rate.den, width, asset.meta.width ?? width, asset.meta.height ?? Math.round((width * 9) / 16));
        if (r) {
          this.store(this.frames, key, this.renderer.importPixels(r));
          this.notify();
        }
      } catch (e) {
        window.be.app.log(`media: could not decode frame ${frame} of ${asset.path}: ${String(e)}`);
      } finally {
        this.loading.delete(key);
      }
    })();
    this.loading.set(key, p);
    return p;
  }

  /** Wait until every image and video frame needed at time t is loaded at full size (exports). */
  async prepare(project: Project, compId: Id, t: Flicks): Promise<void> {
    this.project = project;
    const comp = project.compositions[compId];
    if (!comp) return;
    const venueId = comp.venueId ?? project.activeVenueId;
    const ev = evaluateComp(project, compId, t, venueId ? { venueId } : {});
    const waits: Array<Promise<void>> = [];
    const walk = (c: EvaluatedComp) => {
      for (const l of c.layers) {
        const layers = l.trackMatte ? [l, l.trackMatte.layer] : [l];
        for (const x of layers) {
          const s = x.source;
          if (s.kind === "comp") walk(s.comp);
          if (s.kind !== "footage") continue;
          const asset = project.assets[s.assetId];
          if (!asset) continue;
          if (s.still) {
            if (!this.images.has(s.assetId)) waits.push(this.loadImage(s.assetId, asset.path));
          } else {
            waits.push(this.loadFrame(s.assetId, s.frame, asset.meta.width ?? 1920));
          }
        }
      }
    };
    walk(ev);
    await Promise.all(waits);
  }
}
