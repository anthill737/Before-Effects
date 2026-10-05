/**
 * The frames a preview plays, as After Effects' Range setting: the work area (the preview range set
 * with Range start / end), the work area extended to take in the playhead, the entire duration, or a
 * stretch round the playhead. Pure (unit-tested).
 */
import { type Flicks, frameToTime } from "@be/core";

export interface RangeSettings {
  readonly previewRange: "workarea-extended" | "workarea" | "entire" | "around";
  readonly aroundBefore: number;
  readonly aroundAfter: number;
}

/** The frames a preview plays (see PreviewSettings.previewRange), with the work area (preview range) as set. */
export const rangeFor = (comp: { duration: Flicks; frameRate: { num: number; den: number } }, t: Flicks, workArea: { start: Flicks; end: Flicks } | null, s: RangeSettings): { start: Flicks; end: Flicks } => {
  const whole = { start: 0, end: comp.duration };
  const wa = workArea ?? whole;
  const one = frameToTime(1, comp.frameRate);
  switch (s.previewRange) {
    case "entire":
      return whole;
    case "workarea":
      return wa;
    case "around": {
      const a = Math.max(0, t - Math.round(s.aroundBefore * 705_600_000));
      const b = Math.min(comp.duration, t + Math.round(s.aroundAfter * 705_600_000));
      return { start: a, end: Math.max(a + one, b) };
    }
    default:
      // Extended by the playhead: from it to the work area's end when it's before, to it when after.
      if (t < wa.start) return { start: t, end: wa.end };
      if (t >= wa.end) return { start: wa.start, end: Math.min(comp.duration, t + one) };
      return wa;
  }
};

