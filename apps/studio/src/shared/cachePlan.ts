/**
 * Cache recommendations from this computer's hardware, and what they hold. Pure (no system calls),
 * shared by the preview settings and the agent API; unit-tested in apps/studio/test.
 *
 *   Graphics memory   Finished frames and decoded video live on the graphics card. A card with its
 *                     own memory gives the editor's caches about a third of it: the rest is for
 *                     effects, 3D, simulations, the display and the projector output window (which
 *                     keeps a small cache of its own). Going over the card's memory makes Windows
 *                     lend it the computer's memory, and everything slows down. A card that borrows
 *                     the computer's memory gets a modest share of that instead.
 *   Disk              Prepared frames are kept on the data drive (compact JPEGs), so a whole show can
 *                     be prepared once and played smoothly after restarting. The recommended size
 *                     holds the whole show at the recommended preview size, when the drive allows,
 *                     and always leaves the drive plenty of free space.
 *   Preview size      The largest of Full, Half and Quarter whose whole show fits the disk space the
 *                     drive can spare; cards with little memory start at Half.
 *
 * Amounts are rounded to what the controls show. Recommendations never limit anything: every amount
 * stays adjustable.
 */

const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** Bytes per pixel of a prepared frame on disk (JPEG at high quality, typical show content). */
export const DEFAULT_DISK_BYTES_PER_PIXEL = 0.45;
/** Bytes per pixel of a frame in graphics memory (half-float RGBA working space). */
export const GPU_BYTES_PER_PIXEL = 8;
/** Below this much memory of its own, a graphics card is treated as borrowing the computer's. */
const DEDICATED_MIN = 2 * GB;

export interface Hardware {
  readonly ramBytes: number;
  readonly gpu: { readonly name: string; readonly bytes: number } | null;
  readonly cpuCores?: number;
  /** The drive the preview frames go on. */
  readonly drive?: { readonly path: string; readonly freeBytes: number; readonly totalBytes: number } | null;
  /** Space preview frames already use on that drive (it can be reused). */
  readonly cacheUsedBytes?: number;
  /** Measured bytes per pixel of frames already prepared (otherwise a typical value). */
  readonly diskBytesPerPixel?: number;
}

/** Something to prepare: a scene or the whole show. */
export interface Footage {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly seconds: number;
}

export type PlanResolution = "full" | "half" | "quarter" | "eighth";
export const PLAN_FRACTION: Record<PlanResolution, number> = { full: 1, half: 1 / 2, quarter: 1 / 4, eighth: 1 / 8 };

export interface Fit {
  readonly name: string;
  readonly frames: number;
  readonly seconds: number;
  /** Disk space for every frame at that size. */
  readonly diskBytes: number;
  readonly diskFits: boolean;
  /** Seconds of it graphics memory holds at once. */
  readonly memorySeconds: number;
}

export interface CachePlan {
  readonly gpuKind: "dedicated" | "shared" | "unknown";
  readonly frameCacheMB: number;
  readonly videoCacheMB: number;
  readonly diskCache: true;
  readonly diskCacheGB: number;
  readonly resolution: PlanResolution;
  readonly playbackMode: "cache";
  /** Plain-language reasons, one per recommendation. */
  readonly reasons: readonly string[];
  /** What the recommended settings hold: each scene asked about, and the whole show. */
  readonly fits: readonly Fit[];
}

const roundTo = (v: number, step: number) => Math.max(step, Math.round(v / step) * step);
const sizeText = (bytes: number) => (bytes >= 10 * GB ? `${Math.round(bytes / GB)} GB` : bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / MB))} MB`);
const clock = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`);

/** Frames of footage, and the bytes one frame takes on disk and in graphics memory at a resolution. */
export const footageCost = (f: Footage, res: PlanResolution, diskBytesPerPixel = DEFAULT_DISK_BYTES_PER_PIXEL) => {
  const k = PLAN_FRACTION[res];
  const px = Math.max(1, Math.round(f.width * k)) * Math.max(1, Math.round(f.height * k));
  const frames = Math.max(1, Math.ceil(f.seconds * f.fps));
  return { frames, diskFrameBytes: px * diskBytesPerPixel, gpuFrameBytes: px * GPU_BYTES_PER_PIXEL };
};

/** What a cache setup holds of some footage at a resolution. */
export const fitOf = (f: Footage, res: PlanResolution, frameCacheBytes: number, diskBytes: number, diskBytesPerPixel?: number): Fit => {
  const c = footageCost(f, res, diskBytesPerPixel);
  const need = c.frames * c.diskFrameBytes;
  return { name: f.name, frames: c.frames, seconds: f.seconds, diskBytes: Math.round(need), diskFits: need <= diskBytes, memorySeconds: Math.floor(frameCacheBytes / c.gpuFrameBytes) / f.fps };
};

/**
 * Recommended cache settings for this computer, sized for `footage` (the current scene and the
 * whole show; the largest decides the disk space and preview size).
 */
