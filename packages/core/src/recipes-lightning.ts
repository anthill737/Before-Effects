/**
 * "Lightning & thunder": strikes that light the chosen areas in a flicker (two or three flashes over
 * a second, like real lightning), a bolt on the house, and thunder a moment later. Ordinary layers,
 * all editable afterwards.
 *
 * The flash: by default the house itself goes white — a bright, nearly grey picture of the house
 * (made from the building photo, or the person's own, e.g. a white house skin) shown in the areas
 * with its opacity flickering, the way projection shows usually do it. Or coloured light.
 *
 * The bolt: pieces of a bolt placed on the house that move to a new spot every flicker (like a
 * lightning clip cut up and placed), one of four drawn styles, or the person's own lightning clip —
 * a different moment of it each flicker, placed, tilted and moved about the house.
 *
 * Two sounds per strike: the crack of the strike right as the bolt hits, and thunder a moment later.
 * Each can be the person's own recording; by default each plays its recording's biggest hit (found by
 * the sound analysis), so a file with silence before the crack still lands on the flash.
 *
 * Bolt styles: Single strike (one bolt to the ground, a few branches) · Energetic burst (a bolt that
 * branches like a tree and changes shape as it flickers) · Jagged burst (a knot of crackling arcs in
 * one spot) · Crazy strike (arcs crawling around a point).
 */
import { type AnimProp, type Keyframe, staticProp } from "./anim.ts";
import { type Asset, type AudioSettings, defaultTransform, type EffectInstance, type Layer, type Mask, packPath, polygonPath, type RGBA, type ShapeContents, type Vec2 } from "./model.ts";
import { type Bounds, pathBounds } from "./pathmath.ts";
import { type RecipeContext, type RecipeDef, registerRecipe } from "./recipes.ts";
import { SeededStream } from "./rng.ts";
import { type Flicks, secondsToTime, timeToSeconds } from "./time.ts";

const sec = (s: number): Flicks => secondsToTime(s);
const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const color = (v: unknown, d: RGBA): RGBA => (Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === "number") ? (v as unknown as RGBA) : d);

export type BoltStyle = "pieces" | "single" | "energetic" | "jagged" | "crazy";

/** A jagged line from a to b: the middle pushed sideways again and again (midpoint displacement). */
const jag = (a: Vec2, b: Vec2, rough: number, depth: number, rng: SeededStream): Vec2[] => {
  let pts: Vec2[] = [a, b];
  for (let d = 0; d < depth; d++) {
    const next: Vec2[] = [pts[0]!];
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i]!, q = pts[i + 1]!;
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const nx = -(q[1] - p[1]) / (len || 1), ny = (q[0] - p[0]) / (len || 1);
      const off = (rng.next() * 2 - 1) * len * rough;
      next.push([(p[0] + q[0]) / 2 + nx * off, (p[1] + q[1]) / 2 + ny * off], q);
    }
    pts = next;
  }
  return pts;
};

/**
 * The strokes of one look of a bolt (canvas pixels): the main channel first, then branches.
 * `variant` gives a different look of the same strike (the shapes change between flickers).
 */
