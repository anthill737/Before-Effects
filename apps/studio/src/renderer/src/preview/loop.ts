/**
 * The preview render loop, shared by the editor, the pop-out preview and projector output windows.
 *
 * Every animation frame it:
 *   1. advances the playback clock (real time, honouring loop and the preview range),
 *   2. in cache-first mode, prepares uncached frames of the range before playing,
 *   3. takes the composited frame from the cache, reads it from disk, or renders it (and caches it),
 *   4. presents the chosen view into the canvas,
 *   5. measures GPU time for Auto resolution and reports fps, dropped frames and cache progress.
 *
 * With frames kept on disk (diskCache.ts, a preview setting), frames missing from graphics memory
 * are read back instead of rendered: while preparing, while playing (read ahead) and when stepping.
 * Projector output windows always render.
 */
import { type Affected, type Flicks, frameToTime, type Project, rateToFps, timeToFrame } from "@be/core";
import type { FrameRenderer, PreviewView } from "@be/engine";
import { create } from "zustand";
import { FrameCache } from "./cache.ts";
import { DiskFrames } from "./diskCache.ts";
import { effectiveFraction, type RenderSize, renderSize, usePreview } from "./settings.ts";
import { currentProjector, useProjectorPick } from "../studio/projectors.ts";

export interface PreviewSource {
  project(): Project | null;
  compId(): string | null;
  /** Current time and whether playing. */
  time(): Flicks;
  playing(): boolean;
  /** Called by the loop while playing; the source owns the clock. */
  setTime(t: Flicks): void;
  range(): { start: Flicks; end: Flicks } | null;
  loop(): boolean;
  setPlaying(p: boolean): void;
  /** False while showing a temporary hover preview: frames are drawn but never cached. */
  cacheable?(): boolean;
  /** Master clock while sound is playing (picture follows sound); null when silent. */
  clock?(): Flicks | null;
}

export interface PreviewStats {
  targetFps: number;
  achievedFps: number;
  dropped: number;
  gpuMs: number;
  size: RenderSize | null;
  fraction: number;
  cacheFrames: number;
  cacheMB: number;
  cacheBudgetMB: number;
  preparing: { done: number; total: number } | null;
  mode: "playing" | "paused" | "preparing";
  stale: boolean;
  everyFrame: boolean;
}

export const usePreviewStats = create<PreviewStats>(() => ({
  targetFps: 30,
  achievedFps: 0,
  dropped: 0,
  gpuMs: 0,
  size: null,
  fraction: 1,
  cacheFrames: 0,
  cacheMB: 0,
  cacheBudgetMB: 1536,
  preparing: null,
  mode: "paused",
  stale: false,
  everyFrame: false,
}));

/** While a frame needed now is being read from disk, the previous picture stays up to this long; then it's rendered. */
const DISK_WAIT_MS = 250;

export class PreviewLoop {
  readonly cache: FrameCache;
  readonly disk: DiskFrames;
  private ctx: GPUCanvasContext | null = null;
  private raf = 0;
  private lastTick = performance.now();
  /** When each distinct composition frame was first shown (redraws of the same frame don't count). */
  private presented: number[] = [];
  private lastPresentedFrame = -1;
  private dropped = 0;
  private slow = 0;
  private fast = 0;
  private gpuPending = false;
  private gpuMs = 0;
  private lastKey = "";
  private dirty = true;
  /** Bumped whenever the project changes, so a paused frame redraws after edits. */
  private version = 0;
  reference: GPUTexture | null = null;
  /** Fixed view/size for projector output windows (no UI settings apply). */
  fixed: { view: PreviewView; projectorId?: string; fraction: number } | null = null;
  onFrame: ((frame: number) => void) | null = null;

  constructor(
    private readonly renderer: FrameRenderer,
    private readonly canvas: HTMLCanvasElement,
    private readonly source: PreviewSource,
    private readonly viewport: () => { width: number; height: number },
  ) {
    this.cache = new FrameCache(usePreview.getState().cacheBudgetMB * 1024 * 1024);
    this.disk = new DiskFrames(renderer, this.cache, () => ((this.source.cacheable?.() ?? true) ? this.source.project() : null));
    this.ctx = renderer.configureCanvas(canvas);
  }

  start(): void {
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick);
      try {
        this.tick(now);
      } catch (e) {
        console.error("[preview] frame failed", e);
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.disk.dispose();
    this.cache.clear();
  }

  /** Request a redraw (after edits or setting changes). */
  invalidateView(): void {
    this.dirty = true;
  }

