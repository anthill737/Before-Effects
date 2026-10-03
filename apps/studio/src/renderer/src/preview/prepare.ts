/**
 * Preparing a whole scene or the whole show for smooth playback: every frame is rendered once at a
 * preview size and kept in the preview's disk cache, so it plays smoothly (also after restarting),
 * and an edit re-prepares only the frames it changes.
 *
 * Built to finish:
 *   - simulations and 3D physics are prepared first, then each frame waits for its images, video
 *     frames, simulation frames and 3D scenes the way exports do, so no frame is saved half-loaded;
 *   - frames already on disk are skipped, so it resumes after a pause, an edit or a restart;
 *   - saving keeps pace with rendering (it waits for a free slot instead of piling frames up);
 *   - the disk space is checked before starting and again once real frame sizes are known; it stops
 *     with the reason and what to change, rather than letting the disk cache delete frames it just
 *     made, and stops when the drive is nearly full;
 *   - after the last frame it checks every frame is on disk and goes round again for any an edit
 *     removed meanwhile (a few rounds at most);
 *   - the editor stays responsive: it works in short slices, shorter while the preview plays.
 *
 * One job at a time per editor window. Exports never use these frames: they always render afresh.
 */
import { frameToTime, type Project, timeToFrame } from "@be/core";
import { create } from "zustand";
import { DEFAULT_DISK_BYTES_PER_PIXEL, footageCost, PLAN_FRACTION, type PlanResolution } from "../../../shared/cachePlan.ts";
import { formatSize } from "../../../shared/diskFrames.ts";
import { getRenderer } from "../studio/engineHost.ts";
import { useSims } from "../studio/simHost.ts";
import { useStudio } from "../studio/store.ts";
import { type DiskFrames, diskFramesFor, saveTiming } from "./diskCache.ts";
import { usePreview } from "./settings.ts";

const GB = 1024 ** 3;
/** Rounds of checking after the last frame (edits during preparation remove frames). */
const MAX_ROUNDS = 4;
/** A frame whose media never loads is given up after this many tries (and reported). */
const MAX_TRIES = 4;
/** Measured size of a show's prepared frames on disk (bytes per pixel), for estimates and recommendations. */
const bppKey = (projectId: string) => `be.prepare.bytesPerPixel.${projectId}`;

export type PrepareTarget = "scene" | "show";
export type PrepareState = "waiting" | "preparing" | "checking" | "paused" | "done" | "stopped" | "failed";

export interface PrepareJob {
  readonly target: PrepareTarget;
  readonly compId: string;
  readonly name: string;
  readonly resolution: PlanResolution;
  readonly quality: "full" | "draft";
  state: PrepareState;
  /** Frames on disk at this size (of `total`). */
  done: number;
  readonly total: number;
  /** Rendered by this job (the rest were already on disk). */
  rendered: number;
  /** Frames that couldn't be prepared (their media never loaded, or they couldn't be saved). */
  failedFrames: number;
  /** Rendering speed (frames a second) and time left, while preparing. */
  fps: number;
  etaSeconds: number | null;
  /** What it's doing now, in words (waiting for simulations, checking, …). */
  phase: string;
  /** Why it stopped or failed, and what to do. */
  reason?: string;
  /** Estimated disk space for every frame. */
  diskBytes: number;
  /** Where a frame's time goes, on average (milliseconds): waiting for its media and simulations, drawing it, waiting to save. */
  timing?: { prepareMs: number; renderMs: number; saveWaitMs: number; gpuMs: number; compressMs: number; writeMs: number };
  readonly startedAt: number;
  finishedAt?: number;
}

export const usePrepare = create<{ job: PrepareJob | null }>(() => ({ job: null }));

/** Measured bytes per pixel of this show's prepared frames (undefined until some have been made: use a typical value). */
export const measuredBytesPerPixel = (projectId = useStudio.getState().project?.id): number | undefined => {
  if (!projectId) return undefined;
  try {
    const v = Number(localStorage.getItem(bppKey(projectId)));
    return Number.isFinite(v) && v > 0.02 && v < 4 ? v : undefined;
  } catch {
    return undefined;
  }
};

