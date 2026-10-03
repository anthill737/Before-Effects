/**
 * Preview frames on disk: the second cache tier behind the graphics-memory FrameCache, so frames
 * that don't fit in graphics memory (or were prepared in an earlier session) aren't rendered again.
 *
 *   Saving    after a frame is rendered and cached, a GPU pass turns it into 8-bit pixels; they're
 *             read back without waiting for the GPU (mapAsync), compressed in a worker and handed
 *             to the desktop process, which writes the file (main/previewCache.ts). When too many
 *             saves are running, the frame is remembered and saved later if it's still cached.
 *   Reading   a frame missing from graphics memory but on disk is read and decoded in the
 *             background (createImageBitmap), turned back into a working-space texture and put in
 *             the FrameCache. While playing, frames ahead are read early.
 *   Keys      the FrameCache key (frame, render fraction, effect quality) within the show and
 *             composition. Edits delete exactly the frames the FrameCache drops. Before a
 *             composition's frames are first used, a fingerprint of the show is checked, so frames
 *             made from a different version of it (another session, unsaved edits) are deleted.
 *
 * Format: JPEG at high quality. Frames are working-space half floats (8 bytes a pixel: 66 MB for a
 * 4K frame), far too much to move through the desktop process and disk 30 times a second, and
 * 20 GB would hold ten seconds. JPEG brings a 4K frame to about 1–2 MB and is the fastest image
 * format the browser engine encodes and decodes, so reading back is quicker than rendering most
 * shows. Colour is stored sRGB-shaped in 90 % of the code values with light brighter than white
 * (glows) compressed into the rest, and alpha as a grey band below, so the "On the house", 3D and
 * projector views stay close to a fresh render. It's a preview: exports always render afresh.
 */
import { type Affected, frameToTime, type Project, type Rational, timeToFrame } from "@be/core";
import { COMMON, type FrameRenderer } from "@be/engine";
import { create } from "zustand";
import type { DiskCacheStatus, DiskCacheUsage } from "../../../shared/api.ts";
import { fingerprint, frameKey, frameOfKey } from "../../../shared/diskFrames.ts";
import type { FrameCache } from "./cache.ts";
import { usePreview } from "./settings.ts";

const GB = 1024 ** 3;
const JPEG_QUALITY = 0.92;
/** Saves at once, and the pixel memory they may hold while waiting for compression. */
const MAX_SAVES = 4;
const MAX_STAGING = 256 * 1024 ** 2;
/** Reads at once (a frame needed right now always starts). */
const MAX_READS = 6;
/** Frames remembered for saving later. */
const MAX_BACKLOG = 4096;

