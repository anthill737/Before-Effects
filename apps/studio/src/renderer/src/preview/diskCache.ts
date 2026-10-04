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
 *             composition, plus the frame's signature (what it's made from: frameSignatures in
 *             core) and the tag of the build that drew it. A frame is looked up under the signature
 *             it has in the show as it is now, so after an edit, reopening the saved show, undoing,
 *             or opening a recovered or copied show, the frames whose inputs are unchanged are found
 *             and only the others are made again; frames of other versions stay on disk (until the
 *             size limit retires them) and are never shown in their place. Edits delete nothing.
 *
 * Format: JPEG at high quality. Frames are working-space half floats (8 bytes a pixel: 66 MB for a
 * 4K frame), far too much to move through the desktop process and disk 30 times a second, and
 * 20 GB would hold ten seconds. JPEG brings a 4K frame to about 1–2 MB and is the fastest image
 * format the browser engine encodes and decodes, so reading back is quicker than rendering most
 * shows. Colour is stored sRGB-shaped in 90 % of the code values with light brighter than white
 * (glows) compressed into the rest, and alpha as a grey band below, so the "On the house", 3D and
 * projector views stay close to a fresh render. It's a preview: exports always render afresh.
 */
import { type Affected, contentAt, type ContentKind, frameSignatures, frameToTime, type Project, type Rational } from "@be/core";
import { COMMON, type FrameRenderer } from "@be/engine";
import { create } from "zustand";
import type { DiskCacheStatus, DiskCacheUsage } from "../../../shared/api.ts";
import { buildTag, diskKey, fingerprint, frameKey, isLegacyKey, parseDiskKey } from "../../../shared/diskFrames.ts";
import { useStudio } from "../studio/store.ts";
import type { FrameCache } from "./cache.ts";
import { usePreview } from "./settings.ts";

const GB = 1024 ** 3;

/**
 * Builds of the app whose prepared frames this build keeps where it draws them the same: a build
 * (its name: "render <hash>", or an older build time) → the kinds of content this build draws
 * differently. Frames of the show as it is now that use any of those kinds are made again; the rest
 * are given this build's tag. A build not listed keeps its frames to itself. An entry is added only
 * after checking that frames of the other kinds come out identical (byte for byte on disk).
 */
const CARRY_OVER: Readonly<Record<string, readonly ContentKind[]>> = {
  // a3cc304 as installed on 2026-10-04 (its build time is its stamp). Since then 3D scenes, track
  // mattes, adjustment layers and the newer blend modes draw differently; 2D layers (pictures,
  // video, text, shapes, effects, masks, the basic blend modes) and simulations don't.
  "2026-10-04T01:38:20.094Z": ["3d", "track-matte", "adjustment", "blend-mode"],
  // 4b61055 (render 35efe0e6e524ff03). Since then only how graphics memory is reused and reported
  // changed, not what's drawn. A whole 35,340-frame show made again came out byte-identical in 32,823
  // frames; the rest are 3D frames that 4b61055 itself draws differently from one preparation to the
  // next (turning blocks, falling bricks, the frame a light comes on): in a 2,100-frame stretch, two
  // preparations by 4b61055 and two by this build each matched an earlier one in 1,200–1,320 frames.
  "render 35efe0e6e524ff03": [],
  // d2f1de1 (render 31e6845873c4b4e0), installed 2026-10-04. This build draws each 3D frame the same
  // whatever was drawn before it (shadows redrawn for every frame; scenes made once their pictures
  // are in), so some 3D frames it makes differ from that build's. Those prepared frames were
  // approved, so they're kept (given this build's tag). Replacements, once made in another folder
  // and checked, take their place under the same names.
  "render 31e6845873c4b4e0": [],
};

/** This build: its name and the tag its frames carry on disk (asked once). */
let thisBuild: Promise<{ build: string; tag: string }> | null = null;
const currentBuild = () => (thisBuild ??= window.be.cache.build());

