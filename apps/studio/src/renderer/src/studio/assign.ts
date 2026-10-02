/**
 * Assigning content to building areas — the main way to build a scene:
 *   drag a picture, video, or effect onto an area (in the preview or the area list) → it appears
 *   there at once, clipped to the area. With several areas selected, choose "Repeat in each area"
 *   or "Span across areas".
 *
 * Assignments belong to the current scene; the areas are shared by every scene.
 */
import { getRecipe, newId, type RecipeInstance, type RegionRef, resolveTargets, snapToFrame } from "@be/core";
import { create } from "zustand";
import { applyEffect, applyRecipeToSelection } from "./actions.ts";
import { COLLAPSE_EFFECT, makeArea3D } from "./actions3d.ts";
import { activeVenue, currentComp, useStudio } from "./store.ts";

export const DRAG_ASSET = "application/x-be-asset";
export const DRAG_EFFECT = "application/x-be-effect";

export type DragPayload = { kind: "asset"; id: string } | { kind: "effect"; id: string };

export const setDragPayload = (e: React.DragEvent, p: DragPayload) => {
  e.dataTransfer.setData(p.kind === "asset" ? DRAG_ASSET : DRAG_EFFECT, p.id);
  e.dataTransfer.setData("text/plain", `${p.kind}:${p.id}`);
  e.dataTransfer.effectAllowed = "copy";
};

export const readDragPayload = (dt: DataTransfer): DragPayload | null => {
  const a = dt.getData(DRAG_ASSET);
  if (a) return { kind: "asset", id: a };
  const f = dt.getData(DRAG_EFFECT);
  if (f) return { kind: "effect", id: f };
  const t = dt.getData("text/plain");
  const m = /^(asset|effect):(.+)$/.exec(t);
  return m ? { kind: m[1] as "asset" | "effect", id: m[2]! } : null;
};

export const isContentDrag = (dt: DataTransfer) => dt.types.includes(DRAG_ASSET) || dt.types.includes(DRAG_EFFECT);

/** Waiting for "Repeat in each area" or "Span across areas". */
export const useDropChoice = create<{ pending: { payload: DragPayload; areaIds: string[]; x: number; y: number } | null }>(() => ({ pending: null }));

/** How to refer to a set of areas: a named group if it matches one exactly, else the areas themselves. */
export const refForAreas = (areaIds: readonly string[]): RegionRef => {
  const s = useStudio.getState();
  const venue = s.project ? activeVenue({ project: s.project }) : undefined;
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const group = venue ? Object.values(venue.groups).find((g) => same(g.regionIds, areaIds)) : undefined;
  return group ? { role: group.name, groupId: group.id } : { role: "areas", regionIds: [...areaIds] };
};

/** Put a picture or video into areas. Returns the new assignment's id. */
export const assignMedia = (assetId: string, areaIds: readonly string[], mode: "each" | "across", extra: Record<string, unknown> = {}): string | null => {
  const s = useStudio.getState();
  const comp = currentComp(s);
  const asset = s.project?.assets[assetId];
  if (!comp || !asset || !areaIds.length) return null;
  if (asset.kind === "audio") {
    s.toast({ kind: "info", text: "Music and sound go on the timeline (Add to the show), not into an area." });
    return null;
  }
  const id = newId("rcp");
  let start = snapToFrame(s.time, comp.frameRate);
  if (comp.duration - start < 2 * 705_600_000) start = 0;
  const tx = s.apply(
    { type: "recipe.apply", args: { instanceId: id, recipeId: "area-content", compId: comp.id, targets: [refForAreas(areaIds)], startTime: start, label: asset.name, params: { assetId, mode, ...extra } } },
    { label: `Put ${asset.name} in ${areaIds.length > 1 ? `${areaIds.length} areas` : "an area"}` },
  );
  if (!tx) return null;
  useStudio.setState({ selection: { regionIds: [], recipeId: id, layerId: null } });
  return id;
};

/** Drop handling: one area → assign at once; several selected areas → ask repeat or span. */
export const dropOnArea = async (payload: DragPayload, areaId: string, at: { x: number; y: number }) => {
  const s = useStudio.getState();
  const sel = s.selection.regionIds;
  const areaIds = sel.includes(areaId) && sel.length > 1 ? [...sel] : [areaId];
  if (areaIds.length > 1 && (payload.kind === "asset" || payload.kind === "effect")) {
    useDropChoice.setState({ pending: { payload, areaIds, x: at.x, y: at.y } });
    return;
  }
  await finishDrop(payload, areaIds, "each");
};

