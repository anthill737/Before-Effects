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
import { type DiskFrames, diskFramesFor } from "./diskCache.ts";
import { effectiveFraction, type RenderSize, renderSize, usePreview } from "./settings.ts";
import { currentProjector, useProjectorPick } from "../studio/projectors.ts";
import { unshownBetween } from "../../../shared/shownFrames.ts";

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
  /** Sound is being got ready to play: the picture waits for it (so the two start together). */
  soundStarting?(): boolean;
  /** Projector outputs open in other windows have enough frames read ahead to start playing with this one. */
  followersReady?(): boolean;
}

export interface PreviewStats {
  targetFps: number;
  achievedFps: number;
  dropped: number;
  /** Times the picture went back to an earlier frame while playing (not round the loop). */
  stepsBack: number;
  gpuMs: number;
  size: RenderSize | null;
  fraction: number;
  cacheFrames: number;
  cacheMB: number;
  cacheBudgetMB: number;
  preparing: { done: number; total: number } | null;
  mode: "playing" | "paused" | "preparing";
  /** Reading a frame back from disk: recent average (ms). */
  diskReadMs: number;
  /** Playing with sound: how far each new picture is from the sound (ms; positive = picture ahead), on average over the last second, and the largest since playback started. */
  avSyncMs: number | null;
  avSyncMaxMs: number | null;
  stale: boolean;
  everyFrame: boolean;
}

