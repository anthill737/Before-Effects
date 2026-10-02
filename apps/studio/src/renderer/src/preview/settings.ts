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
export type View = "show" | "3d" | "projector";

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
  playbackMode: "realtime" | "cache";
  effectQuality: "full" | "draft";
  simQuality: "full" | "draft";
  /** Real-time mode: skip frames to keep timing (true) or play every frame, slower if needed (false). */
  frameSkipping: boolean;
  useProxies: boolean;
  /** VRAM budget for cached frames, in megabytes. */
  cacheBudgetMB: number;
  overlays: { outlines: boolean; selection: boolean; guides: boolean; grid: boolean };
  orbit: OrbitCamera;
  ambient: number;
  /** Enlarged preview (side panels collapsed; timeline and transport stay). */
  maximized: boolean;
}

const DEFAULTS: PreviewSettings = {
  view: "show",
  resolution: "auto",
  customScale: 0.75,
  autoFraction: 1,
  zoom: "fit",
  playbackMode: "realtime",
  effectQuality: "full",
  simQuality: "full",
  frameSkipping: true,
  useProxies: true,
  cacheBudgetMB: 1536,
  overlays: { outlines: true, selection: true, guides: false, grid: false },
  orbit: DEFAULT_ORBIT,
  ambient: 0.05,
  maximized: false,
};

const KEY = `be.preview.${window.be?.app.kind ?? "editor"}`;

const load = (): PreviewSettings => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<PreviewSettings>), autoFraction: 1 };
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
    } catch {
      // preferences are a convenience
    }
  },
  reset() {
    set(DEFAULTS);
  },
}));

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