export const boltStrokes = (style: BoltStyle, box: Bounds, from: "random" | "left" | "centre" | "right", seed: number, strike: number, variant: number): Vec2[][] => {
  const W = box.w, H = box.h, x0 = box.x, y0 = box.y;
  const base = new SeededStream(seed, 1000 + strike);
  const fx = from === "left" ? 0.2 : from === "right" ? 0.8 : from === "centre" ? 0.5 : 0.15 + 0.7 * base.next();
  const rng = new SeededStream(seed, 2000 + strike * 37 + (style === "single" ? 0 : variant));
  const out: Vec2[][] = [];
  if (style === "pieces") {
    // A piece of a bolt high on the house slanting down to one side, in a new place each flicker.
    const r = new SeededStream(seed, 4000 + strike * 37 + variant);
    const start: Vec2 = [x0 + W * (variant === 0 ? fx : 0.12 + 0.76 * r.next()), y0 + H * (0.02 + 0.3 * r.next())];
    const side = r.next() < 0.5 ? -1 : 1;
    const ang = Math.PI / 2 - side * (0.35 + 0.45 * r.next());
    const len = H * (0.4 + 0.35 * r.next());
    const main = jag(start, [start[0] + Math.cos(ang) * len, start[1] + Math.sin(ang) * len], 0.18, 6, r);
    out.push(main);
    for (let b = 1 + Math.floor(r.next() * 2); b > 0; b--) {
      const at = main[Math.floor((0.2 + 0.6 * r.next()) * (main.length - 1))]!;
      const a2 = ang + (r.next() < 0.5 ? -1 : 1) * (0.4 + 0.5 * r.next());
      const l2 = len * (0.12 + 0.2 * r.next());
      out.push(jag(at, [at[0] + Math.cos(a2) * l2, at[1] + Math.sin(a2) * l2], 0.3, 4, r));
    }
    return out;
  }
  if (style === "single" || style === "energetic") {
    const top: Vec2 = [x0 + W * fx, y0 - H * 0.12];
    const ground: Vec2 = [top[0] + W * (base.next() - 0.5) * 0.3, y0 + H];
    const main = jag(top, ground, 0.2, 7, rng);
    out.push(main);
    const branches = style === "single" ? 2 + Math.floor(rng.next() * 2) : 6 + Math.floor(rng.next() * 4);
    for (let b = 0; b < branches; b++) {
      const at = main[Math.floor((0.12 + 0.6 * rng.next()) * (main.length - 1))]!;
      const side = rng.next() < 0.5 ? -1 : 1;
      const len = H * (style === "single" ? 0.12 + 0.18 * rng.next() : 0.15 + 0.3 * rng.next());
      const ang = Math.PI / 2 + side * (0.35 + 0.7 * rng.next());
      const end: Vec2 = [at[0] + Math.cos(ang) * len, at[1] + Math.sin(ang) * len];
      const br = jag(at, end, 0.28, 5, rng);
      out.push(br);
      if (style === "energetic" && rng.next() < 0.5) {
        const at2 = br[Math.floor((0.3 + 0.4 * rng.next()) * (br.length - 1))]!;
        const a2 = ang + side * (0.3 + 0.5 * rng.next());
        out.push(jag(at2, [at2[0] + Math.cos(a2) * len * 0.5, at2[1] + Math.sin(a2) * len * 0.5], 0.3, 4, rng));
      }
    }
    return out;
  }
  // Arcs around a point: one knot (jagged burst) or two or three that crawl about (crazy strike).
  const knots = style === "jagged" ? 1 : 2 + Math.floor(base.next() * 2);
  for (let k = 0; k < knots; k++) {
    const kr = new SeededStream(seed, 3000 + strike * 11 + k);
    const drift = style === "crazy" ? variant * 0.06 : 0;
    const c: Vec2 = [x0 + W * Math.min(0.92, Math.max(0.08, fx + (kr.next() - 0.5) * 0.4 + drift * (kr.next() - 0.5) * 4)), y0 + H * (0.25 + 0.55 * kr.next())];
    const arcs = 3 + Math.floor(rng.next() * 3);
    for (let a = 0; a < arcs; a++) {
      const ang = rng.next() * Math.PI * 2;
      const len = Math.min(W, H) * (style === "jagged" ? 0.05 + 0.08 * rng.next() : 0.06 + 0.12 * rng.next());
      out.push(jag(c, [c[0] + Math.cos(ang) * len, c[1] + Math.sin(ang) * len], 0.38, 5, rng));
    }
  }
  return out;
};

/** When each strike happens (seconds from the effect's start). */
export const strikeTimes = (count: number, firstAt: number, every: number, seed: number): number[] => {
  const rng = new SeededStream(seed, 5000);
  const out: number[] = [];
  let t = firstAt;
  for (let i = 0; i < count; i++) {
    out.push(t);
    t += Math.max(0.8, every * (0.65 + 0.7 * rng.next()));
  }
  return out;
};

