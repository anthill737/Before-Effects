/** Tracing state for the "Set up the space" step: current tool, the shape being drawn, suggestions. */
import type { PathData, RegionKind, Vec2 } from "@be/core";
import { create } from "zustand";

export type TraceTool = "select" | "rect" | "polygon" | "edge" | "hole";

export interface Suggestion {
  readonly id: string;
  readonly path: PathData;
  readonly score: number;
  accepted: boolean;
}

export interface TraceState {
  tool: TraceTool;
  /** Points placed so far for polygon/edge tools (venue canvas px). */
  draft: Vec2[];
  /** A finished shape waiting for "What is this?". */
  pending: { path: PathData; at: Vec2 } | null;
  /** Suggested repeats of a traced region, shown dashed until accepted. */
  suggestions: { kind: RegionKind; baseName: string; items: Suggestion[] } | null;
  photoOpacity: number;
  /** A selected corner of the selected area (Delete removes it). */
  vertex: { regionId: string; index: number } | null;
  set(p: Partial<TraceState>): void;
}

export const useTrace = create<TraceState>((set) => ({
  tool: "select",
  draft: [],
  pending: null,
  suggestions: null,
  photoOpacity: 1,
  vertex: null,
  set: (p) => set(p),
}));

export const KIND_ROLE: Record<RegionKind, string> = {
  window: "windows",
  door: "doors",
  wall: "walls",
  column: "columns",
  roofline: "rooflines",
  edge: "edges",
  custom: "other",
  exclusion: "no-light",
};

export const KIND_CHOICES: Array<{ kind: RegionKind; label: string; open?: boolean }> = [
  { kind: "window", label: "Window" },
  { kind: "door", label: "Door" },
  { kind: "wall", label: "Wall" },
  { kind: "column", label: "Column" },
  { kind: "roofline", label: "Roofline", open: true },
  { kind: "edge", label: "Edge or line", open: true },
  { kind: "custom", label: "Something else" },
  { kind: "exclusion", label: "Keep light off here" },
];