export const usePreviewStats = create<PreviewStats>(() => ({
  targetFps: 30,
  achievedFps: 0,
  dropped: 0,
  stepsBack: 0,
  gpuMs: 0,
  size: null,
  fraction: 1,
  cacheFrames: 0,
  cacheMB: 0,
  cacheBudgetMB: 1536,
  preparing: null,
  mode: "paused",
  diskReadMs: 0,
  avSyncMs: null,
  avSyncMaxMs: null,
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
  /** Picture-to-sound offsets of recent new pictures (when, ms) and the largest since playback started. */
  private sync: Array<[number, number]> = [];
  private syncMax: number | null = null;
  private wasPlaying = false;
  private dropped = 0;
  /** Times the picture went back to an earlier frame while playing (not round the loop): each shows frames again. */
  private stepsBack = 0;
  /**
   * Why frames went unshown while playing (diagnostics): due but not yet read back from disk, and
   * passed over by the clock between two turns to draw (the window wasn't given a turn in time).
   */
  readonly causes = { lateReads: 0, lateTurns: 0, slowTurns: 0, longestTurnMs: 0 };
  /**
   * How smoothly the picture moved in the latest play, as a viewer sees it: the time from one new
   * picture to the next. More than 100 ms (three frames at 30 a second) is a stall, whether or not a
   * frame was skipped — a frame held while it's read, a pause to read ahead, waiting for the sound.
   * `startWaitMs`: from pressing play to the first picture.
   */
  readonly smoothness = { stalls: 0, stalledMs: 0, longestGapMs: 0, startWaitMs: 0, newFrames: 0 };
  private playStartedAt: number | null = null;
  private lastNewFrameAt: number | null = null;
  /** The time this window's clock was at on its last turn while playing. */
  private lastPlayT: number | null = null;
  /** When (ms epoch) its playing clock was last set: the moment the show time it shows is for. */
  clockAt = 0;
  private lateReadFrame = -1;
  /** The last frame shown while playing, since playing started (-1: none yet). */
  private lastPlayedFrame = -1;
  /** Playback went round the loop since the last frame shown: the range's last frame. */
  private wrappedAt: number | null = null;
  /** Playing prepared frames from disk: playback caught up with the reading, so the next second is read in before going on. */
  private buffering = false;
  private bufferingSince = 0;
  /** Its own frames ready to start, waiting for open outputs since then (null: not waiting). */
  private followerWaitSince: number | null = null;
  private lastMode: PreviewStats["mode"] = "paused";
  /** Waiting for open outputs to read ahead too: at most this long (ms), so an output that can't read never stalls playback. */
  private static readonly FOLLOWER_WAIT_MS = 3000;
  /** Recent playback state changes (diagnostics): when (ms), the new state, and why. */
  readonly changes: Array<{ at: number; state: string; ready: number; of: number; followers: boolean }> = [];
  private lastState = "";
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
    this.disk = diskFramesFor(renderer);
    this.ctx = renderer.configureCanvas(canvas);
  }

  start(): void {
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick);
      const t0 = performance.now();
      try {
        this.tick(now);
      } catch (e) {
        console.error("[preview] frame failed", e);
      }
      // Turns that took long themselves (diagnostics): over a frame at 60 Hz.
      if (this.wasPlaying) {
        const ms = performance.now() - t0;
        if (ms > 16) this.causes.slowTurns++;
        this.causes.longestTurnMs = Math.max(this.causes.longestTurnMs, Math.round(ms));
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    // The frames on disk belong to the window (other previews and preparation keep using them).
    this.cache.clear();
  }

  /** The renderer this preview draws with (frame preparation renders with it too). */
  get frameRenderer(): FrameRenderer {
    return this.renderer;
  }

  /** Request a redraw (after edits or setting changes). */
  invalidateView(): void {
    this.dirty = true;
  }

  /**
   * The show changed: drop the frames it affected. `others`: what it did to the other compositions
   * (an edit in a scene also changes the show that plays it); without it they're all dropped.
   */
  invalidate(compId: string, affected: Affected, others?: Readonly<Record<string, Affected>>): void {
    const p = this.source.project();
    const comp = p?.compositions[compId];
    this.version++;
    this.dirty = true;
    if (comp) this.cache.invalidate(compId, affected, comp.frameRate);
    for (const [cid, c] of Object.entries(p?.compositions ?? {})) if (cid !== compId) this.cache.invalidate(cid, others?.[cid] ?? { all: true, ranges: [] }, c.frameRate);
    this.disk.changed(p, compId, affected, comp?.frameRate ?? null, others);
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
    // Frames on disk: never for temporary hover previews. Projector outputs read prepared frames
    // (read-only) and render the rest.
    const useDisk = cacheable && this.disk.enabled && (!this.fixed || this.disk.readOnly);

    // Auto: adaptive while playing, full quality when paused (accurate stills and stepping).
    let fraction = this.fixed?.fraction ?? effectiveFraction(s);
    if (!this.fixed && s.resolution === "auto" && !playing) fraction = 1;
    // Prepared frames are full size. A smaller preview shows them (scaled down) wherever they are, rather
    // than rendering every frame again at its own size: reading a prepared frame is far quicker than
    // rendering one, at any size. Frames not prepared are rendered at the size chosen.
    if (!this.fixed && useDisk && fraction < 1) {
      const at = timeToFrame(this.source.time(), comp.frameRate);
      if (this.cache.has(compId, at, 1, quality) || this.disk.has(project, compId, at, 1, quality)) fraction = 1;
    }

    // ---- clock -------------------------------------------------------------------------
    const dt = now - this.lastTick;
    this.lastTick = now;
    let t = this.source.time();
    const frameDur = frameToTime(1, comp.frameRate);
    let mode: PreviewStats["mode"] = playing ? "playing" : "paused";
    let preparing: PreviewStats["preparing"] = null;

    if (!playing || this.fixed || s.playbackMode !== "cache") this.buffering = false;
    const justStarted = playing && !this.wasPlaying;
    if (justStarted) {
      this.sync = [];
      this.syncMax = null;
      Object.assign(this.smoothness, { stalls: 0, stalledMs: 0, longestGapMs: 0, startWaitMs: 0, newFrames: 0 });
      this.playStartedAt = now;
      this.lastNewFrameAt = null;
      // Counting starts afresh (the frame shown before playing may be from before a seek).
      this.lastPlayedFrame = -1;
    }
    this.wasPlaying = playing;
    if (playing && !this.fixed && s.playbackMode === "cache") {
      // Prepare the whole range first, then play smoothly from the cache. A range longer than
      // graphics memory holds needs only what fits from the playhead on; frames prepared on disk
      // (a prepared scene or show) count as ready and are read ahead while playing.
      const f0 = timeToFrame(range.start, comp.frameRate);
      const f1 = Math.max(f0 + 1, timeToFrame(range.end - 1, comp.frameRate) + 1);
      const n = f1 - f0;
      const frameBytes = Math.max(1, Math.round(comp.width * fraction) * Math.round(comp.height * fraction) * 8);
      const fit = Math.max(1, Math.floor((this.cache.stats().budget * 0.85) / frameBytes));
      const fits = n <= fit;
      const from = fits ? f0 : Math.min(f1 - 1, Math.max(f0, timeToFrame(t, comp.frameRate)));
      const missing: number[] = [];
      const count = Math.min(n, fit);
      // Frames on disk play from graphics memory, like a video player: before playing, and whenever
      // playback catches up with the reading, picture and sound wait while the frames read ahead
      // (three seconds) are read in — rather than skipping frames, or rendering ones already
      // prepared. Filling them while paused also keeps reading to one frame per frame shown once
      // playing (reading many at once then holds up the picture).
      const second = !fits && useDisk ? Math.min(count, Math.max(2, Math.round(fps * 3))) : 0;
      let ready = 0;
      while (ready < second && this.cache.has(compId, f0 + ((from - f0 + ready) % n), fraction, quality)) ready++;
      // Starting, or caught up with the reading: read ahead before going on (on starting, even when
      // the first frames are still in memory from before).
      if (ready < Math.min(second, 2) || (justStarted && ready < second)) {
        if (!this.buffering) this.bufferingSince = performance.now();
        this.buffering = true;
      } else if (ready >= second && (!this.buffering || (this.source.followersReady?.() ?? true) || performance.now() - this.bufferingSince > PreviewLoop.FOLLOWER_WAIT_MS)) this.buffering = false;
      const lead = this.buffering ? second : 0;
      for (let k = 0; k < count; k++) {
        const f = f0 + ((from - f0 + k) % n);
        if (this.cache.has(compId, f, fraction, quality)) continue;
        if (!fits && useDisk && k >= lead && this.disk.has(project, compId, f, fraction, quality)) continue;
        missing.push(f);
      }
      if (missing.length) {
        mode = "preparing";
        const budget = performance.now() + 24;
        let fromDisk = 0;
        while (missing.length && performance.now() < budget) {
          const f = missing.shift()!;
          // Frames saved on disk are read back in the background instead of being rendered again.
          if (useDisk && this.disk.fetch(this.cache, project, compId, f, fraction, quality) !== "absent") {
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
        preparing = this.buffering ? { done: ready, total: second } : { done: count - missing.length - fromDisk, total: count };
        if (!this.buffering && this.cache.stats().bytes >= this.cache.stats().budget * 0.89 && (missing.length || fromDisk)) {
          // The range doesn't fit in the cache budget; play what fits in real time.
          preparing = null;
          mode = "playing";
        }
      }
      // Read ahead but waiting for open outputs to do the same: still held (playing a few frames
      // then holding again would show as stutter, and start the sound twice).
      if (this.buffering && mode === "playing") {
        mode = "preparing";
        preparing = { done: ready, total: second };
      }
      // Starting with its own frames ready (also when they're all in memory): open outputs read a
      // second ahead first (at most FOLLOWER_WAIT_MS), so they start with it instead of catching up.
      if (mode === "playing" && this.lastMode !== "playing" && !(this.source.followersReady?.() ?? true)) {
        this.followerWaitSince ??= performance.now();
        if (performance.now() - this.followerWaitSince < PreviewLoop.FOLLOWER_WAIT_MS) {
          mode = "preparing";
          preparing = { done: count, total: count };
        }
      }
    }
    if (mode === "playing" || !playing) this.followerWaitSince = null;
    this.lastMode = mode;

    if (mode !== "playing") this.lastPlayT = null;
    if (mode === "playing") {
      const before = timeToFrame(this.lastPlayT ?? t, comp.frameRate);
      const audioT = this.source.clock?.() ?? null;
      if (audioT !== null) t = audioT;
      else if (this.source.soundStarting?.()) {
        // The picture waits for its sound to start.
      } else {
        const step = this.fixed || s.frameSkipping ? Math.round((dt / 1000) * 705_600_000) : frameDur;
        t += Math.min(step, frameDur * 10);
      }
      let wrapped = false;
      if (t >= range.end) {
        if (this.source.loop()) {
          t = range.start + ((t - range.start) % Math.max(1, range.end - range.start));
          wrapped = true;
        } else {
          t = range.end - 1;
          this.source.setPlaying(false);
        }
      }
      this.source.setTime(t);
      this.lastPlayT = t;
      this.clockAt = Date.now();
      const advanced = timeToFrame(t, comp.frameRate) - before;
      if (wrapped) this.wrappedAt = timeToFrame(range.end - 1, comp.frameRate);
      // The clock passed over frames between two turns to draw.
      else if (advanced > 1 && advanced < fps * 5) this.causes.lateTurns += advanced - 1;
    }

    // ---- frame -------------------------------------------------------------------------
    const frame = timeToFrame(t, comp.frameRate);
    const state = `${mode}${this.buffering ? " buffering" : ""}${mode === "playing" && this.source.clock?.() == null ? (this.source.soundStarting?.() ? " (sound starting)" : " (no sound clock)") : ""}`;
    if (state !== this.lastState) {
      this.lastState = state;
      this.changes.push({ at: Math.round(now), state, ready: preparing?.done ?? 0, of: preparing?.total ?? 0, followers: this.source.followersReady?.() ?? true });
      if (this.changes.length > 40) this.changes.shift();
    }
    const out = this.outputSize(project, compId, view);
    const size = renderSize(out.w, out.h, fraction, this.renderer.maxTextureSize);
    if (this.canvas.width !== size.width || this.canvas.height !== size.height) {
      this.canvas.width = size.width;
      this.canvas.height = size.height;
      this.dirty = true;
    }
    const key = `${frame}|${fraction}|${quality}|${view}|${JSON.stringify(s.orbit)}|${s.ambient}|${s.overlays.grid}|${this.fixed?.projectorId ?? useProjectorPick.getState().id}|${cacheable}|${this.version}`;
    // Frames that were too busy to save to disk earlier are saved now, one per tick.
    if (useDisk) this.disk.pump(this.cache);
    // Reading ahead goes on while the picture stays on one frame (an output while the editor holds).
    if (useDisk && mode === "playing") this.readAhead(project, compId, frame, fraction, quality, range);
    // Redraw only when something visible changed: on high-refresh displays the same frame is not redrawn every refresh.
    const needsDraw = this.dirty || key !== this.lastKey;
    if (!needsDraw) {
      this.report(fps, size, fraction, mode, preparing, false);
      return;
    }

    let content = cacheable ? this.cache.get(compId, frame, fraction, quality) : null;
    // Playing from disk, a frame shown is behind the playhead: it goes before the frames read ahead.
    if (content && useDisk && mode === "playing" && this.disk.has(project, compId, frame, fraction, quality)) this.cache.demote(compId, frame, fraction, quality);
    // On disk: keep the previous picture until it's read (usually a few hundredths of a second), unless that takes too long
    // (while buffering it's always read: rendering a prepared frame again is slower).
    if (!content && useDisk && this.disk.fetch(this.cache, project, compId, frame, fraction, quality, true) === "reading" && (this.buffering || this.disk.readingFor(project, compId, frame, fraction, quality) < DISK_WAIT_MS)) {
      if (mode === "playing" && frame !== this.lateReadFrame) {
        this.lateReadFrame = frame;
        this.causes.lateReads++;
      }
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
      // Frames never shown: passed over by the clock, or not ready in time (round the loop counts
      // from the last frame of the range; seconds apart is a seek).
      if (mode === "playing") {
        const m = this.smoothness;
        if (this.lastNewFrameAt === null) m.startWaitMs = this.playStartedAt === null ? 0 : Math.round(now - this.playStartedAt);
        else {
          const gap = now - this.lastNewFrameAt;
          m.longestGapMs = Math.max(m.longestGapMs, Math.round(gap));
          if (gap > 100) {
            m.stalls++;
            m.stalledMs += Math.round(gap);
          }
        }
        m.newFrames++;
        this.lastNewFrameAt = now;
        const u = unshownBetween(this.lastPlayedFrame, frame, this.wrappedAt, timeToFrame(range.start, comp.frameRate), fps);
        this.dropped += u.unshown;
        if (u.back) this.stepsBack++;
        this.lastPlayedFrame = frame;
      }
      this.wrappedAt = null;
      this.presented.push(now);
      this.lastPresentedFrame = frame;
      const sound = mode === "playing" ? (this.source.clock?.() ?? null) : null;
      if (sound !== null) {
        const ms = ((frameToTime(frame, comp.frameRate) - sound) / 705_600_000) * 1000;
        this.sync.push([now, ms]);
        this.syncMax = Math.max(this.syncMax ?? 0, Math.abs(ms));
      }
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

  /** Frames in graphics memory one after another from `frame` (up to `max`): how far ahead it can play without reading. */
  readyAhead(compId: string, frame: number, fraction: number, quality: string, max: number): number {
    let n = 0;
    while (n < max && this.cache.has(compId, frame + n, fraction, quality)) n++;
    return n;
  }

  /**
   * While playing from disk: start reading the next frames (looping round the range), up to three
   * seconds or half the frame cache. Playing as it comes (not "prepare first"), frames playback will
   * have passed before a read could finish aren't read.
   */
  private readAhead(project: Project, compId: string, frame: number, fraction: number, quality: string, range: { start: Flicks; end: Flicks }) {
    const comp = project.compositions[compId]!;
    const fps = rateToFps(comp.frameRate);
    const f0 = timeToFrame(range.start, comp.frameRate);
    const f1 = Math.max(f0 + 1, timeToFrame(range.end - 1, comp.frameRate) + 1);
    const frameBytes = Math.max(1, comp.width * fraction * comp.height * fraction * 8);
    const ahead = Math.max(2, Math.min(Math.round(fps * 3), Math.floor((this.cache.stats().budget * 0.5) / frameBytes)));
    const late = usePreview.getState().playbackMode === "cache" ? 1 : Math.max(1, Math.ceil((this.disk.readMs * fps) / 1000));
    for (let k = late; k <= ahead; k++) {
      let f = frame + k;
      if (f >= f1) {
        if (!this.source.loop()) break;
        f = f0 + ((f - f0) % (f1 - f0));
      }
      if (!this.cache.has(compId, f, fraction, quality) && this.disk.fetch(this.cache, project, compId, f, fraction, quality) === "wait") break;
    }
  }

  private syncStats(now: number): { avSyncMs: number | null; avSyncMaxMs: number | null } {
    while (this.sync.length && now - this.sync[0]![0] > 1000) this.sync.shift();
    const avg = this.sync.length ? this.sync.reduce((a, [, ms]) => a + Math.abs(ms), 0) / this.sync.length : null;
    return { avSyncMs: avg === null ? null : Math.round(avg), avSyncMaxMs: this.syncMax === null ? null : Math.round(this.syncMax) };
  }

  private achieved(now: number): number {
    while (this.presented.length && now - this.presented[0]! > 1000) this.presented.shift();
    return this.presented.length;
  }

  private lastReport = 0;
  private report(fps: number, size: RenderSize, fraction: number, mode: PreviewStats["mode"], preparing: PreviewStats["preparing"], everyFrame: boolean) {
    const now = performance.now();
    // At most four times a second, except while preparing and when starting or stopping (the sound starts with the picture).
    if (now - this.lastReport < 250 && mode !== "preparing" && mode === usePreviewStats.getState().mode) return;
    this.lastReport = now;
    const c = this.cache.stats();
    usePreviewStats.setState({
      targetFps: fps,
      achievedFps: mode === "playing" ? this.achieved(now) : 0,
      dropped: this.dropped,
      stepsBack: this.stepsBack,
      gpuMs: this.gpuMs,
      size,
      fraction,
      cacheFrames: c.frames,
      cacheMB: Math.round(c.bytes / 1048576),
      cacheBudgetMB: Math.round(c.budget / 1048576),
      preparing,
      mode,
      diskReadMs: Math.round(this.disk.readMs),
      ...this.syncStats(now),
      stale: false,
      everyFrame,
    });
  }

  resetDropped(): void {
    this.dropped = 0;
    this.stepsBack = 0;
  }

  /**
   * Render the current view offscreen at the canvas size and measure it (tests and diagnostics).
   * Returns mean brightness and contrast (0–255).
   */
  async sample(): Promise<{ mean: number; spread: number; width: number; height: number; pixels?: Uint8Array; incomplete?: boolean }> {
    const s = usePreview.getState();
    const project = this.source.project();
    const compId = this.source.compId();
    const comp = project && compId ? project.compositions[compId] : undefined;
    if (!project || !compId || !comp) return { mean: 0, spread: 0, width: 0, height: 0 };
    const view: PreviewView = this.fixed?.view ?? s.view;
    const fraction = this.fixed?.fraction ?? (s.resolution === "auto" && !this.source.playing() ? 1 : effectiveFraction(s));
    const content = this.renderer.renderContent(project, compId, this.source.time(), fraction, s.effectQuality);
    // Whether this render was final, read now: while its pixels are read back, other renders (this
    // window's own preview) change what the renderer reports.
    const incomplete = this.renderer.lastFrameIncomplete;
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
    return { mean: Math.round(mean), spread: Math.round(Math.sqrt(Math.max(0, sq / n - mean * mean))), width: this.canvas.width, height: this.canvas.height, pixels: px, incomplete };
  }
}