/** A strike's flickers: [offset seconds, brightness 0..1]. The first is the brightest, then dimmer, then one more. */
export const flickers = (count: number, seed: number, strike: number): Array<[number, number]> => {
  const rng = new SeededStream(seed, 6000 + strike);
  const out: Array<[number, number]> = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    out.push([t, i === 0 ? 1 : i % 2 ? 0.45 + 0.2 * rng.next() : 0.7 + 0.25 * rng.next()]);
    t += 0.3 + 0.2 * rng.next();
  }
  return out;
};

export type SoundPart = "hit" | "each" | "start";

/**
 * Where to start playing a sound, and the most it may play before running into its next hit:
 * its biggest hit, a different hit for each strike (loudest first), or a set time.
 */
export const soundPart = (asset: Asset, part: SoundPart, start: number, strike: number): { from: number; until: number } => {
  const all = timeToSeconds(asset.meta.duration ?? sec(600));
  const hits = asset.analysis?.hits ?? [];
  if (part === "start" || !hits.length) return { from: Math.min(start, Math.max(0, all - 0.2)), until: all };
  const byLevel = [...hits].sort((a, b) => b.level - a.level);
  const h = part === "each" ? byLevel[strike % byLevel.length]! : byLevel[0]!;
  const next = hits.find((x) => x.at > h.at);
  return { from: timeToSeconds(h.at), until: next ? timeToSeconds(next.at) : all };
};

const kf = (base: string, i: number, t: Flicks, v: number, interp: "linear" | "hold"): Keyframe<number> => ({ id: `${base}_${i}`, t, v, in: "linear", out: interp });
const keyed = (base: string, pts: Array<[Flicks, number, "linear" | "hold"]>): AnimProp<number> => {
  const sorted = pts.sort((a, b) => a[0] - b[0]).filter((p, i, a) => i === 0 || p[0] > a[i - 1]![0]);
  return { value: 0, keyframes: sorted.map(([t, v, e], i) => kf(base, i, t, v, e)) };
};

const glow = (amount: number, size: number): EffectInstance => ({ id: "glow", type: "glow", enabled: amount > 0, params: { radius: staticProp(size), intensity: staticProp(amount / 50), threshold: staticProp(0) } });

const shapeLayer = (ctx: RecipeContext, name: string, contents: ShapeContents[], effects: EffectInstance[], end: Flicks): Omit<Layer, "id" | "generatedBy"> => ({
  name,
  source: { kind: "shape", contents },
  startTime: 0,
  inPoint: ctx.startTime,
  outPoint: Math.max(end, ctx.startTime + 1),
  stretch: 1,
  enabled: true,
  solo: false,
  locked: false,
  audioEnabled: false,
  is3D: false,
  blendMode: "add",
  transform: defaultTransform(0, 0),
  masks: [],
  effects,
});

const PART_CHOICES = [
  { value: "hit", label: "Its biggest hit" },
  { value: "each", label: "A different hit each strike" },
  { value: "start", label: "From a set time" },
] as const;

const STYLE_CHOICES = [
  { value: "pieces", label: "Pieces on the house" },
  { value: "single", label: "Single strike" },
  { value: "energetic", label: "Energetic burst" },
  { value: "jagged", label: "Jagged burst" },
  { value: "crazy", label: "Crazy strike" },
] as const;