export const finishDrop = async (payload: DragPayload, areaIds: string[], mode: "each" | "across") => {
  useDropChoice.setState({ pending: null });
  if (payload.kind === "asset") return assignMedia(payload.id, areaIds, mode);
  if (payload.id === COLLAPSE_EFFECT.id) return makeArea3D(areaIds, true);
  const def = getRecipe(payload.id);
  if (!def) return null;
  useStudio.getState().selectRegions(areaIds);
  // Effects work on all the chosen areas together; "repeat" gives each area its own copy of the effect.
  if (mode === "each" && areaIds.length > 1) {
    let last: string | null = null;
    for (const id of areaIds) last = applyRecipeToSelection(payload.id, [id]);
    return last;
  }
  return applyEffect(payload.id);
};

/** Assignments in the current scene that cover an area (top-most first). */
export const contentForArea = (areaId: string): RecipeInstance[] => {
  const s = useStudio.getState();
  const comp = currentComp(s);
  if (!s.project || !comp) return [];
  const insts = Object.values(s.project.recipes).filter((r) => r.compId === comp.id && resolveTargets(s.project!, r.targets).some((t) => t.region.id === areaId));
  const top = (r: RecipeInstance) => Math.min(...Object.values(r.generated).map((lid) => comp.layerOrder.indexOf(lid)).filter((i) => i >= 0), Infinity);
  return insts.sort((a, b) => top(a) - top(b));
};

/** Move an assignment's layers one step up (−1) or down (+1) among the scene's content. */
export const reorderAssignment = (instanceId: string, dir: -1 | 1) => {
  const s = useStudio.getState();
  const comp = currentComp(s);
  const inst = s.project?.recipes[instanceId];
  if (!comp || !inst) return;
  const mine = new Set(Object.values(inst.generated));
  const order = comp.layerOrder;
  const idx = order.map((id, i) => (mine.has(id) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return;
  const first = Math.min(...idx);
  const last = Math.max(...idx);
  // The neighbouring block: the next layer outside this assignment, plus the rest of its own assignment.
  const neighbourAt = dir < 0 ? first - 1 : last + 1;
  if (neighbourAt < 0 || neighbourAt >= order.length) return;
  const nb = comp.layers[order[neighbourAt]!]!;
  const nbInst = nb.generatedBy ? s.project!.recipes[nb.generatedBy.recipeInstanceId] : undefined;
  const nbSet = new Set(nbInst ? Object.values(nbInst.generated) : [nb.id]);
  const block = order.filter((id) => mine.has(id));
  const rest = order.filter((id) => !mine.has(id));
  const nbIdx = rest.map((id, i) => (nbSet.has(id) ? i : -1)).filter((i) => i >= 0);
  const insertAt = dir < 0 ? Math.min(...nbIdx) : Math.max(...nbIdx) + 1;
  const next = [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)];
  s.apply(
    next.map((layerId, index) => ({ type: "layer.move", args: { compId: comp.id, layerId, index } })),
    { label: dir < 0 ? "Bring forward" : "Send backward" },
  );
};

/** Copy an assignment (same content and settings) onto other areas, as a new assignment. */
export const copyAssignment = (instanceId: string, areaIds: readonly string[], mode?: "each" | "across"): string | null => {
  const s = useStudio.getState();
  const inst = s.project?.recipes[instanceId];
  if (!inst || !areaIds.length) return null;
  const id = newId("rcp");
  const params = { ...inst.params, ...(mode && inst.recipeId === "area-content" ? { mode } : {}) };
  const tx = s.apply(
    { type: "recipe.apply", args: { instanceId: id, recipeId: inst.recipeId, compId: inst.compId, targets: [refForAreas(areaIds)], startTime: inst.startTime, label: inst.label, params } },
    { label: `Copy “${inst.label}” to ${areaIds.length > 1 ? `${areaIds.length} areas` : "an area"}` },
  );
  return tx ? id : null;
};

/** Swap the picture or video, keeping placement, timing and every other setting. */
export const replaceMedia = (instanceId: string, assetId: string) => {
  const s = useStudio.getState();
  const asset = s.project?.assets[assetId];
  if (!asset) return;
  s.apply({ type: "recipe.update", args: { instanceId, params: { assetId }, label: asset.name } }, { label: `Replace with ${asset.name}` });
};