/** Signatures of a show version's frames, per composition (worked out once per version of the show). */
const signatures = new WeakMap<Project, Map<string, (frame: number) => string>>();
const signaturesOf = (project: Project, compId: string): ((frame: number) => string) => {
  let m = signatures.get(project);
  if (!m) signatures.set(project, (m = new Map()));
  let f = m.get(compId);
  if (!f) m.set(compId, (f = frameSignatures(project, compId)));
  return f;
};
const JPEG_QUALITY = 0.92;
/** Saves at once (enough to keep the graphics card and every compression worker busy), and the pixel memory they may hold while waiting for compression. */
const MAX_SAVES = 8;
const MAX_STAGING = 256 * 1024 ** 2;
/** Reads at once (a frame needed right now always starts): enough to read ahead faster than playback. */
const MAX_READS = 12;
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

/** Where saving a frame's time goes, on average (ms): the graphics card finishing it, compressing, writing. */
export const saveTiming = { gpuMs: 0, compressMs: 0, writeMs: 0 };
const ema = (k: keyof typeof saveTiming, ms: number) => (saveTiming[k] = saveTiming[k] ? saveTiming[k] * 0.9 + ms * 0.1 : ms);

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
interface Scope {
  readonly id: string;
  readonly project: string;
  readonly comp: string;
  ready: boolean;
  /** Keys on disk this window knows of (every version of the show, every build). */
  readonly onDisk: Set<string>;
  /** Bumped by every change to the show: reads started before it are dropped (they may be for the old version). */
  epoch: number;
  /** This build's tag (what its frames on disk carry). */
  tag: string;
  /** Bumped whenever onDisk changes. */
  version: number;
  /** Frames of each show version on disk, at the version they were counted (this list's own: a new list counts afresh). */
  readonly counted: WeakMap<Project, Map<string, Set<number>>>;
  /** When the keys were last read from disk (read-only windows read them again now and then). */
  loadedAt: number;
  refreshing: boolean;
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
  private workers: Worker[] = [];
  private nextWorker = 0;
  private jobs = new Map<number, (r: { bytes?: ArrayBuffer; error?: string }) => void>();
  private seq = 0;
  private warned = false;
  private disposed = false;
  /** Waiting for a save to finish (frame preparation keeps pace with saving). */
  private slotWaiters: Array<() => void> = [];
  private listeners = new Set<() => void>();

  constructor(
    private readonly renderer: FrameRenderer,
    /** The show as edited (null while a temporary hover preview is showing). */
    private readonly project: () => Project | null,
  ) {
    live.add(this);
  }

  /** Frames being saved right now. */
  get pendingSaves(): number {
    return this.saves.size;
  }

  /** Saving: frames on their way to disk, the pixel memory they hold, and frames remembered to save later. */
  memoryReport(): { saving: number; stagingBytes: number; backlog: number; reading: number } {
    return { saving: this.saves.size, stagingBytes: this.staging, backlog: this.backlog.size, reading: this.reads.size };
  }

  private readAvg = 0;
  /** How long reading a frame back takes, from asking for it to its being in graphics memory (ms, recent average). */
  get readMs(): number {
    return this.readAvg;
  }

  get enabled(): boolean {
    return !this.disposed && usePreview.getState().diskCache && !!window.be?.cache;
  }

  /**
   * Projector outputs and the pop-out preview read prepared frames but never change what's on disk:
   * they look frames up the same way (signature and build) and read the keys again every few
   * seconds for what the editor saved meanwhile; they never save or rename frames. The editor owns
   * the frames on disk.
   */
  readonly readOnly = !!window.be?.app && window.be.app.kind !== "editor" && window.be.app.kind !== "uitest";