  invalidate(compId: string, affected: Affected): void {
    const p = this.source.project();
    const comp = p?.compositions[compId];
    this.version++;
    this.dirty = true;
    if (comp) this.cache.invalidate(compId, affected, comp.frameRate);
    this.disk.changed(p, compId, affected, comp?.frameRate ?? null);
  }

  private outputSize(project: Project, compId: string, view: PreviewView): { w: number; h: number } {
    const comp = project.compositions[compId]!;
    if (view === "projector") {
      const venue = project.venues[comp.venueId ?? project.activeVenueId ?? ""];
      const pid = this.fixed?.projectorId ?? currentProjector(venue)?.id;
      const pr = pid ? venue?.projectors[pid] : undefined;
      if (pr) return { w: pr.output.width, h: pr.output.height };
    }
    if (view === "3d") {
      const vp = this.viewport();
      const dpr = window.devicePixelRatio || 1;
      return { w: Math.max(2, Math.round(vp.width * dpr)), h: Math.max(2, Math.round(vp.height * dpr)) };
    }
    return { w: comp.width, h: comp.height };
  }

  private tick(now: number) {
    const s = usePreview.getState();
    const project = this.source.project();
    const compId = this.source.compId();
    const comp = project && compId ? project.compositions[compId] : undefined;
    if (!project || !compId || !comp || !this.ctx) return;
    const fps = rateToFps(comp.frameRate);
    const view: PreviewView = this.fixed?.view ?? s.view;
    const playing = this.source.playing();
    const range = this.source.range() ?? { start: 0, end: comp.duration };
    const quality = this.fixed ? "full" : s.effectQuality;
    const cacheable = this.source.cacheable?.() ?? true;
    // Frames on disk: previews only (projector outputs always render), never temporary hover previews.
    const useDisk = !this.fixed && cacheable && this.disk.enabled;

    // Auto: adaptive while playing, full quality when paused (accurate stills and stepping).
    let fraction = this.fixed?.fraction ?? effectiveFraction(s);
    if (!this.fixed && s.resolution === "auto" && !playing) fraction = 1;

    // ---- clock -------------------------------------------------------------------------
    const dt = now - this.lastTick;
    this.lastTick = now;
    let t = this.source.time();
    const frameDur = frameToTime(1, comp.frameRate);
    let mode: PreviewStats["mode"] = playing ? "playing" : "paused";
    let preparing: PreviewStats["preparing"] = null;

    if (playing && !this.fixed && s.playbackMode === "cache") {
      // Prepare the whole range first, then play smoothly from the cache.
      const f0 = timeToFrame(range.start, comp.frameRate);
      const f1 = Math.max(f0 + 1, timeToFrame(range.end - 1, comp.frameRate) + 1);
      const missing: number[] = [];
      for (let f = f0; f < f1; f++) if (!this.cache.has(compId, f, fraction, quality)) missing.push(f);
      if (missing.length) {
        mode = "preparing";
        const budget = performance.now() + 24;
        let fromDisk = 0;
        while (missing.length && performance.now() < budget) {
          const f = missing.shift()!;
          // Frames saved on disk are read back in the background instead of being rendered again.
          if (useDisk && this.disk.fetch(project, compId, f, fraction, quality) !== "absent") {
            fromDisk++;
            continue;
          }
          const tex = this.renderer.renderContent(project, compId, frameToTime(f, comp.frameRate), fraction, quality);
          if (!tex) continue;
          const content = this.renderer.gpu.detach(tex);
          // Frames whose media is still loading are never cached; they're prepared again later.
          if (this.renderer.lastFrameIncomplete || !this.cache.put(compId, f, fraction, quality, content)) this.renderer.gpu.defer(content);
          else if (useDisk) this.disk.offer(project, compId, f, fraction, quality, content);
        }
        preparing = { done: f1 - f0 - missing.length - fromDisk, total: f1 - f0 };
        if (this.cache.stats().bytes >= this.cache.stats().budget * 0.89 && (missing.length || fromDisk)) {
          // The range doesn't fit in the cache budget; play what fits in real time.
          preparing = null;
          mode = "playing";
        }
      }
    }

    if (mode === "playing") {
      const before = timeToFrame(t, comp.frameRate);
      const audioT = this.source.clock?.() ?? null;
      if (audioT !== null) t = audioT;
      else {
        const step = this.fixed || s.frameSkipping ? Math.round((dt / 1000) * 705_600_000) : frameDur;
        t += Math.min(step, frameDur * 10);
      }
      if (t >= range.end) {
        if (this.source.loop()) t = range.start + ((t - range.start) % Math.max(1, range.end - range.start));
        else {
          t = range.end - 1;
          this.source.setPlaying(false);
        }
      }
      this.source.setTime(t);
      const after = timeToFrame(t, comp.frameRate);
      const advanced = after >= before ? after - before : after - timeToFrame(range.start, comp.frameRate) + 1;
      if (advanced > 1) this.dropped += advanced - 1;
    }

    // ---- frame -------------------------------------------------------------------------
    const frame = timeToFrame(t, comp.frameRate);
    const out = this.outputSize(project, compId, view);
    const size = renderSize(out.w, out.h, fraction, this.renderer.maxTextureSize);
    if (this.canvas.width !== size.width || this.canvas.height !== size.height) {
      this.canvas.width = size.width;
      this.canvas.height = size.height;
      this.dirty = true;
    }
    const key = `${frame}|${fraction}|${quality}|${view}|${JSON.stringify(s.orbit)}|${s.ambient}|${s.overlays.grid}|${this.fixed?.projectorId ?? useProjectorPick.getState().id}|${cacheable}|${this.version}`;
    // Frames that were too busy to save to disk earlier are saved now, one per tick.
    if (useDisk) this.disk.pump();
    // Redraw only when something visible changed: on high-refresh displays the same frame is not redrawn every refresh.
    const needsDraw = this.dirty || key !== this.lastKey;
    if (!needsDraw) {
      this.report(fps, size, fraction, mode, preparing, false);
      return;
    }

    if (useDisk && mode === "playing") this.readAhead(project, compId, frame, fraction, quality, range);
    let content = cacheable ? this.cache.get(compId, frame, fraction, quality) : null;
    // On disk: keep the previous picture until it's read (usually a few hundredths of a second), unless that takes too long.
    if (!content && useDisk && this.disk.fetch(project, compId, frame, fraction, quality, true) === "reading" && this.disk.readingFor(project, compId, frame, fraction, quality) < DISK_WAIT_MS) {
      this.report(fps, size, fraction, mode, preparing, false);
      return;
    }
    if (!content && !cacheable) {
      const tex = this.renderer.renderContent(project, compId, frameToTime(frame, comp.frameRate), fraction, quality);
      if (!tex) return;
      // Temporary preview frame: freed once this frame has been submitted, never cached.
      content = this.renderer.gpu.detach(tex);
      this.renderer.gpu.defer(content);
    } else if (!content) {
      const tex = this.renderer.renderContent(project, compId, frameToTime(frame, comp.frameRate), fraction, quality);
      if (!tex) return;
      content = this.renderer.gpu.detach(tex);
      // Frames still waiting for media, or bigger than the whole cache budget, are drawn once and freed.
      if (this.renderer.lastFrameIncomplete || !this.cache.put(compId, frame, fraction, quality, content)) this.renderer.gpu.defer(content);
      else if (useDisk) this.disk.offer(project, compId, frame, fraction, quality, content);
    }
    const t0 = performance.now();
    this.renderer.present(this.ctx.getCurrentTexture(), project, compId, content, {
      view,
      reference: this.reference,
      orbit: s.orbit,
      ambient: s.ambient,
      showGrid: view === "projector" && s.overlays.grid && !this.fixed,
      time: frameToTime(frame, comp.frameRate),
      ...((this.fixed?.projectorId ?? currentProjector(project.venues[comp.venueId ?? project.activeVenueId ?? ""])?.id) ? { projectorId: this.fixed?.projectorId ?? currentProjector(project.venues[comp.venueId ?? project.activeVenueId ?? ""])!.id } : {}),
    });
    if (!this.gpuPending) {
      this.gpuPending = true;
      void this.renderer.gpu.device.queue.onSubmittedWorkDone().then(() => {
        this.gpuMs = performance.now() - t0;
        this.gpuPending = false;
      });
    }
    this.lastKey = key;
    this.dirty = false;
    if (frame !== this.lastPresentedFrame) {
      this.presented.push(now);
      this.lastPresentedFrame = frame;
    }
    this.onFrame?.(frame);

    // ---- Auto resolution ---------------------------------------------------------------------
    if (!this.fixed && s.resolution === "auto" && playing) {
      const budgetMs = 1000 / fps;
      const achieved = this.achieved(now);
      if (achieved < fps * 0.85 || this.gpuMs > budgetMs) this.slow++;
      else this.slow = 0;
      if (this.gpuMs < budgetMs * 0.3 && achieved >= fps * 0.97) this.fast++;
      else this.fast = 0;
      if (this.slow > 20 && s.autoFraction > 1 / 8) {
        usePreview.getState().set({ autoFraction: s.autoFraction / 2 });
        this.slow = 0;
      } else if (this.fast > 90 && s.autoFraction < 1) {
        usePreview.getState().set({ autoFraction: Math.min(1, s.autoFraction * 2) });
        this.fast = 0;
      }
    }
    this.report(fps, size, fraction, mode, preparing, playing && !this.fixed && !s.frameSkipping);
  }

