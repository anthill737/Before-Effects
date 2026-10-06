/**
 * Supplies imported images and video frames to the renderer.
 *
 *   Images      decoded once into working-space textures.
 *   Video       frames decoded by FFmpeg in the desktop process at the size the preview needs
 *               (lighter "proxy" sizes while previewing), cached on the GPU and prefetched ahead.
 *               How much graphics memory they may use is a preview setting ("Video frames").
 *   Exports     call prepare() before each frame. It waits for full-size frames, so the preview
 *               size never lowers export quality. Preparing preview frames at a smaller size waits
 *               for frames at that size (decoding, moving and uploading a full-size frame for a
 *               Quarter preview was most of the time spent on video), and starts the next few.
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

  /**
   * Decode width: the video's own width or a half, quarter or eighth of it — the smallest that's at
   * least as wide as it's drawn. Few sizes means few decoding streams per video (every window and
   * preview size shares them) and frames that serve every size at or below theirs.
   */
  private decodeWidth(srcW: number, maxWidth: number): number {
    if (!usePreview.getState().useProxies) return srcW;
    const need = Math.max(64, maxWidth);
    let w = srcW;
    for (let k = 0; k < 3 && Math.round(w / 2) >= need; k++) w = Math.round(w / 2);
    return w;
  }

  /**
   * Frames to have decoding ahead of `frame`: the next few, and for a clip that starts over, round
   * to its start (a new stream has to start there, so it's asked for well before it's needed).
   */
  private ahead(assetId: string, frame: number, loop: boolean | undefined, n: number): number[] {
    const count = this.project?.assets[assetId]?.meta.frameCount ?? 0;
    const out: number[] = [];
    const reach = loop && count && frame + n >= count ? n + 8 : n;
    for (let k = 1; k <= reach; k++) {
      const f = frame + k;
      if (count && f >= count) {
        if (!loop) break;
        out.push(f % count);
      } else out.push(f);
    }
    return out;
  }

  /**
   * The compositor asks with maxWidth = the pixels it will draw; reduced previews get lighter proxy
   * sizes. Exports prepare full-size frames first, and those serve every request for that frame.
   */
  footage(assetId: string, frame: number, still: boolean, maxWidth: number, loop?: boolean): GPUTexture | null {
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
    // A frame decoded at least this wide (exports prepare full size) serves the request.
    const e = this.decoded(assetId, frame, w);
    // Not decoded yet: the renderer marks the frame incomplete (never cached) and redraws when it arrives.
    // Ask for this frame before the ones ahead, so the decoder reads them in order.
    if (!e) void this.loadFrame(assetId, frame, w, true, loop);
    else this.markCurrent(assetId, frame);
    // Keep a few frames ahead decoding so playback stays smooth.
    for (const f of this.ahead(assetId, frame, loop, 3)) void this.loadFrame(assetId, f, w, false, loop);
    if (e) {
      e.used = ++this.tick;
      return e.tex;
    }
    return null;
  }

  /**
   * The nearest ready frame of a video while `frame` is still decoding: held from just before (up to
   * two seconds back), else just after; the widest one decoded, so it looks right at any size.
   */
  standIn(assetId: string, frame: number, maxWidth: number): GPUTexture | null {
    void maxWidth;
    const pick = (f: number): Entry | undefined => {
      let best: Entry | undefined;
      for (const w of this.widths.get(`${assetId}|${f}`) ?? []) {
        const e = this.frames.get(`${assetId}|${f}|${w}`);
        if (e && (!best || e.tex.width > best.tex.width)) best = e;
      }
      return best;
    };
    for (let k = 1; k <= 60; k++) {
      const e = pick(frame - k) ?? (k <= 8 ? pick(frame + k) : undefined);
      if (e) {
        e.used = ++this.tick;
        return e.tex;
      }
    }
    // A clip that has just started over: its last frames.
    const count = this.project?.assets[assetId]?.meta.frameCount ?? 0;
    if (count && frame < 8) {
      for (let f = count - 1; f >= count - 8; f--) {
        const e = pick(f);
        if (e) return e.tex;
      }
    }
    return null;
  }

  /** A decoded video frame at least `width` wide (the smallest such), or undefined. */
  private decoded(assetId: string, frame: number, width: number): Entry | undefined {
    const exact = this.frames.get(`${assetId}|${frame}|${width}`);
    if (exact) return exact;
    let best: Entry | undefined;
    for (const w of this.widths.get(`${assetId}|${frame}`) ?? []) {
      if (w < width) continue;
      const e = this.frames.get(`${assetId}|${frame}|${w}`);
      if (e && (!best || e.tex.width < best.tex.width)) best = e;
    }
    return best;
  }
  /** Widths each video frame is decoded at (asset|frame → widths). */
  private widths = new Map<string, Set<number>>();

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
      const i = k.lastIndexOf("|");
      const ws = this.widths.get(k.slice(0, i));
      ws?.delete(Number(k.slice(i + 1)));
      if (ws && !ws.size) this.widths.delete(k.slice(0, i));
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

  /**
   * Ask for a video frame. Requests wait in a small queue per video and size: a few are being decoded
   * at a time, in order, and frames the playhead has already passed are dropped instead of decoded —
   * otherwise a window that fell behind kept decoding every frame it once asked for, ever later.
   * `current`: a frame being drawn now (it goes first, and marks where playback is).
   */
  private loadFrame(assetId: string, frame: number, width: number, current = false, loop = false, must = false): Promise<void> {
    const asset = this.project?.assets[assetId];
    if (!asset || frame < 0 || (asset.meta.frameCount && frame >= asset.meta.frameCount)) return Promise.resolve();
    if (current) this.markCurrent(assetId, frame);
    const key = `${assetId}|${frame}|${width}`;
    if (this.frames.has(key)) return Promise.resolve();
    const qk = `${assetId}|${width}`;
    let q = this.queues.get(qk);
    if (!q) {
      q = { assetId, width, waiting: new Map(), inflight: 0, loop, must: new Set() };
      this.queues.set(qk, q);
    }
    // Someone waits for this frame (an export, preparation): it's decoded whatever playback does.
    if (must) q.must.add(frame);
    const p = this.loading.get(key);
    if (p) return p;
    q.loop ||= loop;
    const queue = q;
    const promise = new Promise<void>((resolve) => queue.waiting.set(frame, resolve));
    this.loading.set(key, promise);
    this.pump(qk);
    return promise;
  }

  /** Requests per video and size: frames waiting (with what to call when done) and how many are decoding. */
  private queues = new Map<string, { assetId: string; width: number; waiting: Map<number, () => void>; inflight: number; loop: boolean; must: Set<number> }>();
  /** Frames drawn recently per video (frame, when): where playback is, for every layer using it. */
  private nowAt = new Map<string, Array<{ frame: number; at: number }>>();
  private static readonly INFLIGHT = 3;
  private static readonly RECENT_MS = 500;

  private markCurrent(assetId: string, frame: number) {
    const now = performance.now();
    const list = (this.nowAt.get(assetId) ?? []).filter((e) => now - e.at < MediaHost.RECENT_MS && e.frame !== frame);
    list.push({ frame, at: now });
    this.nowAt.set(assetId, list);
  }

  /**
   * Frames from `cur` on (forward, round the start for a clip that starts over): 0 for `cur` itself,
   * negative for frames just behind, Infinity for frames long passed.
   */
  private forward(frame: number, cur: number, count: number, loop: boolean): number {
    let d = frame - cur;
    if (loop && count) d = ((d % count) + count) % count;
    if (loop && count && d > count - 3) d -= count; // just behind, round the loop
    return d < -2 ? Number.POSITIVE_INFINITY : d;
  }

  private pump(qk: string) {
    const q = this.queues.get(qk);
    if (!q) return;
    const count = this.project?.assets[q.assetId]?.meta.frameCount ?? 0;
    const now = performance.now();
    const recent = (this.nowAt.get(q.assetId) ?? []).filter((e) => now - e.at < MediaHost.RECENT_MS);
    // How far ahead of where playback is (the nearest of the layers using this video); frames every
    // layer has passed are dropped. With nothing playing it now, everything asked for is kept.
    const rank = (f: number) => (recent.length ? Math.min(...recent.map((e) => this.forward(f, e.frame, count, q.loop))) : f);
    for (const [f, done] of [...q.waiting]) {
      if (q.must.has(f) || rank(f) !== Number.POSITIVE_INFINITY) continue;
      q.waiting.delete(f);
      this.loading.delete(`${q.assetId}|${f}|${q.width}`);
      done();
    }
    while (q.inflight < MediaHost.INFLIGHT && q.waiting.size) {
      const f = [...q.waiting.keys()].sort((a, b) => rank(a) - rank(b))[0]!;
      const done = q.waiting.get(f)!;
      q.waiting.delete(f);
      q.inflight++;
      void this.decodeNow(q.assetId, f, q.width).finally(() => {
        q.inflight--;
        q.must.delete(f);
        this.loading.delete(`${q.assetId}|${f}|${q.width}`);
        done();
        this.pump(qk);
      });
    }
  }

  private async decodeNow(assetId: string, frame: number, width: number): Promise<void> {
    const asset = this.project?.assets[assetId];
    if (!asset) return;
    const rate = asset.meta.frameRate ?? { num: 30, den: 1 };
    try {
      const r = await window.be.media.decodeFrame(asset.path, frame, rate.num / rate.den, width, asset.meta.width ?? width, asset.meta.height ?? Math.round((width * 9) / 16));
      if (r) {
        const key = `${assetId}|${frame}|${width}`;
        if (!this.frames.has(key)) {
          this.store(this.frames, key, this.renderer.importPixels(r));
          const wk = `${assetId}|${frame}`;
          const ws = this.widths.get(wk) ?? new Set<number>();
          ws.add(width);
          this.widths.set(wk, ws);
        }
        this.notify();
      }
    } catch (e) {
      window.be.app.log(`media: could not decode frame ${frame} of ${asset.path}: ${String(e)}`);
    }
  }

  /**
   * While playing: start loading what will be needed at `later` but isn't playing now — clips about to
   * begin, and clips about to start over — so their first frames are ready when they're drawn. Clips
   * already playing are left alone (asking their stream for frames ahead of where it's reading would
   * make it skip the frames in between, and start another stream for those).
   */
  lookahead(project: Project, compId: Id, now: Flicks, later: Flicks, scale: number): void {
    this.project = project;
    const comp = project.compositions[compId];
    if (!comp) return;
    const venueId = comp.venueId ?? project.activeVenueId;
    const opts = venueId ? { venueId } : {};
    const playing = new Map<string, number>();
    const collect = (c: EvaluatedComp, into: (assetId: string, frame: number, s: Extract<EvaluatedComp["layers"][number]["source"], { kind: "footage" }>) => void) => {
      for (const l of c.layers) {
        for (const x of l.trackMatte ? [l, l.trackMatte.layer] : [l]) {
          if (x.source.kind === "comp") collect(x.source.comp, into);
          else if (x.source.kind === "footage" && !x.source.still) into(x.source.assetId, x.source.frame, x.source);
        }
      }
    };
    collect(evaluateComp(project, compId, now, opts), (id, f) => playing.set(id, Math.max(playing.get(id) ?? -1, f)));
    collect(evaluateComp(project, compId, later, opts), (id, f, s) => {
      const at = playing.get(id);
      // Playing now and still moving forward: its stream is already reading towards it.
      if (at !== undefined && f >= at) return;
      const asset = project.assets[id];
      if (!asset) return;
      const w = this.decodeWidth(asset.meta.width ?? 1920, Math.ceil(s.width * scale));
      for (const g of [f, ...this.ahead(id, f, s.loop, 3)]) void this.loadFrame(id, g, w, false, s.loop);
    });
  }

  /**
   * Wait until every image and video frame needed at time t is loaded: at full size for exports
   * (`scale` 1), at the size it's drawn at for a smaller preview. The next few frames start decoding
   * meanwhile, so preparing frame after frame doesn't wait on each one in turn.
   */
  async prepare(project: Project, compId: Id, t: Flicks, scale = 1): Promise<void> {
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
            const srcW = asset.meta.width ?? 1920;
            // The width the compositor will ask for (the layer's pixels at this size); full size for exports.
            const w = scale >= 1 ? srcW : this.decodeWidth(srcW, Math.ceil(s.width * scale));
            if (!this.decoded(s.assetId, s.frame, w)) waits.push(this.loadFrame(s.assetId, s.frame, w, true, s.loop, true));
            else this.markCurrent(s.assetId, s.frame);
            for (const f of this.ahead(s.assetId, s.frame, s.loop, 4)) void this.loadFrame(s.assetId, f, w, false, s.loop);
          }
        }
      }
    };
    walk(ev);
    await Promise.all(waits);
  }
}
