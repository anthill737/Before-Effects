/**
 * Simple keyframe editing for any animatable property, as pure functions (the caller stores the
 * result through an operation, so every edit is undoable):
 *
 *   setPropAt     change a value: a static property just changes; an animated one gets (or
 *                 updates) a keyframe at the playhead — like After Effects with the stopwatch on.
 *   toggleKeyAt   add a keyframe at the playhead (starting animation) or remove the one there.
 *   moveKey       drag a keyframe in time.
 *   setKeyEase    how the motion leaves a keyframe toward the next: linear, ease, ease in, ease out,
 *                 or hold. Curves stay available underneath (speed/influence per side).
 */
import { type AnimProp, EASY_EASE, evalProp, type Keyframe, type PropValue } from "./anim.ts";
import { type Flicks, FLICKS_PER_SECOND } from "./time.ts";

export type EasePreset = "linear" | "ease" | "ease-in" | "ease-out" | "hold";
export const EASE_PRESETS: ReadonlyArray<{ id: EasePreset; label: string }> = [
  { id: "ease", label: "Smooth (ease in and out)" },
  { id: "linear", label: "Steady (linear)" },
  { id: "ease-in", label: "Start slowly" },
  { id: "ease-out", label: "Arrive slowly" },
  { id: "hold", label: "Jump (hold until the next key)" },
];

/** Keys closer than this to the playhead count as "at the playhead" (less than a frame at 120 fps). */
const NEAR = FLICKS_PER_SECOND / 240;

let keySeq = 0;
const keyId = (t: Flicks) => `k${Math.round(t / 1000).toString(36)}${(keySeq++ % 1296).toString(36)}`;

const dims = (v: PropValue) => (typeof v === "number" ? 1 : v.length);

export const keyAt = (p: AnimProp, t: Flicks): Keyframe | undefined => p.keyframes?.find((k) => Math.abs(k.t - t) <= NEAR);

const sorted = <V extends PropValue>(kfs: Keyframe<V>[]) => kfs.sort((a, b) => a.t - b.t);

/** A new keyframe with smooth (ease in and out) timing. */
const newKey = <V extends PropValue>(t: Flicks, v: V): Keyframe<V> => {
  const e = Array.from({ length: dims(v) }, () => EASY_EASE);
  return { id: keyId(t), t, v, in: "bezier", out: "bezier", easeIn: e, easeOut: e };
};

export const setPropAt = <V extends PropValue>(p: AnimProp<V>, t: Flicks, v: V): AnimProp<V> => {
  if (!p.keyframes?.length) return { ...p, value: v };
  const hit = keyAt(p, t);
  const kfs = hit ? p.keyframes.map((k) => (k === hit ? { ...k, v } : k)) : sorted([...p.keyframes, newKey(t, v)]);
  return { ...p, keyframes: kfs };
};

export const toggleKeyAt = <V extends PropValue>(p: AnimProp<V>, t: Flicks): AnimProp<V> => {
  const hit = p.keyframes?.find((k) => Math.abs(k.t - t) <= NEAR);
  if (hit) {
    const rest = p.keyframes!.filter((k) => k !== hit);
    if (rest.length) return { ...p, keyframes: rest };
    const { keyframes: _drop, ...plain } = p;
    return { ...plain, value: hit.v };
  }
  const v = evalProp(p, t) as V;
  return { ...p, keyframes: sorted([...(p.keyframes ?? []), newKey(t, v)]) };
};

export const moveKey = <V extends PropValue>(p: AnimProp<V>, id: string, t: Flicks): AnimProp<V> =>
  p.keyframes ? { ...p, keyframes: sorted(p.keyframes.map((k) => (k.id === id ? { ...k, t: Math.max(0, Math.round(t)) } : k))) } : p;

export const setKeyEase = <V extends PropValue>(p: AnimProp<V>, id: string, preset: EasePreset): AnimProp<V> => {
  const kfs = p.keyframes;
  if (!kfs) return p;
  const i = kfs.findIndex((k) => k.id === id);
  if (i < 0) return p;
  const e = (v: PropValue) => Array.from({ length: dims(v) }, () => EASY_EASE);
  const slowOut = preset === "ease" || preset === "ease-in";
  const slowIn = preset === "ease" || preset === "ease-out";
  return {
    ...p,
    keyframes: kfs.map((k, j) => {
      if (j === i) {
        const { easeOut: _o, ...rest } = k;
        return preset === "hold" ? { ...rest, out: "hold" as const } : slowOut ? { ...rest, out: "bezier" as const, easeOut: e(k.v) } : { ...rest, out: "linear" as const };
      }
      if (j === i + 1 && preset !== "hold") {
        const { easeIn: _i, ...rest } = k;
        return slowIn ? { ...rest, in: "bezier" as const, easeIn: e(k.v) } : { ...rest, in: "linear" as const };
      }
      return k;
    }),
  };
};

/** The preset that describes how motion leaves this keyframe (for showing the current choice). */
export const keyEase = (p: AnimProp, id: string): EasePreset => {
  const kfs = p.keyframes ?? [];
  const i = kfs.findIndex((k) => k.id === id);
  const k = kfs[i];
  if (!k) return "linear";
  if (k.out === "hold") return "hold";
  const next = kfs[i + 1];
  const outSlow = k.out === "bezier";
  const inSlow = next?.in === "bezier";
  return outSlow && inSlow ? "ease" : outSlow ? "ease-in" : inSlow ? "ease-out" : "linear";
};

/**
 * A custom curve between a keyframe and the next: how far the slow-down reaches when leaving
 * (`leave`) and when arriving (`arrive`), each 0..1 of the way (0 = no easing on that side).
 */
export const setKeyCurve = <V extends PropValue>(p: AnimProp<V>, id: string, leave: number, arrive: number): AnimProp<V> => {
  const kfs = p.keyframes;
  if (!kfs) return p;
  const i = kfs.findIndex((k) => k.id === id);
  if (i < 0) return p;
  const e = (v: PropValue, influence: number) => Array.from({ length: dims(v) }, () => ({ speed: 0, influence: Math.min(1, Math.max(0.01, influence)) }));
  return {
    ...p,
    keyframes: kfs.map((k, j) => {
      if (j === i) {
        const { easeOut: _o, ...rest } = k;
        return leave > 0 ? { ...rest, out: "bezier" as const, easeOut: e(k.v, leave) } : { ...rest, out: "linear" as const };
      }
      if (j === i + 1) {
        const { easeIn: _i, ...rest } = k;
        return arrive > 0 ? { ...rest, in: "bezier" as const, easeIn: e(k.v, arrive) } : { ...rest, in: "linear" as const };
      }
      return k;
    }),
  };
};

/** The current curve after a keyframe as { leave, arrive } influences (0 = no easing on that side). */
export const keyCurve = (p: AnimProp, id: string): { leave: number; arrive: number } => {
  const kfs = p.keyframes ?? [];
  const i = kfs.findIndex((k) => k.id === id);
  const k = kfs[i], next = kfs[i + 1];
  return {
    leave: k?.out === "bezier" ? (k.easeOut?.[0]?.influence ?? EASY_EASE.influence) : 0,
    arrive: next?.in === "bezier" ? (next.easeIn?.[0]?.influence ?? EASY_EASE.influence) : 0,
  };
};