  /** Called when frames are saved to disk or dropped (throttle in the listener). */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Wait until a composition's frames on disk have been checked against this version of the show (false if they can't be). */
  async ensureReady(project: Project, compId: string, timeoutMs = 30_000): Promise<boolean> {
    const t0 = performance.now();
    while (this.enabled && performance.now() - t0 < timeoutMs) {
      if (this.scope(project, compId)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  /** Is this frame on disk (as far as this window knows; false until the composition has been checked)? */
  has(project: Project, compId: string, frame: number, fraction: number, quality: string): boolean {
    const s = this.enabled ? this.scope(project, compId) : null;
    return !!s && s.onDisk.has(this.keyOf(s, project, frame, fraction, quality));
  }

  /** A frame's key on disk for this version of the show and this build. */
  private keyOf(s: Scope, project: Project, frame: number, fraction: number, quality: string): string {
    return diskKey(frame, fraction, quality, signaturesOf(project, s.comp)(frame), s.tag);
  }

  /** The frames of a composition on disk at a size and quality (shared: copy it to change it). */
  framesOnDisk(project: Project, compId: string, fraction: number, quality: string): ReadonlySet<number> {
    const s = this.enabled ? this.scope(project, compId) : null;
    if (!s) return new Set();
    const memo = `${s.version}|${fraction}|${quality}`;
    const hit = s.counted.get(project)?.get(memo);
    if (hit) return hit;
    const out = new Set<number>();
    const sig = signaturesOf(project, compId);
    const want = frameKey(0, fraction, quality).slice(1);
    for (const k of s.onDisk) {
      const d = parseDiskKey(k);
      if (!d?.signature || d.tag !== s.tag || frameKey(0, d.fraction, d.quality).slice(1) !== want) continue;
      if (d.signature === sig(d.frame)) out.add(d.frame);
    }
    let m = s.counted.get(project);
    if (!m) s.counted.set(project, (m = new Map()));
    m.set(memo, out);
    return out;
  }

  /**
   * Save a frame now and wait until it's on disk: the size in bytes, or null when it wasn't kept
   * (the show changed meanwhile, the drive is nearly full, or the disk cache is off). Waits for a
   * free slot instead of setting the frame aside, so preparing many frames never outruns saving.
   * The texture can be released as soon as this returns its promise (the GPU copy is queued).
   */
  async saveNow(project: Project, compId: string, frame: number, fraction: number, quality: string, tex: GPUTexture): Promise<number | null> {
    const s = this.enabled && !this.readOnly ? this.scope(project, compId) : null;
    if (!s) return null;
    const key = this.keyOf(s, project, frame, fraction, quality);
    if (s.onDisk.has(key)) return 0;
    await this.slot(tex.width, tex.height);
    if (!this.enabled) return null;
    return (await this.save(s, key, frame, fraction, quality, tex, true)) ?? null;
  }

  /** Wait until a frame of this size can start saving (call before rendering it, to keep pace with saving). */
  async slot(width: number, height: number): Promise<void> {
    const size = Math.ceil((width * 4) / 256) * 256 * height;
    while (this.enabled && (this.saves.size >= MAX_SAVES || this.staging + size > MAX_STAGING)) await new Promise<void>((r) => this.slotWaiters.push(r));
  }

  /** A composition's frames on disk, once read (and, in the editor, the ones it can adopt renamed). Null until then. */
  private scope(project: Project, compId: string): Scope | null {
    const id = `${project.id}/${compId}`;
    let s = this.scopes.get(id);
    if (!s) {
      const sc: Scope = { id, project: project.id, comp: compId, ready: false, onDisk: new Set(), epoch: 0, tag: "", version: 0, counted: new WeakMap(), loadedAt: 0, refreshing: false };
      this.scopes.set(id, sc);
      const scope = { project: project.id, comp: compId };
      void (async () => {
        const { tag } = await currentBuild();
        let keys = await window.be.cache.keys(scope);
        if (!this.readOnly) keys = await this.adopt(project, compId, keys, tag);
        if (this.scopes.get(id) !== sc) return;
        sc.tag = tag;
        for (const k of keys) sc.onDisk.add(k);
        sc.version++;
        sc.loadedAt = performance.now();
        sc.ready = true;
        this.emit();
      })().catch(() => setTimeout(() => this.scopes.get(id) === sc && this.scopes.delete(id), 5000));
      s = sc;
    }
    // Read-only windows: what the editor has saved since, every few seconds.
    if (this.readOnly && s.ready && !s.refreshing && performance.now() - s.loadedAt > 4000) {
      const sc = s;
      sc.refreshing = true;
      void window.be.cache
        .keys({ project: sc.project, comp: sc.comp })
        .then((keys) => {
          sc.onDisk.clear();
          for (const k of keys) sc.onDisk.add(k);
          sc.version++;
        })
        .catch(() => undefined)
        .finally(() => {
          sc.loadedAt = performance.now();
          sc.refreshing = false;
        });
    }
    return s.ready ? s : null;
  }

  /**
   * Frames on disk this build can use for the show as it is now, given the names it looks for:
   *   - saved before signatures: when the composition's stamp is exactly this version of the show,
   *     made by this build or by one this build draws the same (CARRY_OVER);
   *   - drawn by an earlier build this one draws the same, for this version of the show.
   * Frames of other versions keep their names (they're those versions' frames). Returns the keys.
   */
  private async adopt(project: Project, compId: string, keys: string[], tag: string): Promise<string[]> {
    const comp = project.compositions[compId];
    if (!comp) return keys;
    const sig = signaturesOf(project, compId);
    const drawsSame = (frame: number, changed: readonly ContentKind[]) => {
      if (!changed.length) return true;
      const kinds = contentAt(project, compId, frameToTime(frame, comp.frameRate));
      return !changed.some((k) => kinds.has(k));
    };
    const renames: Array<[string, string]> = [];
    const scope = { project: project.id, comp: compId };
    const legacy = keys.filter(isLegacyKey);
    if (legacy.length) {
      const prev = await window.be.cache.previous(scope).catch(() => null);
      const changed = !prev ? undefined : prev.build === prev.current ? [] : CARRY_OVER[prev.build];
      if (prev && changed && prev.fingerprint === fingerprint(JSON.stringify(project)))
        for (const k of legacy) {
          const d = parseDiskKey(k)!;
          if (drawsSame(d.frame, changed)) renames.push([k, diskKey(d.frame, d.fraction, d.quality, sig(d.frame), tag)]);
        }
    }
    const older = new Map(Object.entries(CARRY_OVER).map(([b, changed]) => [buildTag(b), changed]));
    for (const k of keys) {
      const d = parseDiskKey(k);
      if (!d?.signature || d.tag === tag || d.signature !== sig(d.frame)) continue;
      const changed = older.get(d.tag!);
      if (changed && drawsSame(d.frame, changed)) renames.push([k, diskKey(d.frame, d.fraction, d.quality, d.signature, tag)]);
    }
    return renames.length ? await window.be.cache.adopt(scope, renames) : keys;
  }

  /**
   * Read a frame from disk into the frame cache, in the background. "reading" when it's on its way,
   * "wait" when it's on disk but enough reads are running (try again later), "absent" when it isn't
   * on disk. `now`: the frame is needed right now, so it starts even when many reads are running.
   */
  fetch(cache: FrameCache, project: Project, compId: string, frame: number, fraction: number, quality: string, now = false): DiskFetch {
    const comp = project.compositions[compId];
    const s = this.enabled && comp ? this.scope(project, compId) : null;
    if (!s || !comp) return "absent";
    const key = this.keyOf(s, project, frame, fraction, quality);
    const id = `${s.id}|${key}`;
    if (this.reads.has(id)) return "reading";
    if (!s.onDisk.has(key)) return "absent";
    if (!now && this.reads.size >= MAX_READS) return "wait";
    this.reads.set(id, performance.now());
    void this.read(cache, s, s.epoch, key, frame, fraction, quality, comp.height / comp.width).finally(() => this.reads.delete(id));
    return "reading";
  }

  /** How long this frame has been reading (ms), or -1 when it isn't. */
  readingFor(project: Project, compId: string, frame: number, fraction: number, quality: string): number {
    const s = this.scopes.get(`${project.id}/${compId}`);
    const started = s?.ready ? this.reads.get(`${s.id}|${this.keyOf(s, project, frame, fraction, quality)}`) : undefined;
    return started === undefined ? -1 : performance.now() - started;
  }

  private async read(cache: FrameCache, s: Scope, epoch: number, key: string, frame: number, fraction: number, quality: string, aspect: number): Promise<void> {
    const current = () => s.epoch === epoch && this.scopes.get(s.id) === s;
    const t0 = performance.now();
    try {
      const bytes = await window.be.cache.get({ project: s.project, comp: s.comp }, key);
      if (!bytes) {
        s.onDisk.delete(key);
        s.version++;
        return;
      }
      if (!current()) return;
      const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/jpeg" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      try {
        if (!current() || cache.has(s.comp, frame, fraction, quality)) return;
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
        if (!cache.put(s.comp, frame, fraction, quality, tex)) tex.destroy();
        const ms = performance.now() - t0;
        this.readAvg = this.readAvg ? this.readAvg * 0.9 + ms * 0.1 : ms;
      } finally {
        bmp.close();
      }
    } catch (e) {
      s.onDisk.delete(key);
      s.version++;
      this.warn(`couldn't read a frame: ${String(e)}`);
    }
  }

  /** A frame was just rendered and cached: save it too (in the background). */
  offer(project: Project, compId: string, frame: number, fraction: number, quality: string, tex: GPUTexture): void {
    const s = this.enabled && !this.readOnly ? this.scope(project, compId) : null;
    if (s) this.save(s, this.keyOf(s, project, frame, fraction, quality), frame, fraction, quality, tex);
  }

  /**
   * Start saving a frame under its key (made from the version of the show it was rendered from, so
   * it's right whatever happens to the show meanwhile); resolves with its size on disk (null when
   * it wasn't kept). `direct`: not from graphics memory, so never set aside for later.
   */
  private save(s: Scope, key: string, frame: number, fraction: number, quality: string, tex: GPUTexture, direct = false): Promise<number | null> | null {
    const id = `${s.id}|${key}`;
    if (s.onDisk.has(key) || this.saves.has(id)) return null;
    const w = tex.width;
    const h = tex.height;
    const stride = Math.ceil((w * 4) / 256) * 256;
    const size = stride * h;
    if (this.saves.size >= MAX_SAVES || this.staging + size > MAX_STAGING) {
      if (direct) return null;
      // Busy: save it later if it's still in graphics memory then.
      this.backlog.delete(id);
      this.backlog.set(id, { scope: s, key, frame, fraction, quality });
      if (this.backlog.size > MAX_BACKLOG) this.backlog.delete(this.backlog.keys().next().value!);
      return null;
    }
    const { gpu } = this.renderer;
    const target = gpu.acquire(w, h, "rgba8unorm", "disk frame");
    const buf = gpu.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = gpu.device.createCommandEncoder();
    gpu.pass(enc, ENCODE_FOR_DISK, target, [tex.createView()]);
    enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: stride }, [w, h]);
    gpu.submit(enc);
    gpu.release(target);
    this.saves.add(id);
    this.staging += size;
    return (async (): Promise<number | null> => {
      try {
        // Resolves when the GPU has finished; nothing waits for it meanwhile.
        const t0 = performance.now();
        await buf.mapAsync(GPUMapMode.READ);
        const data = buf.getMappedRange().slice(0);
        buf.unmap();
        const t1 = performance.now();
        const jpeg = await this.compress(data, w, h, stride);
        const t2 = performance.now();
        ema("gpuMs", t1 - t0);
        ema("compressMs", t2 - t1);
        if (this.scopes.get(s.id) !== s || !this.enabled) return null;
        const t3 = performance.now();
        const u = await window.be.cache.put({ project: s.project, comp: s.comp }, key, new Uint8Array(jpeg));
        ema("writeMs", performance.now() - t3);
        if (!u) return null;
        s.onDisk.add(key);
        s.version++;
        setUsage(u);
        this.emit();
        return jpeg.byteLength;
      } catch (e) {
        this.warn(`couldn't save a frame: ${String(e)}`);
        return null;
      } finally {
        buf.destroy();
        this.saves.delete(id);
        this.staging -= size;
        this.slotWaiters.shift()?.();
      }
    })();
  }

  /** Save one remembered frame, if there's room and it's still in this graphics memory. Call once per tick. */
  pump(cache: FrameCache): void {
    if (this.readOnly) return;
    if (!this.enabled || this.backlog.size === 0 || this.saves.size >= MAX_SAVES) return;
    const project = this.project();
    for (const [id, r] of this.backlog) {
      this.backlog.delete(id);
      if (this.scopes.get(r.scope.id) !== r.scope || r.scope.onDisk.has(r.key)) continue;
      // What's in graphics memory now is the show as it is now: only if that's still this frame's version.
      if (!project || project.id !== r.scope.project || this.keyOf(r.scope, project, r.frame, r.fraction, r.quality) !== r.key) continue;
      const tex = cache.peek(r.scope.comp, r.frame, r.fraction, r.quality);
      if (!tex) continue;
      this.save(r.scope, r.key, r.frame, r.fraction, r.quality, tex);
      return;
    }
  }

  private compress(data: ArrayBuffer, width: number, height: number, stride: number): Promise<ArrayBuffer> {
    if (this.workers.length === 0) {
      // Compressing a 1080p frame takes tens of milliseconds, a 4K one far more: a worker per two
      // processor cores (2 to 6), so preparing a show isn't held up by compression.
      const n = Math.max(2, Math.min(6, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
      for (let i = 0; i < n; i++) {
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
   * The show changed (called with the FrameCache's invalidation). Each composition loses exactly
   * the frames the change affected in it (`others` for those besides the edited one; an edit in a
   * scene changes the show around it only where the show plays that part). Compositions with no
   * such information are checked again before use.
   */
  changed(_project: Project | null, _compId: string, _affected: Affected, _rate: Rational | null, _others?: Readonly<Record<string, Affected>>): void {
    // Frames on disk are found by what they're made from, so an edit leaves them alone: the frames
    // it changes are looked for under their new signatures, and the old ones stay for undo or for
    // opening that version again. Reads under way may be for the old version: they're dropped.
    for (const sc of this.scopes.values()) sc.epoch++;
    this.emit();
  }

  /** Forget a composition's frames here; they're checked against the show again before use. */
  private drop(s: Scope): void {
    s.epoch++;
    this.scopes.delete(s.id);
  }

  /** What's on disk changed underneath (cleared, or another folder): check again before use. */
  forget(): void {
    for (const s of [...this.scopes.values()]) this.drop(s);
    this.backlog.clear();
    this.emit();
  }

  dispose(): void {
    this.forget();
    this.disposed = true;
    for (const w of this.workers) w.terminate();
    this.workers = [];
    for (const done of this.jobs.values()) done({ error: "closed" });
    this.jobs.clear();
    for (const w of this.slotWaiters.splice(0)) w();
    live.delete(this);
  }

  private warn(message: string): void {
    if (this.warned || this.disposed) return;
    this.warned = true;
    window.be.app.log(`preview disk cache: ${message}`);
  }
}

let windowDisk: DiskFrames | null = null;
/**
 * The window's frames on disk: one for every preview in the window and for frame preparation, so
 * what one saves the others know about, and a preview that's rebuilt (another step, popping out)
 * doesn't interrupt saving. It lasts as long as the window.
 */
export const diskFramesFor = (renderer: FrameRenderer): DiskFrames => {
  if (!windowDisk) {
    windowDisk = new DiskFrames(renderer, () => {
      const s = useStudio.getState();
      return s.hoverPreview ? null : s.project;
    });
    window.addEventListener("beforeunload", () => windowDisk?.dispose());
  }
  return windowDisk;
};
