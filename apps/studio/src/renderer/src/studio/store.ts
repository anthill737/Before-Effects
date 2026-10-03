/**
 * Studio state. One `History` (the project and its undo stack) plus UI state such as selection,
 * playhead, view and step. Every project change goes through `apply()`, which turns operation
 * errors into plain-language messages instead of crashes.
 */
import {
  createRegistry,
  emptyProject,
  type Flicks,
  frameToTime,
  History,
  newId,
  type Op,
  OpError,
  type OpSource,
  type Project,
  snapToFrame,
  type Transaction,
} from "@be/core";
import { create } from "zustand";
import { sampleSetupOps } from "../samples/facade.ts";

export type Step = "space" | "content" | "animate" | "preview" | "export";

export interface Toast {
  readonly id: number;
  readonly kind: "info" | "error" | "success";
  readonly text: string;
  readonly details?: string;
  readonly action?: { readonly label: string; readonly run: () => void };
}

export interface Selection {
  readonly regionIds: readonly string[];
  readonly recipeId: string | null;
  /** A plain layer (media, text, sound) selected in the timeline or layer list. */
  readonly layerId: string | null;
}

/**
 * While an external agent's call runs, its edits are grouped into one undo step (marked as the
 * agent's), their transaction ids are kept for rollback, and problems and notices are collected
 * for the agent instead of appearing as toasts.
 */
export interface AgentScope {
  readonly group: string;
  readonly errors: string[];
  readonly notes: string[];
  readonly txIds: string[];
}
let agentScope: AgentScope | null = null;
/** Run synchronous editing code as part of an agent call. */
export const inAgentScope = <T>(scope: AgentScope, fn: () => T): T => {
  const prev = agentScope;
  agentScope = scope;
  try {
    return fn();
  } finally {
    agentScope = prev;
  }
};
export const currentAgentScope = (): AgentScope | null => agentScope;

export interface StudioState {
  history: History | null;
  project: Project | null;
  version: number;
  compId: string | null;
  screen: "welcome" | "studio";
  step: Step;
  time: Flicks;
  playing: boolean;
  loop: boolean;
  /** Preview range (playback loops inside it); null = whole show. */
  range: { start: Flicks; end: Flicks } | null;
  selection: Selection;
  hoverRegionId: string | null;
  filePath: string | null;
  savedAt: string | null;
  dirty: boolean;
  toasts: Toast[];
  exportOpen: boolean;
  rendersOpen: boolean;
  showGrid: boolean;
  previewScale: number;
  previewMs: number;
  lastTx: Transaction | null;
  /** A reversible preview (hovering an effect): rendered instead of the project, never saved. */
  hoverPreview: Project | null;

  openSample(): void;
  openProject(project: Project, path: string | null): void;
  apply(ops: Op | Op[], opts?: { label?: string; source?: OpSource; coalesceKey?: string; group?: string; quiet?: boolean }): Transaction | null;
  undo(): void;
  redo(): void;
  setStep(s: Step): void;
  setTime(t: Flicks): void;
  setPlaying(p: boolean): void;
  setLoop(l: boolean): void;
  setRange(r: { start: Flicks; end: Flicks } | null): void;
  stepFrames(n: number): void;
  restart(): void;
  selectRegions(ids: readonly string[], additive?: boolean): void;
  selectRecipe(id: string | null): void;
  selectLayer(id: string | null): void;
  setHover(id: string | null): void;
  toast(t: Omit<Toast, "id">): void;
  dismissToast(id: number): void;
  setExportOpen(o: boolean): void;
  setShowGrid(g: boolean): void;
  setPreviewStats(scale: number, ms: number): void;
  markSaved(path: string, at: string): void;
  previewOps(ops: Op[] | null): void;
}

let toastId = 0;
const registry = createRegistry();