  /** While playing from disk: start reading the next frames (looping round the range), as many as a quarter of the frame cache holds. */
  private readAhead(project: Project, compId: string, frame: number, fraction: number, quality: string, range: { start: Flicks; end: Flicks }) {
    const comp = project.compositions[compId]!;
    const f0 = timeToFrame(range.start, comp.frameRate);
    const f1 = Math.max(f0 + 1, timeToFrame(range.end - 1, comp.frameRate) + 1);
    const frameBytes = Math.max(1, comp.width * fraction * comp.height * fraction * 8);
    const ahead = Math.max(2, Math.min(24, Math.floor((this.cache.stats().budget * 0.25) / frameBytes)));
    for (let k = 1; k <= ahead; k++) {
      let f = frame + k;
      if (f >= f1) {
        if (!this.source.loop()) break;
        f = f0 + ((f - f0) % (f1 - f0));
      }
      if (!this.cache.has(compId, f, fraction, quality) && this.disk.fetch(project, compId, f, fraction, quality) === "wait") break;
    }
  }

  private achieved(now: number): number {
    while (this.presented.length && now - this.presented[0]! > 1000) this.presented.shift();
    return this.presented.length;
  }

  private lastReport = 0;
  private report(fps: number, size: RenderSize, fraction: number, mode: PreviewStats["mode"], preparing: PreviewStats["preparing"], everyFrame: boolean) {
    const now = performance.now();
    if (now - this.lastReport < 250 && mode !== "preparing") return;
    this.lastReport = now;
    const c = this.cache.stats();
    usePreviewStats.setState({
      targetFps: fps,
      achievedFps: mode === "playing" ? this.achieved(now) : 0,
      dropped: this.dropped,
      gpuMs: this.gpuMs,
      size,
      fraction,
      cacheFrames: c.frames,
      cacheMB: Math.round(c.bytes / 1048576),
      cacheBudgetMB: Math.round(c.budget / 1048576),
      preparing,
      mode,
      stale: false,
      everyFrame,
    });
  }