export const lightning: RecipeDef = {
  id: "lightning",
  title: "Lightning & thunder",
  category: "light",
  description: "Lightning strikes light up the house in a flicker, a bolt cracks down the front, and thunder rolls in a moment later.",
  keywords: ["lightning", "thunder", "storm", "strike", "bolt", "flash", "electric", "weather", "halloween", "spooky", "transition"],
  suits: ["wall", "roof", "roofline", "garage", "door", "window", "column", "custom"],
  defaultSeconds: 20,
  params: [
    { key: "look", label: "Flash", control: "choice", default: "house", choices: [{ value: "house", label: "The house goes white" }, { value: "light", label: "Coloured light" }], primary: true, help: "The house goes white: a bright picture of the house flickers in (its opacity keyed to each strike). Coloured light: the areas fill with the flash colour.", drives: ["source", "masks", "transform.opacity", "source.contents"] },
    { key: "style", label: "Bolt", control: "choice", default: "pieces", choices: STYLE_CHOICES, primary: true, help: "Pieces on the house: a piece of a bolt in a new spot every flicker. Single strike: one bolt to the ground. Energetic burst: branches like a tree. Jagged burst: a knot of crackling arcs. Crazy strike: arcs crawling about.", drives: ["source.contents"] },
    { key: "strikes", label: "Strikes", control: "slider", default: 3, min: 1, max: 30, step: 1, primary: true, drives: ["source.contents"] },
    { key: "every", label: "Time between strikes", control: "seconds", default: 6, min: 0.8, max: 60, step: 0.1, unit: "s", primary: true, help: "On average; each gap varies a little.", drives: ["source.contents"] },
    { key: "flash", label: "Flash brightness", control: "slider", default: 90, min: 0, max: 100, unit: "%", primary: true, help: "How strongly the flash shows at its brightest (0: only the bolt).", drives: ["source.contents", "transform.opacity"] },
    { key: "crack", label: "Crack of the strike", control: "toggle", default: true, primary: true, help: "A sound right as the bolt hits." },
    { key: "thunder", label: "Thunder", control: "toggle", default: true, primary: true, help: "Thunder rolling in after each strike." },
    { key: "flickers", label: "Flickers per strike", control: "slider", default: 3, min: 1, max: 6, step: 1, help: "Real lightning flashes two or three times in about a second.", drives: ["source.contents"] },
    { key: "firstAt", label: "First strike after", control: "seconds", default: 0.5, min: 0, max: 60, step: 0.1, unit: "s", drives: ["source.contents"] },
    { key: "flashPicture", label: "White house picture", control: "media", default: "", accepts: ["image", "video"], help: "For “The house goes white”: your own white picture of the house (lined up with the building), or the one Before Effects makes from the building photo.", drives: ["source"] },
    { key: "flashColor", label: "Flash colour", control: "color", default: [0.85, 0.9, 1, 1], help: "For “Coloured light”.", drives: ["source.contents"] },
    { key: "bolt", label: "Show the bolt", control: "toggle", default: true, drives: ["source.contents"] },
    { key: "moves", label: "Bolt moves each flicker", control: "toggle", default: true, help: "A new shape (and for pieces, a new place) every flicker.", drives: ["source.contents"] },
    { key: "boltClip", label: "Bolt from your clip", control: "media", default: "", accepts: ["video"], help: "Your own lightning video (a bolt on black): a different moment of it every flicker, placed, tilted and moved about the house. Leave empty for drawn bolts.", drives: ["source", "transform"] },
    { key: "clipSize", label: "Clip size", control: "slider", default: 110, min: 20, max: 300, unit: "%", help: "How tall the clip is, compared with the areas.", drives: ["transform.scale"] },
    { key: "clipTilt", label: "Clip tilt up to", control: "slider", default: 35, min: 0, max: 90, unit: "°", drives: ["transform.rotation"] },
    { key: "boltColor", label: "Bolt colour", control: "color", default: [0.88, 0.94, 1, 1], drives: ["source.contents"] },
    { key: "from", label: "Strikes from", control: "choice", default: "random", choices: [{ value: "random", label: "Anywhere" }, { value: "left", label: "Left" }, { value: "centre", label: "Centre" }, { value: "right", label: "Right" }], drives: ["source.contents"] },
    { key: "boltWidth", label: "Bolt width", control: "slider", default: 0, min: 0, max: 40, unit: "px", help: "0 picks a width that suits the scene size.", drives: ["source.contents"] },
    { key: "glow", label: "Bolt glow", control: "slider", default: 75, min: 0, max: 100, drives: ["effects.glow"] },
    { key: "crackSound", label: "Crack sound", control: "media", default: "", accepts: ["audio"], help: "Your own lightning recording, or the crack Before Effects makes." },
    { key: "crackPart", label: "Crack: play", control: "choice", default: "hit", choices: PART_CHOICES, help: "Its biggest hit lands right on the flash, even if the recording starts with silence." },
    { key: "crackStart", label: "Crack starts at", control: "seconds", default: 0, min: 0, max: 600, step: 0.1, unit: "s", help: "With “From a set time”: where in the recording to start." },
    { key: "crackLength", label: "Crack lasts up to", control: "seconds", default: 4, min: 0.3, max: 30, step: 0.1, unit: "s" },
    { key: "crackVolume", label: "Crack volume", control: "slider", default: -6, min: -30, max: 6, step: 0.5, unit: "dB" },
    { key: "thunderSound", label: "Thunder sound", control: "media", default: "", accepts: ["audio"], help: "Your own thunder recording, or the one Before Effects makes." },
    { key: "thunderPart", label: "Thunder: play", control: "choice", default: "hit", choices: PART_CHOICES, help: "A different hit each strike keeps a long storm from repeating itself." },
    { key: "thunderStart", label: "Thunder starts at", control: "seconds", default: 0, min: 0, max: 600, step: 0.1, unit: "s", help: "With “From a set time”: where in the recording to start." },
    { key: "thunderDelay", label: "Thunder after", control: "seconds", default: 1.4, min: 0, max: 8, step: 0.1, unit: "s", help: "Light arrives first; the farther the storm, the later the thunder (0: together)." },
    { key: "thunderLength", label: "Thunder lasts up to", control: "seconds", default: 7, min: 0.5, max: 30, step: 0.1, unit: "s", help: "It also stops before the recording's next hit." },
    { key: "thunderVolume", label: "Thunder volume", control: "slider", default: -3, min: -30, max: 6, step: 0.5, unit: "dB" },
    { key: "seed", label: "Variation", control: "seed", default: 1, drives: ["source.contents"] },
    { key: "seconds", label: "Duration", control: "seconds", default: 20, min: 1, max: 600, step: 0.5, unit: "s", drives: ["outPoint", "source.contents"] },
  ],
  generate: (ctx) => {
    const p = ctx.params;
    const seed = Math.round(num(p.seed, 1));
    const style = (STYLE_CHOICES.find((c) => c.value === p.style)?.value ?? "pieces") as BoltStyle;
    const seconds = num(p.seconds, 20);
    const end = Math.min(ctx.comp.duration, ctx.startTime + sec(seconds));
    const times = strikeTimes(Math.round(num(p.strikes, 3)), num(p.firstAt, 0.5), num(p.every, 6), seed).filter((t) => ctx.startTime + sec(t) < end);
    const nFlick = Math.max(1, Math.round(num(p.flickers, 3)));
    const flashB = Math.min(100, Math.max(0, num(p.flash, 90)));
    const diag = Math.hypot(ctx.comp.width, ctx.comp.height);
    const width = num(p.boltWidth, 0) > 0 ? num(p.boltWidth, 0) : Math.max(2, Math.round(diag * 0.0024));
    const at = (t: number) => ctx.startTime + sec(t);
    const out: Array<{ role: string; layer: Omit<Layer, "id" | "generatedBy"> }> = [];
    const from = (["random", "left", "centre", "right"] as const).find((f) => f === p.from) ?? "random";

    // Bolts: one layer per strike; each look visible during its flicker.
    const box = ctx.targets.length ? pathBounds(ctx.targets.map((t) => t.region.path)) : { x: 0, y: 0, w: ctx.comp.width, h: ctx.comp.height };
    const media = (key: string, kinds: readonly string[]): Asset | undefined => {
      const a = typeof p[key] === "string" ? ctx.project.assets[p[key] as string] : undefined;
      return a && !a.missing && kinds.includes(a.kind) ? a : undefined;
    };
    const clip = media("boltClip", ["video"]);
    const fixed = p.moves === false && (style === "single" || style === "energetic" || style === "pieces");
    const base = (name: string, blend: Layer["blendMode"]): Omit<Layer, "id" | "generatedBy" | "source"> => ({ ...shapeLayer(ctx, name, [], [], end), blendMode: blend });
    if (p.bolt !== false && clip) {
      // The person's lightning clip: a different moment of it each flicker, placed, tilted and moved.
      const cw = clip.meta.width ?? ctx.comp.width, ch = clip.meta.height ?? ctx.comp.height;
      const clipLen = clip.meta.duration ? timeToSeconds(clip.meta.duration) : 1.5;
      const size = (Math.max(10, num(p.clipSize, 110)) / 100) * box.h;
      const tilt = Math.max(0, Math.min(90, num(p.clipTilt, 35)));
      times.forEach((t, s) => {
        flickers(nFlick, seed, s).forEach(([o, b], v) => {
          const r = new SeededStream(seed, 8000 + s * 31 + (fixed ? 0 : v));
          const k = (size * (0.85 + 0.3 * r.next())) / ch;
          const pos: [number, number, number] = [box.x + box.w * (0.2 + 0.6 * r.next()), box.y + box.h * (0.25 + 0.3 * r.next()), 0];
          const rot = (r.next() * 2 - 1) * tilt;
          // Which moment of the clip shows (its middle part, where the bolts are).
          const moment = clipLen * (0.15 + 0.6 * r.next());
          const on = at(t + o);
          out.push({
            role: `bolt-${s}-${v}`,
            layer: {
              ...base(`Lightning bolt ${s + 1}.${v + 1}`, "screen"),
              source: { kind: "footage", assetId: clip.id },
              startTime: on - sec(moment),
              inPoint: on,
              outPoint: Math.min(ctx.comp.duration, on + sec(0.26)),
              transform: {
                ...defaultTransform(0, 0),
                anchor: staticProp<[number, number, number]>([cw / 2, ch / 2, 0]),
                position: staticProp(pos, true),
                scale: staticProp<[number, number, number]>([k * 100, k * 100, 100]),
                rotation: staticProp<[number, number, number]>([0, 0, rot]),
                opacity: keyed(`${ctx.instanceId}_c${s}_${v}`, [[on, 100 * Math.max(0.6, b), "linear"], [on + sec(0.12), 70 * b, "linear"], [on + sec(0.26), 0, "hold"]]),
              },
            },
          });
        });
      });
    } else if (p.bolt !== false)
      times.forEach((t, s) => {
        const fl = flickers(nFlick, seed, s);
        const looks = fixed ? 1 : fl.length;
        const contents: ShapeContents[] = [];
        for (let v = 0; v < looks; v++) {
          const strokes = boltStrokes(style, box, from, seed, s, fixed ? 0 : v);
          const showing = fixed ? fl : [fl[v]!];
          const pts: Array<[Flicks, number, "linear" | "hold"]> = [[ctx.startTime, 0, "hold"]];
          // The bolt shows as the flash fades a little, so it reads against the white house.
          for (const [o, b] of showing) pts.push([at(t + o) - 1, 0, "hold"], [at(t + o + 0.03), 100 * Math.max(0.6, b), "linear"], [at(t + o + 0.12), 70 * b, "linear"], [at(t + o + 0.24), 0, "hold"]);
          strokes.forEach((line, i) =>
            contents.push({
              path: { kind: "path", path: staticProp(packPath(polygonPath(line, false))) },
              stroke: { color: staticProp(color(p.boltColor, [0.88, 0.94, 1, 1])), width: staticProp(i === 0 && style !== "jagged" && style !== "crazy" ? width : width * 0.55), opacity: keyed(`${ctx.instanceId}_b${s}_${v}_${i}`, [...pts]), cap: "round", join: "round" },
            }),
          );
        }
        out.push({ role: `bolt-${s}`, layer: shapeLayer(ctx, `Lightning bolt ${s + 1}`, contents, [glow(num(p.glow, 75), width * 6)], end) });
      });

    // The flash: with every flicker, the house goes white (a picture, its opacity keyed) or fills with light.
    const flashPic = p.look !== "light" ? media("flashPicture", ["image", "video"]) : undefined;
    if (flashB > 0) {
      const pts: Array<[Flicks, number, "linear" | "hold"]> = [[ctx.startTime, 0, "hold"]];
      times.forEach((t, s) => {
        for (const [o, b] of flickers(nFlick, seed, s)) pts.push([at(t + o) - 1, 0, "hold"], [at(t + o), flashB * b, "linear"], [at(t + o + 0.07), flashB * b * 0.35, "linear"], [at(t + o + 0.22), 0, "hold"]);
      });
      if (flashPic) {
        const k = ctx.comp.width / (flashPic.meta.width ?? ctx.comp.width);
        const masks: Mask[] = ctx.targets
          .filter((tg) => tg.region.path.closed)
          .map((tg, i) => ({ id: `area${i}`, name: tg.region.name, source: { kind: "region", ref: tg.ref }, mode: "add", inverted: false, feather: staticProp(0), expansion: staticProp(0), opacity: staticProp(100) }));
        out.push({
          role: "flash",
          layer: {
            ...base("Lightning flash (the house goes white)", "normal"),
            source: { kind: "footage", assetId: flashPic.id, loop: true },
            masks,
            transform: { ...defaultTransform(0, 0), scale: staticProp<[number, number, number]>([k * 100, k * 100, 100]), opacity: keyed(`${ctx.instanceId}_fo`, [...pts]) },
          },
        });
      } else {
        const flashCol = color(p.flashColor, [0.85, 0.9, 1, 1]);
        const contents: ShapeContents[] = ctx.targets.map((tg) => ({ path: { kind: "region", ref: tg.ref }, fill: { color: staticProp(flashCol), opacity: keyed(`${ctx.instanceId}_f${tg.region.id}`, [...pts]) } }));
        out.push({ role: "flash", layer: shapeLayer(ctx, "Lightning flash", contents, [], end) });
      }
    }

    // Sounds: the crack as the bolt hits, then thunder; panned toward where the strike landed.
    const sound = (key: string): Asset | undefined => (typeof p[key] === "string" ? ctx.project.assets[p[key] as string] : undefined);
    const part = (key: string): SoundPart => (PART_CHOICES.find((c) => c.value === p[key])?.value ?? "hit") as SoundPart;
    const panAt = (s: number): number => {
      const x = boltStrokes(style, box, from, seed, s, 0)[0]?.[0]?.[0] ?? ctx.comp.width / 2;
      return Math.round(Math.max(-0.8, Math.min(0.8, (x / ctx.comp.width - 0.5) * 1.4)) * 100) / 100;
    };
    const audioLayer = (name: string, asset: Asset, startAt: Flicks, skip: number, len: number, db: number, pan: number): Omit<Layer, "id" | "generatedBy"> => {
      const audio: AudioSettings = { volume: staticProp(db), pan: staticProp(pan), fadeIn: 0, fadeOut: Math.min(1.5, len / 3), muted: false };
      return {
        name,
        source: { kind: "audio", assetId: asset.id },
        startTime: startAt - sec(skip),
        inPoint: startAt,
        outPoint: Math.min(ctx.comp.duration, startAt + sec(len)),
        stretch: 1,
        enabled: true,
        solo: false,
        locked: false,
        audioEnabled: true,
        is3D: false,
        blendMode: "normal",
        transform: defaultTransform(0, 0),
        masks: [],
        effects: [],
        audio,
      };
    };
    const sounds: Array<[on: boolean, asset: Asset | undefined, key: string, delay: number, label: string, panScale: number]> = [
      [p.crack !== false, sound("crackSound"), "crack", 0, "Lightning crack", 1],
      [p.thunder !== false, sound("thunderSound"), "thunder", Math.max(0, num(p.thunderDelay, 1.4)), "Thunder", 0.5],
    ];
    for (const [on, asset, key, delay, label, panScale] of sounds) {
      if (!on || !asset) continue;
      times.forEach((t, s) => {
        const startAt = at(t + delay);
        if (startAt >= ctx.comp.duration) return;
        const { from: skip, until } = soundPart(asset, part(`${key}Part`), Math.max(0, num(p[`${key}Start`], 0)), s);
        const len = Math.max(0.2, Math.min(num(p[`${key}Length`], key === "crack" ? 4 : 7), until - skip));
        out.push({ role: `${key}-${s}`, layer: audioLayer(`${label} ${s + 1}`, asset, startAt, skip, len, num(p[`${key}Volume`], key === "crack" ? -6 : -3), Math.round(panAt(s) * panScale * 100) / 100) });
      });
    }
    return out;
  },
};

registerRecipe(lightning);