export const recommendCache = (hw: Hardware, footage: readonly Footage[]): CachePlan => {
  const reasons: string[] = [];
  const vram = hw.gpu?.bytes ?? 0;
  const gpuKind: CachePlan["gpuKind"] = !hw.gpu ? "unknown" : vram >= DEDICATED_MIN ? "dedicated" : "shared";

  // ---- graphics memory ----
  let caches: number;
  if (gpuKind === "dedicated") {
    caches = vram * 0.35;
    reasons.push(`The graphics card (${hw.gpu!.name}) has ${Math.round(vram / GB)} GB of its own: about a third of it holds finished frames and video, the rest is left for effects, 3D, the display and the projector output.`);
  } else {
    caches = Math.min(hw.ramBytes * 0.15, 6 * GB);
    reasons.push(
      gpuKind === "shared"
        ? `The graphics card (${hw.gpu!.name}) borrows the computer's memory, so the caches take a modest share of its ${Math.round(hw.ramBytes / GB)} GB.`
        : `The graphics card's memory isn't known, so the caches take a modest share of the computer's ${Math.round(hw.ramBytes / GB)} GB.`,
    );
  }
  caches = Math.max(1 * GB, caches);
  const videoCacheMB = roundTo(Math.min(1.5 * GB, Math.max(1 * GB, caches * 0.25)) / MB, 256);
  const frameCacheMB = roundTo(Math.max(512 * MB, caches - videoCacheMB * MB) / MB, 256);

  // ---- disk and preview size ----
  const biggest = [...footage].sort((a, b) => b.seconds * b.width * b.height - a.seconds * a.width * a.height)[0];
  const drive = hw.drive ?? null;
  // What the drive can spare: its free space plus what preview frames already use, keeping at least
  // 20 GB (and a tenth of the drive) free for everything else.
  const spare = drive ? Math.max(0, drive.freeBytes + (hw.cacheUsedBytes ?? 0) - Math.max(20 * GB, drive.totalBytes * 0.1)) : 50 * GB;
  const order: PlanResolution[] = gpuKind === "dedicated" && vram >= 6 * GB ? ["full", "half", "quarter"] : ["half", "quarter"];
  if (order[0] === "half") reasons.push("With this graphics card, preparing at Half size keeps preparation quick; Full is still available.");
  let resolution: PlanResolution = order.at(-1)!;
  let need = 0;
  for (const r of order) {
    need = biggest ? footageCost(biggest, r, hw.diskBytesPerPixel).frames * footageCost(biggest, r, hw.diskBytesPerPixel).diskFrameBytes : 0;
    resolution = r;
    if (need * 1.15 <= spare) break;
  }
  // Room for the biggest show (with some to spare) and for other shows and versions of this one:
  // three times that, or a tenth of the drive's free space, whichever is more (at most 200 GB) —
  // within what the drive can spare. Large amounts are rounded to tens of GB.
  const one = need * 1.15 + 2 * GB;
  const several = Math.min(200 * GB, Math.max(3 * need * 1.15, (drive?.freeBytes ?? 0) * 0.1));
  const cap = Math.max(10 * GB, spare);
  let diskGB = Math.ceil(Math.min(Math.max(one, several, 10 * GB), cap) / GB);
  if (diskGB > 50) diskGB = Math.min(Math.floor(cap / GB), Math.ceil(diskGB / 10) * 10);
  const diskCacheGB = Math.max(10, diskGB);
  if (biggest) {
    const fitsAll = need * 1.15 <= spare;
    reasons.push(
      fitsAll
        ? `Every frame of “${biggest.name}” (${clock(biggest.seconds)}) at ${resolution === "full" ? "Full" : resolution === "half" ? "Half" : "Quarter"} size takes about ${sizeText(need)} on disk${drive ? `, which ${drive.path} can spare (${sizeText(drive.freeBytes)} free)` : ""}, so it can be prepared once and play smoothly, even after restarting.`
        : `${drive ? `${drive.path} has ${sizeText(drive.freeBytes)} free` : "The drive's free space isn't known"}: not enough for every frame of “${biggest.name}” even at Quarter size (about ${sizeText(need)}). Prepared frames past the limit replace the ones used longest ago.`,
    );
    if (resolution !== order[0] && fitsAll) reasons.push(`At ${order[0] === "full" ? "Full" : "Half"} size it would take more disk space than the drive can spare.`);
    if (diskCacheGB * GB > one * 1.5)
      reasons.push(`${diskCacheGB} GB leaves room for other shows and other versions of this one too${drive ? ` (about a tenth of the ${sizeText(drive.freeBytes)} free on ${drive.path})` : ""}: their prepared frames stay while you work on this one.`);
  }
  const frameBytes = frameCacheMB * MB;
  const fits = footage.map((f) => fitOf(f, resolution, frameBytes, diskCacheGB * GB, hw.diskBytesPerPixel));
  return { gpuKind, frameCacheMB, videoCacheMB, diskCache: true, diskCacheGB, resolution, playbackMode: "cache", reasons, fits };
};