  resetDropped(): void {
    this.dropped = 0;
  }

  /**
   * Render the current view offscreen at the canvas size and measure it (tests and diagnostics).
   * Returns mean brightness and contrast (0–255).
   */
  async sample(): Promise<{ mean: number; spread: number; width: number; height: number; pixels?: Uint8Array }> {
    const s = usePreview.getState();
    const project = this.source.project();
    const compId = this.source.compId();
    const comp = project && compId ? project.compositions[compId] : undefined;
    if (!project || !compId || !comp) return { mean: 0, spread: 0, width: 0, height: 0 };
    const view: PreviewView = this.fixed?.view ?? s.view;
    const fraction = this.fixed?.fraction ?? (s.resolution === "auto" && !this.source.playing() ? 1 : effectiveFraction(s));
    const content = this.renderer.renderContent(project, compId, this.source.time(), fraction, s.effectQuality);
    if (!content) return { mean: 0, spread: 0, width: 0, height: 0 };
    const target = this.renderer.gpu.device.createTexture({
      size: [this.canvas.width, this.canvas.height],
      format: navigator.gpu.getPreferredCanvasFormat(),
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const pid = this.fixed?.projectorId ?? currentProjector(project.venues[comp.venueId ?? project.activeVenueId ?? ""])?.id;
    this.renderer.present(target, project, compId, content, { view, reference: this.reference, orbit: s.orbit, ambient: s.ambient, time: this.source.time(), ...(pid ? { projectorId: pid } : {}) });
    this.renderer.gpu.release(content);
    const px = await this.renderer.readTexture(target);
    target.destroy();
    let sum = 0;
    let sq = 0;
    const n = px.length / 4;
    for (let i = 0; i < px.length; i += 4) {
      const l = 0.2126 * px[i + 2]! + 0.7152 * px[i + 1]! + 0.0722 * px[i]!; // bgra
      sum += l;
      sq += l * l;
    }
    const mean = sum / n;
    return { mean: Math.round(mean), spread: Math.round(Math.sqrt(Math.max(0, sq / n - mean * mean))), width: this.canvas.width, height: this.canvas.height, pixels: px };
  }
}