/** Working space → 8 bits: linear light up to white sRGB-shaped in 0–0.9, brighter light compressed into 0.9–1. */
const ENCODE_FOR_DISK = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var src: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut { return fullscreen(vi); }
fn enc(c: vec3f) -> vec3f {
  let x = max(c, vec3f(0.0));
  let lo = linear_to_srgb(min(x, vec3f(1.0))) * 0.9;
  let hi = vec3f(0.9) + 0.1 * (vec3f(1.0) - vec3f(1.0) / max(x, vec3f(1.0)));
  return select(lo, hi, x > vec3f(1.0));
}
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let s = textureLoad(src, vec2i(i.pos.xy), 0);
  return vec4f(enc(s.rgb), clamp(s.a, 0.0, 1.0));
}
`;

/** The reverse, from the decoded image (colour on top, alpha as grey below when `banded`). */
const DECODE_FROM_DISK = /* wgsl */ `
${COMMON}
struct U { height: u32, banded: u32, _p0: u32, _p1: u32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut { return fullscreen(vi); }
fn dec(y: vec3f) -> vec3f {
  let lo = srgb_to_linear(min(y / 0.9, vec3f(1.0)));
  let hi = vec3f(1.0) / max(vec3f(1.0) - (y - vec3f(0.9)) / 0.1, vec3f(1.0 / 64.0));
  return select(lo, hi, y > vec3f(0.9));
}
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let p = vec2i(i.pos.xy);
  let c = textureLoad(src, p, 0);
  var a = 1.0;
  if (u.banded == 1u) { a = textureLoad(src, vec2i(p.x, p.y + i32(u.height)), 0).g; }
  return vec4f(dec(c.rgb), a);
}
`;

/** What's on disk, for the status line and the settings (shared by every preview in this window). */
export const useDiskCache = create<{ status: DiskCacheStatus | null }>(() => ({ status: null }));

const setUsage = (u: DiskCacheUsage | null | undefined) => {
  const prev = useDiskCache.getState().status;
  if (u && prev) useDiskCache.setState({ status: { ...prev, ...u } });
};

export const refreshDiskStatus = (): Promise<void> =>
  window.be.cache.status().then(
    (status) => useDiskCache.setState({ status }),
    () => undefined,
  );

const live = new Set<DiskFrames>();

const pushConfig = () => {
  const s = usePreview.getState();
  void window.be.cache.configure({ folder: s.diskCacheFolder, limitBytes: s.diskCacheGB * GB }).then(
    (status) => useDiskCache.setState({ status }),
    () => undefined,
  );
};

// The folder and size limit live in the desktop process; every window sends the same shared
// settings. Size changes wait a moment, so dragging the slider doesn't delete frames on the way.
if (window.be?.cache) {
  pushConfig();
  let timer = 0;
  usePreview.subscribe((s, prev) => {
    if (s.diskCacheFolder !== prev.diskCacheFolder) {
      // Another folder: what this window knew was on disk is about the old one.
      for (const d of live) d.forget();
      pushConfig();
    } else if (s.diskCacheGB !== prev.diskCacheGB) {
      clearTimeout(timer);
      timer = window.setTimeout(pushConfig, 600);
    }
  });
}

/** Delete every frame on disk (all shows), and forget what this window knew was there. */
export const clearDiskCache = async (): Promise<void> => {
  for (const d of live) d.forget();
  useDiskCache.setState({ status: await window.be.cache.clear() });
};

/** Frames whose time is in half-open time ranges, as half-open frame ranges (the FrameCache's test). */
const frameRanges = (ranges: Affected["ranges"], rate: Rational): Array<[number, number]> =>
  ranges.map(([s, e]) => {
    const first = (t: number) => {
      if (!Number.isFinite(t)) return t > 0 ? Number.MAX_SAFE_INTEGER : 0;
      const f = Math.max(0, timeToFrame(t, rate));
      return frameToTime(f, rate) < t ? f + 1 : f;
    };
    return [first(s), first(e)];
  });

interface Scope {
  readonly id: string;
  readonly project: string;
  readonly comp: string;
  ready: boolean;
  /** Frame keys this window knows are on disk. */
  readonly onDisk: Set<string>;
  /** Bumped by every change to the composition: reads and saves started before it are dropped. */
  epoch: number;
}

interface Remembered {
  readonly scope: Scope;
  readonly key: string;
  readonly frame: number;
  readonly fraction: number;
  readonly quality: string;
}

export type DiskFetch = "reading" | "wait" | "absent";

export class DiskFrames {
  private scopes = new Map<string, Scope>();
  private reads = new Map<string, number>();
  private saves = new Set<string>();
  private staging = 0;
  private backlog = new Map<string, Remembered>();
  private restamps = new Map<string, number>();
  private workers: Worker[] = [];
  private nextWorker = 0;
  private jobs = new Map<number, (r: { bytes?: ArrayBuffer; error?: string }) => void>();
  private seq = 0;
  private warned = false;
  private disposed = false;

  constructor(
    private readonly renderer: FrameRenderer,
    private readonly cache: FrameCache,
    /** The show as edited (null while a temporary hover preview is showing). */
    private readonly project: () => Project | null,
  ) {
    live.add(this);
  }

  get enabled(): boolean {
    return !this.disposed && usePreview.getState().diskCache && !!window.be?.cache;
  }

  /** A composition's frames on disk, once checked against this version of the show (null until then). */
  private scope(project: Project, compId: string): Scope | null {
    const id = `${project.id}/${compId}`;
    let s = this.scopes.get(id);
    if (!s) {
      const sc: Scope = { id, project: project.id, comp: compId, ready: false, onDisk: new Set(), epoch: 0 };
      this.scopes.set(id, sc);
      window.be.cache.validate({ project: project.id, comp: compId }, fingerprint(JSON.stringify(project))).then(
        (keys) => {
          if (this.scopes.get(id) !== sc) return;
          for (const k of keys) sc.onDisk.add(k);
          sc.ready = true;
        },
        // Try again a little later (e.g. the folder was briefly unavailable).
        () => setTimeout(() => this.scopes.get(id) === sc && this.scopes.delete(id), 5000),
      );
      s = sc;
    }
    return s.ready ? s : null;
  }

  /**
   * Read a frame from disk into the frame cache, in the background. "reading" when it's on its way,
   * "wait" when it's on disk but enough reads are running (try again later), "absent" when it isn't
   * on disk. `now`: the frame is needed right now, so it starts even when many reads are running.
   */
  fetch(project: Project, compId: string, frame: number, fraction: number, quality: string, now = false): DiskFetch {
    const comp = project.compositions[compId];
    const s = this.enabled && comp ? this.scope(project, compId) : null;
    if (!s || !comp) return "absent";
    const key = frameKey(frame, fraction, quality);
    const id = `${s.id}|${key}`;
    if (this.reads.has(id)) return "reading";
    if (!s.onDisk.has(key)) return "absent";
    if (!now && this.reads.size >= MAX_READS) return "wait";
    this.reads.set(id, performance.now());
    void this.read(s, s.epoch, key, frame, fraction, quality, comp.height / comp.width).finally(() => this.reads.delete(id));
    return "reading";
  }

  /** How long this frame has been reading (ms), or -1 when it isn't. */
  readingFor(project: Project, compId: string, frame: number, fraction: number, quality: string): number {
    const started = this.reads.get(`${project.id}/${compId}|${frameKey(frame, fraction, quality)}`);
    return started === undefined ? -1 : performance.now() - started;
  }

  private async read(s: Scope, epoch: number, key: string, frame: number, fraction: number, quality: string, aspect: number): Promise<void> {
    const current = () => s.epoch === epoch && this.scopes.get(s.id) === s;
    try {
      const bytes = await window.be.cache.get({ project: s.project, comp: s.comp }, key);
      if (!bytes) {
        s.onDisk.delete(key);
        return;
      }
      if (!current()) return;
      const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/jpeg" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      try {
        if (!current() || this.cache.has(s.comp, frame, fraction, quality)) return;
        // Saved with an alpha band the image is twice as tall as the frame's shape.
        const banded = bmp.height / bmp.width > aspect * 1.5;
        const w = bmp.width;
        const h = banded ? bmp.height / 2 : bmp.height;
        const { gpu } = this.renderer;
        const raw = gpu.device.createTexture({ size: [bmp.width, bmp.height], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
        gpu.device.queue.copyExternalImageToTexture({ source: bmp }, { texture: raw }, [bmp.width, bmp.height]);
        const tex = gpu.detach(gpu.acquire(w, h));
        const enc = gpu.device.createCommandEncoder();
        gpu.pass(enc, DECODE_FROM_DISK, tex, [raw.createView(), { buffer: gpu.uniform(new Uint32Array([h, banded ? 1 : 0, 0, 0])) }]);
        gpu.defer(raw);
        gpu.submit(enc);
        if (!this.cache.put(s.comp, frame, fraction, quality, tex)) tex.destroy();
      } finally {
        bmp.close();
      }
    } catch (e) {
      s.onDisk.delete(key);
      this.warn(`couldn't read a frame: ${String(e)}`);
    }
  }

  /** A frame was just rendered and cached: save it too (in the background). */
  offer(project: Project, compId: string, frame: number, fraction: number, quality: string, tex: GPUTexture): void {
    const s = this.enabled ? this.scope(project, compId) : null;
    if (s) this.save(s, frame, fraction, quality, tex);
  }

  private save(s: Scope, frame: number, fraction: number, quality: string, tex: GPUTexture): void {
    const key = frameKey(frame, fraction, quality);
    const id = `${s.id}|${key}`;
    if (s.onDisk.has(key) || this.saves.has(id)) return;
    const w = tex.width;
    const h = tex.height;
    const stride = Math.ceil((w * 4) / 256) * 256;
    const size = stride * h;
    if (this.saves.size >= MAX_SAVES || this.staging + size > MAX_STAGING) {
      // Busy: save it later if it's still in graphics memory then.
      this.backlog.delete(id);
      this.backlog.set(id, { scope: s, key, frame, fraction, quality });
      if (this.backlog.size > MAX_BACKLOG) this.backlog.delete(this.backlog.keys().next().value!);
      return;
    }
    const { gpu } = this.renderer;
    const target = gpu.acquire(w, h, "rgba8unorm", "disk frame");
    const buf = gpu.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = gpu.device.createCommandEncoder();
    gpu.pass(enc, ENCODE_FOR_DISK, target, [tex.createView()]);
    enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: stride }, [w, h]);
    gpu.submit(enc);
    gpu.release(target);
    const epoch = s.epoch;
    this.saves.add(id);
    this.staging += size;
    void (async () => {
      try {
        // Resolves when the GPU has finished; nothing waits for it meanwhile.
        await buf.mapAsync(GPUMapMode.READ);
        const data = buf.getMappedRange().slice(0);
        buf.unmap();
        const jpeg = await this.compress(data, w, h, stride);
        if (s.epoch !== epoch || this.scopes.get(s.id) !== s || !this.enabled) {
          // The show changed meanwhile; if the frame survived the edit, save it again later.
          if (this.scopes.get(s.id) === s) this.backlog.set(id, { scope: s, key, frame, fraction, quality });
          return;
        }
        const u = await window.be.cache.put({ project: s.project, comp: s.comp }, key, new Uint8Array(jpeg));
        if (u) {
          s.onDisk.add(key);
          setUsage(u);
        }
      } catch (e) {
        this.warn(`couldn't save a frame: ${String(e)}`);
      } finally {
        buf.destroy();
        this.saves.delete(id);
        this.staging -= size;
      }
    })();
  }

  /** Save one remembered frame, if there's room and it's still in graphics memory. Call once per tick. */
  pump(): void {
    if (!this.enabled || this.backlog.size === 0 || this.saves.size >= MAX_SAVES) return;
    for (const [id, r] of this.backlog) {
      this.backlog.delete(id);
      if (this.scopes.get(r.scope.id) !== r.scope || r.scope.onDisk.has(r.key)) continue;
      const tex = this.cache.peek(r.scope.comp, r.frame, r.fraction, r.quality);
      if (!tex) continue;
      this.save(r.scope, r.frame, r.fraction, r.quality, tex);
      return;
    }
  }

  private compress(data: ArrayBuffer, width: number, height: number, stride: number): Promise<ArrayBuffer> {
    if (this.workers.length === 0) {
      // Two workers: compressing a 4K frame takes tens of milliseconds.
      for (let i = 0; i < 2; i++) {
        const w = new Worker(new URL("./diskCodec.worker.ts", import.meta.url), { type: "module" });
        w.onmessage = (e: MessageEvent<{ id: number; bytes?: ArrayBuffer; error?: string }>) => {
          this.jobs.get(e.data.id)?.(e.data);
          this.jobs.delete(e.data.id);
        };
        this.workers.push(w);
      }
    }
    const id = ++this.seq;
    const worker = this.workers[this.nextWorker++ % this.workers.length]!;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, (r) => (r.bytes ? resolve(r.bytes) : reject(new Error(r.error ?? "compression failed"))));
      worker.postMessage({ id, data, width, height, stride, quality: JPEG_QUALITY }, [data]);
    });
  }

  /**
   * The show changed (called with the FrameCache's invalidation). The edited composition loses
   * exactly the frames the FrameCache drops; other compositions are checked again before use.
   */
  changed(project: Project | null, compId: string, affected: Affected, rate: Rational | null): void {
    const id = project ? `${project.id}/${compId}` : "";
    for (const [sid, sc] of this.scopes) {
      if (sid === id) continue;
      this.drop(sc);
    }
    const s = this.scopes.get(id);
    if (!s) return;
    if (affected.all || !rate) return this.drop(s);
    if (affected.ranges.length) {
      s.epoch++;
      const frames = frameRanges(affected.ranges, rate);
      for (const k of [...s.onDisk]) {
        const f = frameOfKey(k);
        if (frames.some(([a, b]) => f >= a && f < b)) s.onDisk.delete(k);
      }
      void window.be.cache.invalidate({ project: s.project, comp: s.comp }, frames).then(setUsage, () => undefined);
    }
    this.restampLater(s);
  }

  /** Forget a composition's frames here; they're checked against the show again before use. */
  private drop(s: Scope): void {
    s.epoch++;
    this.scopes.delete(s.id);
    clearTimeout(this.restamps.get(s.id));
    this.restamps.delete(s.id);
  }

  /** Record that the frames on disk now belong to the edited show (once edits pause). */
  private restampLater(s: Scope): void {
    clearTimeout(this.restamps.get(s.id));
    this.restamps.set(
      s.id,
      window.setTimeout(() => this.restamp(s), 400),
    );
  }

  private restamp(s: Scope): void {
    this.restamps.delete(s.id);
    if (this.scopes.get(s.id) !== s) return;
    const p = this.project();
    // A hover preview is showing: wait until it's gone.
    if (!p) return this.restampLater(s);
    if (p.id !== s.project) return;
    void window.be.cache.stamp({ project: s.project, comp: s.comp }, fingerprint(JSON.stringify(p))).catch(() => undefined);
  }

  /** What's on disk changed underneath (cleared, or another folder): check again before use. */
  forget(): void {
    for (const s of [...this.scopes.values()]) this.drop(s);
    this.backlog.clear();
  }

  dispose(): void {
    // Stamps waiting for edits to pause are written now, so the frames stay usable next time.
    for (const sid of [...this.restamps.keys()]) {
      const s = this.scopes.get(sid);
      if (s) this.restamp(s);
    }
    this.forget();
    this.disposed = true;
    for (const w of this.workers) w.terminate();
    this.workers = [];
    for (const done of this.jobs.values()) done({ error: "closed" });
    this.jobs.clear();
    live.delete(this);
  }

  private warn(message: string): void {
    if (this.warned || this.disposed) return;
    this.warned = true;
    window.be.app.log(`preview disk cache: ${message}`);
  }
}
