/**
 * An alignment point being dragged. While the mouse moves, only the point's position goes to the
 * previews and projector outputs (every window draws its warp from it at once); the edit itself is
 * made once, when the point is let go. Moving a point used to make an edit — a full project copy to
 * every window and a redraw of the whole editor — on every mouse move.
 */
import type { Project } from "@be/core";

export interface LivePin {
  readonly venueId: string;
  readonly projectorId: string;
  readonly pointId: string;
  readonly output: readonly [number, number];
}

const CHANNEL = "be-live-pin";
let live: LivePin | null = null;
/** Let go in another window: shown until this window's copy of the project has the edit (it comes separately). */
let releasing: { pin: LivePin; until: number } | null = null;
let version = 0;
const listeners = new Set<() => void>();
const ch = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);

// Previews redraw when the version changes (it's part of what they check each frame).
const changed = () => {
  version++;
  for (const fn of listeners) fn();
};

ch?.addEventListener("message", (e) => {
  const pin = e.data as LivePin | null;
  if (!pin && live) releasing = { pin: live, until: performance.now() + 1500 };
  else if (pin) releasing = null;
  live = pin;
  changed();
});

/** Move the point being dragged (null: let go — the edit has been made). */
export const setLivePin = (pin: LivePin | null): void => {
  live = pin;
  ch?.postMessage(pin);
  changed();
};

export const livePin = (): LivePin | null => live;
export const livePinVersion = (): number => version;
export const onLivePin = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** The project as shown: with the point being dragged where it is now (a copy along that path only). */
export const withLivePin = (project: Project): Project => {
  if (releasing) {
    const pr = project.venues[releasing.pin.venueId]?.projectors[releasing.pin.projectorId];
    const at = pr?.calibration.points.find((p) => p.id === releasing!.pin.pointId)?.output;
    if (!at || (at[0] === releasing.pin.output[0] && at[1] === releasing.pin.output[1]) || performance.now() > releasing.until) {
      releasing = null;
      version++;
    }
  }
  const pin = live ?? releasing?.pin;
  const pr = pin ? project.venues[pin.venueId]?.projectors[pin.projectorId] : undefined;
  if (!pin || !pr) return project;
  const points = pr.calibration.points.map((p) => (p.id === pin.pointId ? { ...p, output: [pin.output[0], pin.output[1]] as [number, number] } : p));
  const venue = project.venues[pin.venueId]!;
  return {
    ...project,
    venues: { ...project.venues, [pin.venueId]: { ...venue, projectors: { ...venue.projectors, [pin.projectorId]: { ...pr, calibration: { ...pr.calibration, points } } } } },
  };
};
