/**
 * House lights: the flames on the building (candles at its foot, a torch in a lantern), part of the
 * house setup (Venue.lights) and so shared by the whole show. Each is a warm point light with its own
 * steady flicker, worked out from show time (the same noise as a layer's wiggle, so a light and the
 * flame layer drawn for it flicker together, and preview, export and an outside renderer that uses the
 * same formula agree). Every 3D scene of the venue is lit by them (unless it opts out) — its pieces,
 * models and characters catch the candlelight and the house's solids cast shadows from it.
 *
 * Where a light is: the canvas point where its flame shows, and how far in front of the building's
 * front (metres; negative: set back, like a candle on a recessed window sill). Each 3D scene places it
 * on its own camera's line through that point, so it sits on the flame whichever camera the scene uses.
 */
import { evalKeyframes, type AnimProp } from "./anim.ts";
import type { Id, RGBA } from "./model.ts";
import { wiggle1 } from "./rng.ts";
import { FLICKS_PER_SECOND, type Flicks } from "./time.ts";

export interface HouseLight {
  readonly id: Id;
  readonly name: string;
  /** Where its flame shows on the venue canvas (pixels). */
  readonly at: readonly [number, number];
  /** Metres in front of the building's front (negative: set back into it). */
  readonly depth: number;
  /** sRGB, a warm flame by default. */
  readonly color: RGBA;
  /**
   * Brightness over the show (in the units of a 3D point light), keyframed for scene changes: 0 while
   * it's out, rising as it's lit. Absent keyframes: steady.
   */
  readonly intensity: AnimProp<number>;
  /** Metres beyond which it lights nothing (fading smoothly to it); 0: no limit. */
  readonly range: number;
  /** How it weakens with distance (2 as real light). */
  readonly falloff: number;
  readonly castShadow: boolean;
  /** Soft shadow edge, 0..1. */
  readonly softness: number;
  /**
   * Its flicker: brightness × (1 + wiggle(speed, amount, octaves, seed)) at show time — `amount` as a
   * fraction of the brightness. The same wiggle as a flame layer's opacity wiggle with
   * amount = wiggle amount / opacity: the two then rise and dip together.
   */
  readonly flicker: { readonly amount: number; readonly speed: number; readonly seed: number; readonly octaves: number };
  /**
   * Instead of the wiggle: follow a measured brightness curve (e.g. the light of candles filmed in a
   * looping video: sampled from it), `values` per `fps`, repeating, its first sample at show time
   * `start` seconds (where the video's layer starts) — so the light rises and dips with the flames seen
   * in the footage. Values are factors around 1.
   */
  readonly curve?: { readonly start: number; readonly fps: number; readonly values: readonly number[] };
}

/** A candle's defaults (warm, local, soft shadows, a gentle flicker). */
export const HOUSE_LIGHT_DEFAULTS: Omit<HouseLight, "id" | "name" | "at" | "depth" | "intensity"> = {
  color: [1, 0.62, 0.3, 1],
  range: 6,
  falloff: 2,
  castShadow: true,
  softness: 0.6,
  flicker: { amount: 0.12, speed: 7, seed: 1, octaves: 2 },
};

/** The flicker factor alone at show time (1 = its keyframed brightness). */
export const houseLightFlicker = (f: HouseLight["flicker"], showTime: Flicks): number =>
  f.amount > 0 ? Math.max(0, 1 + wiggle1(showTime / FLICKS_PER_SECOND, f.speed, f.amount, f.seed, 0, Math.max(1, Math.floor(f.octaves)))) : 1;

/** A measured flicker curve at show time (linear between samples, repeating). */
export const houseLightCurve = (c: NonNullable<HouseLight["curve"]>, showTime: Flicks): number => {
  const n = c.values.length;
  if (!n) return 1;
  const x = ((showTime / FLICKS_PER_SECOND - c.start) * c.fps) % n;
  const u = x < 0 ? x + n : x;
  const i = Math.floor(u);
  const f = u - i;
  return Math.max(0, c.values[i % n]! * (1 - f) + c.values[(i + 1) % n]! * f);
};

/** A house light's brightness at show time: its keyframes times its flicker or curve (never below 0). */
export const houseLightLevel = (L: Pick<HouseLight, "intensity" | "flicker" | "curve">, showTime: Flicks): number =>
  Math.max(0, evalKeyframes(L.intensity, showTime)) * (L.curve ? houseLightCurve(L.curve, showTime) : houseLightFlicker(L.flicker, showTime));

/**
 * Where a house light is in a 3D scene's frame: on the line from `eye` through its canvas point
 * (`through`: that point on the building's front, z = 0, in the scene's frame), at z = depth.
 */
export const houseLightPlace = (eye: readonly [number, number, number], through: readonly [number, number, number], depth: number): [number, number, number] => {
  const d = [through[0] - eye[0], through[1] - eye[1], through[2] - eye[2]];
  const k = Math.abs(d[2]!) > 1e-9 ? (depth - eye[2]) / d[2]! : 1;
  return [eye[0] + d[0]! * k, eye[1] + d[1]! * k, eye[2] + d[2]! * k];
};