export const useStudio = create<StudioState>((set, get) => {
  const attach = (h: History) => {
    h.subscribe((project, tx) => {
      set({ project, version: h.version, dirty: h.isDirty, lastTx: tx });
    });
  };

  return {
    history: null,
    project: null,
    version: 0,
    compId: null,
    screen: "welcome",
    step: "animate",
    time: 0,
    playing: false,
    loop: true,
    range: null,
    selection: { regionIds: [], recipeId: null, layerId: null },
    hoverRegionId: null,
    filePath: null,
    savedAt: null,
    dirty: false,
    toasts: [],
    exportOpen: false,
    rendersOpen: false,
    showGrid: false,
    previewScale: 1,
    previewMs: 0,
    lastTx: null,
    hoverPreview: null,

    openSample() {
      const h = new History(emptyProject("Town hall sample"), registry);
      const { ops, compId } = sampleSetupOps();
      h.apply(ops, { label: "Open sample", source: "system" });
      // A starter effect so the sample opens already doing something.
      h.apply(
        { type: "recipe.apply", args: { instanceId: newId("rcp"), recipeId: "edge-trace", compId, targets: [{ role: "roofline" }], params: { lapSeconds: 4, color: [1, 0.78, 0.45, 1] }, label: "Roofline light" } },
        { label: "Sample effect", source: "system" },
      );
      h.reset(h.project);
      attach(h);
      set({ history: h, project: h.project, lastTx: null, compId, screen: "studio", step: "animate", time: frameToTime(30, h.project.compositions[compId]!.frameRate), playing: true, range: null, filePath: null, savedAt: null, dirty: false, selection: { regionIds: [], recipeId: null, layerId: null } });
    },

    openProject(project, path) {
      const h = new History(project, registry);
      h.markSaved();
      attach(h);
      const compId = project.mainCompId ?? project.compositionOrder[0] ?? null;
      set({ history: h, project, lastTx: null, compId, screen: "studio", step: "animate", time: 0, playing: false, range: null, filePath: path, savedAt: null, dirty: false, selection: { regionIds: [], recipeId: null, layerId: null } });
    },

    apply(ops, opts = {}) {
      const h = get().history;
      if (!h) return null;
      const scope = agentScope;
      try {
        const tx = h.apply(ops, scope ? { ...opts, source: "agent", group: scope.group } : opts);
        if (scope && !scope.txIds.includes(tx.id)) scope.txIds.push(tx.id);
        return tx;
      } catch (e) {
        const msg = e instanceof OpError ? e.userMessage : "Something went wrong applying that change. Nothing was changed.";
        if (scope) scope.errors.push(`${msg}${e instanceof OpError && e.message !== e.userMessage ? ` (${e.message})` : ""}`);
        else if (!opts.quiet) get().toast({ kind: "error", text: msg, details: String((e as Error)?.message ?? e) });
        return null;
      }
    },

    undo() {
      const tx = get().history?.undo();
      if (tx) get().toast({ kind: "info", text: `Undid “${tx.label}”` });
    },
    redo() {
      const tx = get().history?.redo();
      if (tx) get().toast({ kind: "info", text: `Redid “${tx.label}”` });
    },
    setStep(step) {
      set({ step });
    },
    setTime(t) {
      const { project, compId } = get();
      const comp = project && compId ? project.compositions[compId] : undefined;
      if (!comp) return;
      set({ time: Math.max(0, Math.min(comp.duration - 1, snapToFrame(t, comp.frameRate))) });
    },
    setPlaying(playing) {
      set({ playing });
    },
    setLoop(loop) {
      set({ loop });
    },
    setRange(range) {
      const c = currentComp(get());
      if (range && c) {
        const start = Math.max(0, Math.min(range.start, range.end));
        const end = Math.min(c.duration, Math.max(range.start, range.end));
        set({ range: end - start >= frameToTime(1, c.frameRate) ? { start, end } : null });
      } else set({ range: null });
    },
    stepFrames(n) {
      const c = currentComp(get());
      if (!c) return;
      set({ playing: false });
      get().setTime(snapToFrame(get().time, c.frameRate) + frameToTime(n, c.frameRate));
    },
    restart() {
      set({ time: get().range?.start ?? 0 });
    },
    selectRegions(ids, additive = false) {
      const cur = get().selection.regionIds;
      const next = additive ? (ids.every((i) => cur.includes(i)) ? cur.filter((i) => !ids.includes(i)) : [...new Set([...cur, ...ids])]) : [...ids];
      set({ selection: { regionIds: next, recipeId: null, layerId: null } });
    },
    selectRecipe(recipeId) {
      set((s) => ({ selection: { regionIds: recipeId ? [] : s.selection.regionIds, recipeId, layerId: null } }));
    },
    selectLayer(layerId) {
      set({ selection: { regionIds: [], recipeId: null, layerId } });
    },
    setHover(hoverRegionId) {
      if (get().hoverRegionId !== hoverRegionId) set({ hoverRegionId });
    },
    toast(t) {
      // During an agent call, messages go back to the agent (the call shows one summary toast).
      if (agentScope) {
        (t.kind === "error" ? agentScope.errors : agentScope.notes).push(t.text);
        return;
      }
      const id = ++toastId;
      set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
      if (t.kind !== "error") setTimeout(() => get().dismissToast(id), 3200);
    },
    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
    },
    setExportOpen(exportOpen) {
      set({ exportOpen, ...(exportOpen ? { playing: false } : {}) });
    },
    setShowGrid(showGrid) {
      set({ showGrid });
    },
    setPreviewStats(previewScale, previewMs) {
      const s = get();
      if (s.previewScale !== previewScale || Math.abs(s.previewMs - previewMs) > 2) set({ previewScale, previewMs });
    },
    previewOps(ops) {
      const h = get().history;
      if (!h || !ops) {
        if (get().hoverPreview) set({ hoverPreview: null });
        return;
      }
      try {
        set({ hoverPreview: h.preview(ops) });
      } catch {
        set({ hoverPreview: null });
      }
    },
    markSaved(path, at) {
      get().history?.markSaved();
      set({ filePath: path, savedAt: at, dirty: false });
    },
  };
});

/** Convenience selectors */
export const currentComp = (s: Pick<StudioState, "project" | "compId">) => (s.project && s.compId ? s.project.compositions[s.compId] : undefined);
export const activeVenue = (s: Pick<StudioState, "project">) => (s.project?.activeVenueId ? s.project.venues[s.project.activeVenueId] : undefined);
