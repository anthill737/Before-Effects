/**
 * Preview settings. These are per-window viewing preferences and are never saved into the project
 * or used by exports.
 *
 * Resolution fractions are defined by image dimensions: Half of 3840×2160 is 1920×1080. Display
 * zoom is separate. Fitting the image into a small panel never changes what is rendered, and
 * manual choices are never changed by the app. Auto adapts within its own mode and always shows
 * the effective size.
 */
import { create } from "zustand";
import type { OrbitCamera } from "@be/engine";
import { DEFAULT_ORBIT } from "@be/engine";

export type ResolutionChoice = "auto" | "full" | "half" | "quarter" | "eighth" | "custom";
export type View = "show" | "venue" | "3d" | "projector";

export const RESOLUTIONS: Array<{ id: ResolutionChoice; label: string; fraction: number }> = [
  { id: "auto", label: "Auto", fraction: 1 },
  { id: "full", label: "Full", fraction: 1 },
  { id: "half", label: "Half", fraction: 1 / 2 },
  { id: "quarter", label: "Quarter", fraction: 1 / 4 },
  { id: "eighth", label: "Eighth", fraction: 1 / 8 },
  { id: "custom", label: "Custom", fraction: 1 },
];

export interface PreviewSettings {
  view: View;
  resolution: ResolutionChoice;
  /** Custom scale (0.05–1) when resolution = "custom". */
  customScale: number;
  /** What Auto is currently using. */
  autoFraction: number;
  /** "fit" or a zoom where 1 = one output pixel per screen pixel. */
  zoom: "fit" | number;
  /** "cache": Cache Before Playback (render the range first, then play it); "realtime": play as it renders, skipping frames to keep time. */
  playbackMode: "realtime" | "cache";
  /**
   * The frames a preview plays (as After Effects' Range): the work area (the preview range set with
   * Range start / end), the work area extended to take in the playhead, everything, or a stretch
   * round the playhead.
   */
  previewRange: "workarea-extended" | "workarea" | "entire" | "around";
  /** "around": seconds before and after the playhead. */
  aroundBefore: number;
  aroundAfter: number;
  /** Stopping while caching before playback plays the frames cached so far (from the range's start). */
  playCachedOnStop: boolean;
  /** Cache frames when idle: after this many seconds of nothing happening, frames ahead of the playhead are rendered and kept. */
  idleCache: boolean;
  idleDelaySeconds: number;
  effectQuality: "full" | "draft";
  simQuality: "full" | "draft";
  /** Real-time mode: skip frames to keep timing (true) or play every frame, slower if needed (false). */
  frameSkipping: boolean;
  useProxies: boolean;
  /** Graphics memory for finished frames, in megabytes (any amount from MIN_MEMORY_MB). */
  cacheBudgetMB: number;
  /** Graphics memory for decoded video frames, in megabytes (any amount from MIN_MEMORY_MB). */
  videoCacheMB: number;
  /** Also keep finished frames on disk. The disk settings are shared by every window (one folder). */
  diskCache: boolean;
  /** Disk space for frames, in gigabytes (any amount from MIN_DISK_GB). */
  diskCacheGB: number;
  /** A folder picked for frames on disk, or null for the data folder's Cache\preview. */
  diskCacheFolder: string | null;
  overlays: { outlines: boolean; selection: boolean; guides: boolean; grid: boolean };
  orbit: OrbitCamera;
  ambient: number;
  /** Enlarged preview (side panels collapsed; timeline and transport stay). */
  maximized: boolean;
  /** The left panel (Areas, Content, Effects, …) or the right panel (the inspector) folded away. */
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

const DEFAULTS: PreviewSettings = {
  view: "show",
  resolution: "auto",
  customScale: 0.75,
  autoFraction: 1,
  zoom: "fit",
  playbackMode: "realtime",
  previewRange: "workarea-extended",
  aroundBefore: 2,
  aroundAfter: 5,
  playCachedOnStop: true,
  idleCache: true,
  idleDelaySeconds: 2,
  effectQuality: "full",
  simQuality: "full",
  frameSkipping: true,
  useProxies: true,
  cacheBudgetMB: 1536,
  videoCacheMB: 768,
  diskCache: false,
  diskCacheGB: 20,
  diskCacheFolder: null,
  overlays: { outlines: true, selection: true, guides: false, grid: false },
  orbit: DEFAULT_ORBIT,
  ambient: 0.05,
  maximized: false,
  leftCollapsed: false,
  rightCollapsed: false,
};

/** Smallest amounts the cache controls accept (there's no largest). */
export const MIN_MEMORY_MB = 256;
export const MIN_DISK_GB = 1;

const KEY = `be.preview.${window.be?.app.kind ?? "editor"}`;
/** Disk-cache settings are stored once for all windows: there's one folder on disk. */
const DISK_KEY = "be.preview.disk";
const DISK_FIELDS = ["diskCache", "diskCacheGB", "diskCacheFolder"] as const;

const atLeast = (v: unknown, min: number, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(min, v) : fallback);

const loadDisk = (): Partial<PreviewSettings> => {
  try {
    const raw = localStorage.getItem(DISK_KEY);
    const d = raw ? (JSON.parse(raw) as Partial<PreviewSettings>) : {};
    return Object.fromEntries(DISK_FIELDS.filter((k) => k in d).map((k) => [k, d[k]]));
  } catch {
    return {};
  }
};

/**
 * Amounts from older or hand-edited preferences are kept within what the controls accept. Behaviour
 * that's automatic now (no switch for it) always starts on, whatever an older version saved: frames
 * play from the cache when stopping while caching, are cached when idle, skip to keep time, and
 * videos decode at the size they're drawn.
 */
const sane = (s: PreviewSettings): PreviewSettings => ({
  ...s,
  playCachedOnStop: true,
  idleCache: true,
  idleDelaySeconds: DEFAULTS.idleDelaySeconds,
  frameSkipping: true,
  useProxies: true,
  cacheBudgetMB: atLeast(s.cacheBudgetMB, MIN_MEMORY_MB, DEFAULTS.cacheBudgetMB),
  videoCacheMB: atLeast(s.videoCacheMB, MIN_MEMORY_MB, DEFAULTS.videoCacheMB),
  diskCache: s.diskCache === true,
  diskCacheGB: atLeast(s.diskCacheGB, MIN_DISK_GB, DEFAULTS.diskCacheGB),
  diskCacheFolder: typeof s.diskCacheFolder === "string" && s.diskCacheFolder ? s.diskCacheFolder : null,
});

const load = (): PreviewSettings => {
  try {
    const raw = localStorage.getItem(KEY);
    // An enlarged preview hides the side panels; it's for the moment, so each launch starts normal.
    if (raw) return sane({ ...DEFAULTS, ...(JSON.parse(raw) as Partial<PreviewSettings>), ...loadDisk(), autoFraction: 1, maximized: false });
    return sane({ ...DEFAULTS, ...loadDisk() });
  } catch {
    // ignore unreadable preferences
  }
  return DEFAULTS;
};

export const usePreview = create<PreviewSettings & { set(p: Partial<PreviewSettings>): void; reset(): void }>((set, get) => ({
  ...load(),
  set(p) {
    set(p);
    try {
      const { set: _s, reset: _r, ...rest } = { ...get(), ...p };
      localStorage.setItem(KEY, JSON.stringify(rest));
      if (DISK_FIELDS.some((k) => k in p)) localStorage.setItem(DISK_KEY, JSON.stringify(Object.fromEntries(DISK_FIELDS.map((k) => [k, rest[k]]))));
    } catch {
      // preferences are a convenience
    }
  },
  reset() {
    // Saved too, so a reset lasts (the disk settings are reset for every window).
    get().set(DEFAULTS);
  },
}));

// Another window changed the disk settings: follow them (the "storage" event only reaches other windows).
window.addEventListener?.("storage", (e) => {
  if (e.key === DISK_KEY) usePreview.setState(sane({ ...usePreview.getState(), ...loadDisk() }));
});

/** The fraction actually rendered right now. */
export const effectiveFraction = (s: Pick<PreviewSettings, "resolution" | "customScale" | "autoFraction">): number => {
  if (s.resolution === "auto") return s.autoFraction;
  if (s.resolution === "custom") return Math.min(1, Math.max(0.05, s.customScale));
  return RESOLUTIONS.find((r) => r.id === s.resolution)!.fraction;
};

export interface RenderSize {
  readonly width: number;
  readonly height: number;
  /** Full-quality size this is a fraction of (output size, or viewport for 3D). */
  readonly fullWidth: number;
  readonly fullHeight: number;
  /** Set when hardware limits reduced the size (never silent). */
  readonly limitedBy?: string;
}

export const renderSize = (fullW: number, fullH: number, fraction: number, maxTexture: number): RenderSize => {
  let w = Math.max(1, Math.round(fullW * fraction));
  let h = Math.max(1, Math.round(fullH * fraction));
  let limitedBy: string | undefined;
  if (w > maxTexture || h > maxTexture) {
    const k = maxTexture / Math.max(w, h);
    w = Math.floor(w * k);
    h = Math.floor(h * k);
    limitedBy = `graphics card limit (${maxTexture} px)`;
  }
  return { width: w, height: h, fullWidth: fullW, fullHeight: fullH, ...(limitedBy ? { limitedBy } : {}) };
};

export const fractionLabel = (f: number): string => {
  const named = RESOLUTIONS.find((r) => r.id !== "auto" && r.id !== "custom" && Math.abs(r.fraction - f) < 1e-6);
  return named ? named.label : `${Math.round(f * 100)}%`;
};
