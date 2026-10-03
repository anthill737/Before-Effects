/**
 * Several projectors in the studio: which one the preview's "Projector output" view, the alignment
 * points and exports refer to (a viewing choice, not saved), adding and removing projectors, and a
 * quick side-by-side / stacked arrangement to start aligning from.
 */
import { arrangeProjectors, newProjector, type Op, type Projector, type Venue } from "@be/core";
import { create } from "zustand";
import { useStudio } from "./store.ts";

/** The projector being looked at and aligned (null = the first). */
export const useProjectorPick = create<{ id: string | null }>(() => ({ id: null }));

export const currentProjector = (venue: Venue | undefined, id = useProjectorPick.getState().id): Projector | undefined => {
  if (!venue) return undefined;
  return (id ? venue.projectors[id] : undefined) ?? (venue.projectorOrder[0] ? venue.projectors[venue.projectorOrder[0]] : undefined);
};

/** Hook form: re-renders when the pick changes. */
export const useCurrentProjector = (venue: Venue | undefined): Projector | undefined => currentProjector(venue, useProjectorPick((s) => s.id));

export const addProjector = (venue: Venue): string | null => {
  const last = venue.projectorOrder.length ? venue.projectors[venue.projectorOrder.at(-1)!] : undefined;
  const p = newProjector(venue, { name: `Projector ${venue.projectorOrder.length + 1}`, width: last?.output.width ?? 1920, height: last?.output.height ?? 1080 });
  const tx = useStudio.getState().apply({ type: "projector.add", args: { venueId: venue.id, projector: p } }, { label: `Add ${p.name}` });
  if (!tx) return null;
  useProjectorPick.setState({ id: p.id });
  return p.id;
};

export const removeProjector = (venue: Venue, projectorId: string) => {
  const p = venue.projectors[projectorId];
  if (!p) return;
  useStudio.getState().apply({ type: "projector.remove", args: { venueId: venue.id, projectorId } }, { label: `Remove ${p.name}` });
  if (useProjectorPick.getState().id === projectorId) useProjectorPick.setState({ id: null });
};

/** Starting alignment: the picture split between the projectors with an overlap to blend. Skips locked ones. */
export const arrangeAll = (venue: Venue, layout: "side-by-side" | "stacked", overlap: number) => {
  const list = venue.projectorOrder.map((id) => venue.projectors[id]!).filter(Boolean);
  const locked = list.filter((p) => p.calibration.locked);
  if (locked.length) {
    useStudio.getState().toast({ kind: "error", text: `Unlock the alignment of ${locked.map((p) => p.name).join(", ")} first.` });
    return;
  }
  const pts = arrangeProjectors(venue.canvas, list.map((p) => p.output), layout, overlap);
  const ops: Op[] = list.map((p, i) => ({ type: "calibration.setPoints", args: { venueId: venue.id, projectorId: p.id, mode: "corner-pin", points: pts[i]! } }));
  useStudio.getState().apply(ops, { label: layout === "side-by-side" ? "Arrange projectors side by side" : "Arrange projectors one above the other" });
};