const resolutionOf = (fraction: number): PlanResolution => (fraction > 0.75 ? "full" : fraction > 0.375 ? "half" : "quarter");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clock = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.round(s / 60)} min` : `${Math.max(1, Math.round(s))} s`);

let running: { stop: boolean; pause: boolean } | null = null;

const update = (patch: Partial<PrepareJob>) => {
  const j = usePrepare.getState().job;
  if (j) usePrepare.setState({ job: { ...j, ...patch } });
};

/** The composition a target means: the scene being edited, or the show (every scene in order). */
export const targetComp = (project: Project, target: PrepareTarget, compId?: string | null): { id: string; name: string } | null => {
  if (target === "show") {
    const c = project.compositionOrder.map((id) => project.compositions[id]).find((x) => x?.show);
    return c ? { id: c.id, name: c.name } : null;
  }
  const id = compId ?? useStudio.getState().compId;
  const c = id ? project.compositions[id] : undefined;
  return c ? { id: c.id, name: c.name } : null;
};

export interface PrepareOptions {
  readonly target: PrepareTarget;
  /** A scene other than the one being edited (target "scene"). */
  readonly compId?: string;
  /** Preview size to prepare at (default: the preview's current size; Auto counts as Full). */
  readonly resolution?: PlanResolution;
  /** Raise the disk cache's size when it's too small for every frame and the drive can spare it. */
  readonly raiseDiskLimit?: boolean;
}

/**
 * Start preparing (stopping any job already running). Resolves once it has started or refused to
 * start (see the job's state and reason); progress is in usePrepare.
 */
export const startPreparing = async (opts: PrepareOptions): Promise<PrepareJob> => {
  stopPreparing();
  const project = useStudio.getState().project;
  if (!project) throw new Error("There's no show open.");
  const t = targetComp(project, opts.target, opts.compId);
  if (!t) throw new Error(opts.target === "show" ? "This show has no show sequence yet (make one in the scenes bar)." : "There's no scene to prepare.");
  const comp = project.compositions[t.id]!;
  const s = usePreview.getState();
  const resolution = opts.resolution ?? resolutionOf(s.resolution === "auto" ? 1 : s.resolution === "custom" ? s.customScale : PLAN_FRACTION[s.resolution as PlanResolution] ?? 1);
  const fraction = PLAN_FRACTION[resolution];
  const quality = s.effectQuality;
  const fps = comp.frameRate.num / comp.frameRate.den;
  const seconds = comp.duration / 705_600_000;
  const cost = footageCost({ name: t.name, width: comp.width, height: comp.height, fps, seconds }, resolution, measuredBytesPerPixel() ?? DEFAULT_DISK_BYTES_PER_PIXEL);
  const total = Math.max(1, timeToFrame(comp.duration - 1, comp.frameRate) + 1);
  const diskBytes = Math.round(total * cost.diskFrameBytes);
  const job: PrepareJob = { target: opts.target, compId: t.id, name: t.name, resolution, quality, state: "waiting", done: 0, total, rendered: 0, failedFrames: 0, fps: 0, etaSeconds: null, phase: "Starting", diskBytes, startedAt: Date.now() };
  usePrepare.setState({ job });

  // Prepared frames live on disk, and playback uses them at this size from the cache.
  const named = resolution === "full" ? "full" : resolution === "half" ? "half" : "quarter";
  const settings: Parameters<typeof s.set>[0] = { diskCache: true, playbackMode: "cache", resolution: named };
  // Room on disk: the limit must hold every frame, or the cache would delete the first frames to make
  // room for the last ones.
  const space = await window.be.cache.space().catch(() => null);
  const limit = s.diskCacheGB * GB;
  if (diskBytes * 1.05 > limit) {
    const want = Math.ceil((diskBytes * 1.15 + 2 * GB) / GB);
    const spare = space ? space.freeBytes + space.usedBytes - 5 * GB : Number.POSITIVE_INFINITY;
    if (opts.raiseDiskLimit && want * GB <= spare) settings.diskCacheGB = want;
    else {
      update({
        state: "failed",
        phase: "Not started",
        finishedAt: Date.now(),
        reason:
          want * GB > spare
            ? `Every frame of “${t.name}” at ${resolution === "full" ? "Full" : resolution === "half" ? "Half" : "Quarter"} size needs about ${formatSize(diskBytes)} on disk, more than ${space?.drive ?? "the drive"} can spare (${formatSize(space?.freeBytes ?? 0)} free). Prepare at a smaller size, free some space, or choose another folder for preview frames.`
            : `Every frame of “${t.name}” needs about ${formatSize(diskBytes)} on disk, but the disk cache is set to ${formatSize(limit)}. Raise it to ${want} GB (Quality & speed → Disk space), or use the recommended settings.`,
      });
      return usePrepare.getState().job!;
    }
  }
  usePreview.getState().set(settings);
  const ctl = { stop: false, pause: false };
  running = ctl;
  const renderer = await getRenderer();
  void run(renderer, diskFramesFor(renderer), ctl).catch((e) => update({ state: "failed", finishedAt: Date.now(), phase: "Stopped", reason: `Preparation stopped: ${String((e as Error)?.message ?? e)}` }));
  return usePrepare.getState().job!;
};

export const stopPreparing = () => {
  if (running) running.stop = true;
  running = null;
  const j = usePrepare.getState().job;
  if (j && (j.state === "waiting" || j.state === "preparing" || j.state === "checking" || j.state === "paused")) update({ state: "stopped", phase: "Stopped", finishedAt: Date.now(), etaSeconds: null });
};

export const pausePreparing = (pause: boolean) => {
  if (!running) return;
  running.pause = pause;
  const j = usePrepare.getState().job;
  if (j && (j.state === "preparing" || j.state === "paused" || j.state === "waiting" || j.state === "checking")) update({ state: pause ? "paused" : "preparing", phase: pause ? "Paused" : "Preparing" });
};

/** Simulations and 3D physics in the show, prepared? (they're needed to draw frames; the editor prepares them in the background) */
const simsReady = () => Object.values(useSims.getState().status).every((s) => s.done >= s.total);

const run = async (r: import("@be/engine").FrameRenderer, disk: DiskFrames, ctl: { stop: boolean; pause: boolean }) => {
  const startJob = usePrepare.getState().job!;
  const { compId, resolution, quality, total } = startJob;
  const fraction = PLAN_FRACTION[resolution];
  const projectId = useStudio.getState().project?.id;
  const current = () => {
    const p = useStudio.getState().project;
    if (!p || p.id !== projectId) throw new Error("another show was opened");
    if (!p.compositions[compId]) throw new Error("the scene was deleted");
    return p;
  };
  const halt = async (): Promise<boolean> => {
    while (ctl.pause && !ctl.stop) await sleep(200);
    return ctl.stop;
  };

  // 1. Simulations and 3D physics first.
  update({ state: "waiting", phase: "Preparing simulations and 3D physics first" });
  while (!simsReady()) {
    if (await halt()) return;
    await sleep(300);
  }
  // 2. The frames already on disk for this version of the show.
  update({ phase: "Finding frames already prepared" });
  if (!(await disk.ensureReady(current(), compId))) throw new Error("the disk cache isn't available (check its folder in Quality & speed)");

  let bytesSaved = 0;
  let pixelsSaved = 0;
  let savedFrames = 0;
  let sizeChecked = false;
  let unsaved = 0;
  const failed = new Set<number>();
  const tries = new Map<number, number>();
  const speed: number[] = [];
  let lastReport = 0;
  let rendered = startJob.rendered;
  const timing = { prepareMs: 0, renderMs: 0, saveWaitMs: 0 };
  const ema = (k: keyof typeof timing, ms: number) => (timing[k] = timing[k] ? timing[k] * 0.9 + ms * 0.1 : ms);
  const report = (round: number) => {
    const p = current();
    const onDisk = disk.framesOnDisk(p, compId, fraction, quality).size;
    const now = performance.now();
    while (speed.length && now - speed[0]! > 10_000) speed.shift();
    const fps = speed.length > 1 ? (speed.length - 1) / ((now - speed[0]!) / 1000) : 0;
    const left = total - onDisk - failed.size;
    const ms = (v: number) => Math.round(v * 10) / 10;
    update({ done: Math.min(total, onDisk), rendered, failedFrames: failed.size, fps: Math.round(fps * 10) / 10, etaSeconds: fps > 0 ? Math.round(left / fps) : null, phase: round > 1 ? `Re-preparing frames changed by edits (round ${round})` : "Preparing", timing: { prepareMs: ms(timing.prepareMs), renderMs: ms(timing.renderMs), saveWaitMs: ms(timing.saveWaitMs), gpuMs: ms(saveTiming.gpuMs), compressMs: ms(saveTiming.compressMs), writeMs: ms(saveTiming.writeMs) } });
  };

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    update({ state: "preparing" });
    let sliceStart = performance.now();
    for (let f = 0; f < total; f++) {
      if (await halt()) return;
      let p = current();
      if (disk.has(p, compId, f, fraction, quality) || failed.has(f)) continue;
      const comp = p.compositions[compId]!;
      const t = frameToTime(f, comp.frameRate);
      // Wait for a free save slot before rendering (keeps memory flat).
      const w = Math.max(1, Math.round(comp.width * fraction));
      const h = Math.max(1, Math.round(comp.height * fraction));
      const t0 = performance.now();
      await disk.slot(w, h);
      const t1 = performance.now();
      await r.prepareAt(p, compId, t);
      const t2 = performance.now();
      p = current(); // an edit may have arrived while media loaded
      const tex = r.renderContent(p, compId, t, fraction, quality);
      ema("saveWaitMs", t1 - t0);
      ema("prepareMs", t2 - t1);
      ema("renderMs", performance.now() - t2);
      if (!tex) continue;
      const content = r.gpu.detach(tex);
      if (r.lastFrameIncomplete) {
        r.gpu.defer(content);
        const n = (tries.get(f) ?? 0) + 1;
        tries.set(f, n);
        if (n >= MAX_TRIES) failed.add(f);
        else f--; // try this frame again
        await sleep(150);
        continue;
      }
      const saving = disk.saveNow(p, compId, f, fraction, quality, content);
      void saving.then((bytes) => {
        r.gpu.defer(content);
        if (bytes === null) unsaved++;
        else if (bytes > 0) {
          unsaved = 0;
          bytesSaved += bytes;
          pixelsSaved += content.width * content.height;
          savedFrames++;
        }
      });
      speed.push(performance.now());
      rendered++;
      // Saving keeps failing: the drive is nearly full (or the folder went away).
      if (unsaved >= 12) {
        const sp = await window.be.cache.space().catch(() => null);
        throw new Error(sp && sp.freeBytes < 3 * GB ? `${sp.drive} is nearly full (${formatSize(sp.freeBytes)} free). Free some space, then prepare again: frames already saved are kept` : "frames couldn't be saved to the disk cache's folder. Check it in Quality & speed, then prepare again: frames already saved are kept");
      }
      // Real frame sizes: check the disk cache still holds every frame.
      if (!sizeChecked && savedFrames >= 60) {
        sizeChecked = true;
        const bpp = bytesSaved / pixelsSaved;
        try {
          if (projectId) localStorage.setItem(bppKey(projectId), String(bpp));
        } catch {
          // a convenience
        }
        const need = total * w * h * bpp;
        const limit = usePreview.getState().diskCacheGB * GB;
        update({ diskBytes: Math.round(need) });
        if (need > limit * 0.97) {
          update({ state: "stopped", phase: "Stopped", finishedAt: Date.now(), etaSeconds: null, reason: `These frames are larger than estimated: every frame needs about ${formatSize(need)}, more than the disk cache's ${formatSize(limit)}. Raise its size (Quality & speed → Disk space), then prepare again; frames already saved are kept.` });
          running = null;
          return;
        }
      }
      // Give the editor (and the playing preview) room.
      const now = performance.now();
      if (now - lastReport > 500) {
        lastReport = now;
        report(round);
      }
      if (now - sliceStart > (useStudio.getState().playing ? 8 : 40)) {
        await sleep(useStudio.getState().playing ? 16 : 0);
        sliceStart = performance.now();
      }
    }
    // 3. Check: every frame on disk? (edits during preparation remove the frames they change)
    update({ state: "checking", phase: "Checking every frame is on disk" });
    for (let i = 0; i < 40 && disk.pendingSaves > 0; i++) await sleep(100);
    report(round);
    const j = usePrepare.getState().job!;
    if (j.done + failed.size >= total) break;
  }
  update({ rendered });
  const j = usePrepare.getState().job!;
  const missing = total - j.done;
  const took = (Date.now() - j.startedAt) / 1000;
  update({
    state: missing > 0 ? "failed" : "done",
    phase: missing > 0 ? "Finished with gaps" : "Prepared",
    finishedAt: Date.now(),
    etaSeconds: null,
    ...(missing > 0
      ? { reason: `${missing.toLocaleString()} of ${total.toLocaleString()} frames couldn't be prepared${failed.size ? ` (${failed.size.toLocaleString()} waited for media that never loaded: check for missing files)` : " (the show kept changing: prepare again when editing pauses)"}. The rest play smoothly.` }
      : { reason: `Every frame (${total.toLocaleString()}) is on disk${j.rendered ? `; ${j.rendered.toLocaleString()} rendered in ${clock(took)}` : ""}.` }),
  });
  running = null;
};
