/**
 * Built-in recipes for the first guided path (milestone B):
 *   - tool.edge-trace          "Trace with light"
 *   - tool.sequence-light-up   "Light up one after another"
 * Both produce ordinary shape layers with keyframes and a glow effect, so everything they make is
 * editable in the detailed timeline.
 */
import { type AnimProp, EASY_EASE, type Keyframe, staticProp } from "./anim.ts";
import type { EffectInstance, Layer, Mask, RGBA, ShapeContents } from "./model.ts";
import { defaultTransform } from "./model.ts";
import { pathBounds, pathCentroid, pathLength } from "./pathmath.ts";
import { type RecipeContext, type RecipeDef, registerRecipe, type ResolvedTarget } from "./recipes.ts";
import { hashString, rand01 } from "./rng.ts";
import type { SimSettings } from "./simulation.ts";
import { type Flicks, FLICKS_PER_SECOND, secondsToTime } from "./time.ts";

const sec = (s: number): Flicks => secondsToTime(s);
const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const color = (v: unknown, d: RGBA): RGBA =>
  Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === "number") ? (v as unknown as RGBA) : d;

let kfSerial = 0;
const kf = (t: Flicks, v: number, interp: "linear" | "bezier" | "hold" = "linear", ease = false): Keyframe<number> => ({
  id: `kf${(kfSerial = (kfSerial + 1) % 1e9)}`,
  t,
  v,
  in: interp === "hold" ? "linear" : interp,
  out: interp,
  ...(ease ? { easeIn: [EASY_EASE], easeOut: [EASY_EASE] } : {}),
});

/** Deterministic keyframe ids so regenerating identical params yields identical data. */
const withIds = (base: string, kfs: Keyframe<number>[]): Keyframe<number>[] => kfs.map((k, i) => ({ ...k, id: `${base}_${i}` }));

const animated = (base: string, kfs: Keyframe<number>[], fallback: number): AnimProp<number> =>
  kfs.length ? { value: fallback, keyframes: withIds(base, kfs.sort((a, b) => a.t - b.t)) } : staticProp(fallback);

const glowEffect = (id: string, amount: number, size: number): EffectInstance => ({
  id,
  type: "glow",
  enabled: amount > 0,
  params: {
    radius: staticProp(size),
    intensity: staticProp(amount / 50),
    threshold: staticProp(0),
  },
});

const showEnd = (ctx: RecipeContext, seconds: number): Flicks => Math.min(ctx.comp.duration, ctx.startTime + sec(seconds));

const baseLayer = (ctx: RecipeContext, name: string, contents: ShapeContents[], effects: EffectInstance[], end: Flicks): Omit<Layer, "id" | "generatedBy"> => ({
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

// ---------------------------------------------------------------------------------------------

const ORDER_CHOICES = [
  { value: "left-right", label: "Left to right" },
  { value: "right-left", label: "Right to left" },
  { value: "top-bottom", label: "Top to bottom" },
  { value: "bottom-top", label: "Bottom to top" },
  { value: "center-out", label: "From the center" },
  { value: "random", label: "Random" },
] as const;

export const orderTargets = (targets: readonly ResolvedTarget[], order: string, seed: number): ResolvedTarget[] => {
  const withC = targets.map((t) => ({ t, c: pathCentroid(t.region.path) }));
  const cx = withC.reduce((s, x) => s + x.c[0], 0) / Math.max(1, withC.length);
  const cy = withC.reduce((s, x) => s + x.c[1], 0) / Math.max(1, withC.length);
  // Group rows/columns loosely so "left to right" reads row by row like people expect.
  const key = (x: (typeof withC)[number]): number => {
    switch (order) {
      case "right-left":
        return -x.c[0] + x.c[1] * 1e-6;
      case "top-bottom":
        return x.c[1] + x.c[0] * 1e-6;
      case "bottom-top":
        return -x.c[1] + x.c[0] * 1e-6;
      case "center-out":
        return Math.hypot(x.c[0] - cx, x.c[1] - cy);
      case "random":
        return rand01(seed, hashString(x.t.region.id));
      default:
        return x.c[0] + x.c[1] * 1e-6;
    }
  };
  return withC.sort((a, b) => key(a) - key(b)).map((x) => x.t);
};

export const edgeTrace: RecipeDef = {
  id: "edge-trace",
  title: "Trace with light",
  category: "light",
  description: "A glowing light travels around the edges you select — windows, doors, rooflines, columns.",
  keywords: ["trace", "outline", "edge", "neon", "glow", "line", "border", "light", "chase", "roofline", "contour"],
  suits: ["window", "door", "roofline", "edge", "column", "custom", "wall"],
  defaultSeconds: 8,
  params: [
    { key: "color", label: "Color", control: "color", default: [1, 0.82, 0.5, 1], primary: true, drives: ["source.contents"] },
    { key: "lapSeconds", label: "Time per lap", control: "seconds", default: 3, min: 0.3, max: 30, step: 0.1, unit: "s", primary: true, help: "How long the light takes to travel all the way around.", drives: ["source.contents"] },
    { key: "glow", label: "Glow", control: "slider", default: 60, min: 0, max: 100, primary: true, drives: ["effects.glow"] },
    { key: "tail", label: "Light length", control: "slider", default: 25, min: 2, max: 100, unit: "%", primary: true, drives: ["source.contents"] },
    { key: "stagger", label: "Delay between edges", control: "seconds", default: 0.15, min: 0, max: 5, step: 0.05, unit: "s", drives: ["source.contents"] },
    { key: "direction", label: "Direction", control: "choice", default: "forward", choices: [{ value: "forward", label: "Forward" }, { value: "reverse", label: "Reverse" }], drives: ["source.contents"] },
    { key: "width", label: "Line width", control: "slider", default: 0, min: 0, max: 60, unit: "px", help: "0 picks a width that suits the scene size.", drives: ["source.contents"] },
    { key: "seconds", label: "Duration", control: "seconds", default: 8, min: 0.5, max: 600, step: 0.5, unit: "s", drives: ["outPoint", "source.contents"] },
  ],
  generate: (ctx) => {
    const p = ctx.params;
    const col = color(p.color, [1, 0.82, 0.5, 1]);
    const lap = Math.max(0.05, num(p.lapSeconds, 3));
    const tail = Math.min(100, Math.max(1, num(p.tail, 25)));
    const stagger = Math.max(0, num(p.stagger, 0.15));
    const reverse = p.direction === "reverse";
    const diag = Math.hypot(ctx.comp.width, ctx.comp.height);
    const width = num(p.width, 0) > 0 ? num(p.width, 0) : Math.max(2, Math.round(diag * 0.0035));
    const end = showEnd(ctx, num(p.seconds, 8));
    const t0 = ctx.startTime;
    const lapF = sec(lap);
    const contents: ShapeContents[] = ctx.targets.map((tg, i) => {
      const ts = t0 + sec(stagger * i);
      const closed = tg.region.path.closed;
      const fade: AnimProp<number> = animated(`${ctx.instanceId}_op${i}`, [kf(ts, 0, "bezier", true), kf(ts + sec(0.3), 100, "bezier", true)], 100);
      let trim: NonNullable<ShapeContents["trim"]>;
      if (closed) {
        const laps = Math.max(1, Math.ceil((end - ts) / lapF));
        trim = {
          start: staticProp(0),
          end: staticProp(tail),
          offset: animated(`${ctx.instanceId}_off${i}`, [kf(ts, 0), kf(ts + laps * lapF, (reverse ? -360 : 360) * laps)], 0),
        };
      } else {
        // Open edges: the light enters at one end and leaves at the other, then repeats.
        const startK: Keyframe<number>[] = [];
        const endK: Keyframe<number>[] = [];
        const gap = Math.round(lapF * 0.2);
        for (let t = ts; t < end; t += lapF + gap) {
          const a = reverse ? { s0: 100, s1: -tail, e0: 100 + tail, e1: 0 } : { s0: -tail, s1: 100, e0: 0, e1: 100 + tail };
          startK.push(kf(t, a.s0), kf(t + lapF, a.s1, "hold"));
          endK.push(kf(t, a.e0), kf(t + lapF, a.e1, "hold"));
        }
        trim = {
          start: animated(`${ctx.instanceId}_ts${i}`, startK, 0),
          end: animated(`${ctx.instanceId}_te${i}`, endK, 0),
          offset: staticProp(0),
        };
      }
      return {
        path: { kind: "region", ref: tg.ref },
        stroke: { color: staticProp(col), width: staticProp(width), opacity: fade, cap: "round", join: "round" },
        trim,
      };
    });
    return [
      {
        role: "trace",
        layer: baseLayer(ctx, `Light trace — ${ctx.targets.length} edge${ctx.targets.length === 1 ? "" : "s"}`, contents, [glowEffect("glow", num(p.glow, 60), width * 4)], end),
      },
    ];
  },
};

export const sequenceLightUp: RecipeDef = {
  id: "sequence-light-up",
  title: "Light up one after another",
  category: "light",
  description: "Fill each selected region with light in turn — windows switching on across the building.",
  keywords: ["windows", "sequence", "one after another", "cascade", "chase", "light up", "turn on", "stagger", "fill", "glow", "illuminate"],
  suits: ["window", "door", "column", "wall", "custom"],
  defaultSeconds: 6,
  params: [
    { key: "color", label: "Color", control: "color", default: [1, 0.8, 0.52, 1], primary: true, drives: ["source.contents"] },
    { key: "order", label: "Order", control: "choice", default: "left-right", choices: ORDER_CHOICES, primary: true, drives: ["source.contents"] },
    { key: "delay", label: "Delay between", control: "seconds", default: 0.25, min: 0, max: 10, step: 0.05, unit: "s", primary: true, drives: ["source.contents"] },
    { key: "fade", label: "Fade time", control: "seconds", default: 0.4, min: 0, max: 10, step: 0.05, unit: "s", primary: true, drives: ["source.contents"] },
    { key: "stayLit", label: "Stay lit", control: "toggle", default: true, drives: ["source.contents"] },
    { key: "hold", label: "Time lit", control: "seconds", default: 1, min: 0, max: 30, step: 0.1, unit: "s", help: "Used when Stay lit is off.", drives: ["source.contents"] },
    { key: "brightness", label: "Brightness", control: "slider", default: 85, min: 0, max: 100, unit: "%", drives: ["source.contents"] },
    { key: "glow", label: "Glow", control: "slider", default: 35, min: 0, max: 100, drives: ["effects.glow"] },
    { key: "seed", label: "Shuffle", control: "seed", default: 1, help: "Pick a different random order.", drives: ["source.contents"] },
    { key: "seconds", label: "Duration", control: "seconds", default: 6, min: 0.5, max: 600, step: 0.5, unit: "s", drives: ["outPoint"] },
  ],
  generate: (ctx) => {
    const p = ctx.params;
    const col = color(p.color, [1, 0.8, 0.52, 1]);
    const delay = Math.max(0, num(p.delay, 0.25));
    const fade = Math.max(0, num(p.fade, 0.4));
    const hold = Math.max(0, num(p.hold, 1));
    const stay = p.stayLit !== false;
    const bright = Math.min(100, Math.max(0, num(p.brightness, 85)));
    const ordered = orderTargets(ctx.targets, String(p.order ?? "left-right"), num(p.seed, 1) | 0);
    const lastStart = ctx.startTime + sec(delay * Math.max(0, ordered.length - 1));
    const end = Math.max(showEnd(ctx, num(p.seconds, 6)), lastStart + sec(fade + (stay ? 0 : hold + fade)) + 1);
    const diag = Math.hypot(ctx.comp.width, ctx.comp.height);
    const contents: ShapeContents[] = ordered.map((tg, i) => {
      const ts = ctx.startTime + sec(delay * i);
      const kfs = [kf(ts, 0, "bezier", true), kf(ts + sec(fade), bright, "bezier", true)];
      if (!stay) kfs.push(kf(ts + sec(fade + hold), bright, "bezier", true), kf(ts + sec(fade + hold + fade), 0, "bezier", true));
      return {
        path: { kind: "region", ref: tg.ref },
        fill: { color: staticProp(col), opacity: animated(`${ctx.instanceId}_f${tg.region.id}`, kfs, 0) },
      };
    });
    return [
      {
        role: "fills",
        layer: baseLayer(ctx, `Lights — ${ordered.length} region${ordered.length === 1 ? "" : "s"}`, contents, [glowEffect("glow", num(p.glow, 35), Math.round(diag * 0.01))], end),
      },
    ];
  },
};

export const pulse: RecipeDef = {
  id: "pulse",
  title: "Pulse with light",
  category: "light",
  description: "Regions breathe brighter and darker in a steady rhythm — set the speed to match the music.",
  keywords: ["pulse", "breathe", "throb", "beat", "rhythm", "flash", "blink", "heartbeat", "music", "bpm"],
  suits: ["window", "door", "column", "wall", "custom"],
  defaultSeconds: 8,
  params: [
    { key: "color", label: "Color", control: "color", default: [0.35, 0.6, 1, 1], primary: true, drives: ["source.contents"] },
    { key: "bpm", label: "Pulses per minute", control: "slider", default: 60, min: 10, max: 240, step: 1, primary: true, help: "Match this to the music's tempo (BPM).", drives: ["source.contents"] },
    { key: "depth", label: "Strength", control: "slider", default: 80, min: 5, max: 100, unit: "%", primary: true, drives: ["source.contents"] },
    { key: "wave", label: "Wave across regions", control: "slider", default: 0, min: 0, max: 100, unit: "%", primary: true, help: "0 = all together; higher = the pulse travels across the regions.", drives: ["source.contents"] },
    { key: "order", label: "Wave direction", control: "choice", default: "left-right", choices: ORDER_CHOICES, drives: ["source.contents"] },
    { key: "glow", label: "Glow", control: "slider", default: 40, min: 0, max: 100, drives: ["effects.glow"] },
    { key: "seconds", label: "Duration", control: "seconds", default: 8, min: 0.5, max: 600, step: 0.5, unit: "s", drives: ["outPoint", "source.contents"] },
  ],
  generate: (ctx) => {
    const p = ctx.params;
    const col = color(p.color, [0.35, 0.6, 1, 1]);
    const period = 60 / Math.min(600, Math.max(1, num(p.bpm, 60)));
    const depth = Math.min(100, Math.max(0, num(p.depth, 80)));
    const wave = Math.min(100, Math.max(0, num(p.wave, 0))) / 100;
    const end = showEnd(ctx, num(p.seconds, 8));
    const ordered = orderTargets(ctx.targets, String(p.order ?? "left-right"), 1);
    const diag = Math.hypot(ctx.comp.width, ctx.comp.height);
    const contents: ShapeContents[] = ordered.map((tg, i) => {
      const phase = ordered.length > 1 ? (i / (ordered.length - 1)) * wave * period : 0;
      const kfs: Keyframe<number>[] = [];
      // Peaks and troughs as eased keyframes: a steady rhythm that seeks exactly. (Milestone C
      // replaces this with a loop expression so long shows don't need thousands of keyframes.)
      for (let t = ctx.startTime + sec(phase), k = 0; t < end && k < 4000; t += sec(period / 2), k++) {
        kfs.push(kf(t, k % 2 === 0 ? 100 - depth : 100, "bezier", true));
      }
      return { path: { kind: "region", ref: tg.ref }, fill: { color: staticProp(col), opacity: animated(`${ctx.instanceId}_p${tg.region.id}`, kfs, 100 - depth) } };
    });
    return [{ role: "pulse", layer: baseLayer(ctx, `Pulse — ${ordered.length} region${ordered.length === 1 ? "" : "s"}`, contents, [glowEffect("glow", num(p.glow, 40), Math.round(diag * 0.01))], end) }];
  },
};

export const neonOutline: RecipeDef = {
  id: "neon-outline",
  title: "Neon outline",
  category: "light",
  description: "A steady glowing outline that flickers on like a neon sign.",
  keywords: ["neon", "outline", "glow", "edge", "sign", "border", "contour", "line", "flicker"],
  suits: ["window", "door", "roofline", "edge", "column", "custom", "wall"],
  defaultSeconds: 10,
  params: [
    { key: "color", label: "Color", control: "color", default: [1, 0.25, 0.75, 1], primary: true, drives: ["source.contents"] },
    { key: "glow", label: "Glow", control: "slider", default: 70, min: 0, max: 100, primary: true, drives: ["effects.glow"] },
    { key: "width", label: "Line width", control: "slider", default: 0, min: 0, max: 60, unit: "px", primary: true, help: "0 picks a width that suits the scene size.", drives: ["source.contents"] },
    { key: "flicker", label: "Flicker on", control: "toggle", default: true, primary: true, drives: ["source.contents"] },
    { key: "seed", label: "Flicker pattern", control: "seed", default: 3, drives: ["source.contents"] },
    { key: "seconds", label: "Duration", control: "seconds", default: 10, min: 0.5, max: 600, step: 0.5, unit: "s", drives: ["outPoint"] },
  ],
  generate: (ctx) => {
    const p = ctx.params;
    const col = color(p.color, [1, 0.25, 0.75, 1]);
    const diag = Math.hypot(ctx.comp.width, ctx.comp.height);
    const width = num(p.width, 0) > 0 ? num(p.width, 0) : Math.max(2, Math.round(diag * 0.003));
    const end = showEnd(ctx, num(p.seconds, 10));
    const seed = num(p.seed, 3) | 0;
    const contents: ShapeContents[] = ctx.targets.map((tg, i) => {
      const kfs: Keyframe<number>[] = [];
      if (p.flicker !== false) {
        // A short, seeded on/off stutter, then steady.
        let t = ctx.startTime + sec(rand01(seed, i, 0) * 0.4);
        kfs.push(kf(ctx.startTime, 0, "hold"));
        for (let k = 0; k < 7; k++) {
          kfs.push(kf(t + 1, k % 2 === 0 ? 100 : 15 + rand01(seed, i, k + 10) * 30, "hold"));
          t += sec(0.04 + rand01(seed, i, k + 20) * 0.12);
        }
        kfs.push(kf(t + 2, 100, "hold"));
      }
      return {
        path: { kind: "region", ref: tg.ref },
        stroke: { color: staticProp(col), width: staticProp(width), opacity: animated(`${ctx.instanceId}_n${i}`, kfs, 100), cap: "round", join: "round" },
      };
    });
    return [{ role: "neon", layer: baseLayer(ctx, `Neon — ${ctx.targets.length} outline${ctx.targets.length === 1 ? "" : "s"}`, contents, [glowEffect("glow", num(p.glow, 70), width * 5)], end) }];
  },
};

export const colorWash: RecipeDef = {
  id: "color-wash",
  title: "Fill with color",
  category: "color",
  description: "Paint the selected regions with a solid color of light that fades in.",
  keywords: ["color", "colour", "fill", "paint", "wash", "tint", "solid", "light"],
  suits: ["window", "door", "column", "wall", "custom"],
  defaultSeconds: 6,
  params: [
    { key: "color", label: "Color", control: "color", default: [0.95, 0.55, 0.2, 1], primary: true, drives: ["source.contents"] },
    { key: "brightness", label: "Brightness", control: "slider", default: 70, min: 0, max: 100, unit: "%", primary: true, drives: ["source.contents"] },
    { key: "fade", label: "Fade in", control: "seconds", default: 1, min: 0, max: 20, step: 0.1, unit: "s", primary: true, drives: ["source.contents"] },
    { key: "seconds", label: "Duration", control: "seconds", default: 6, min: 0.5, max: 600, step: 0.5, unit: "s", drives: ["outPoint"] },
  ],
  generate: (ctx) => {
    const p = ctx.params;
    const col = color(p.color, [0.95, 0.55, 0.2, 1]);
    const b = Math.min(100, Math.max(0, num(p.brightness, 70)));
    const fade = Math.max(0, num(p.fade, 1));
    const end = showEnd(ctx, num(p.seconds, 6));
    const contents: ShapeContents[] = ctx.targets.map((tg) => ({
      path: { kind: "region", ref: tg.ref },
      fill: {
        color: staticProp(col),
        opacity: fade > 0 ? animated(`${ctx.instanceId}_w${tg.region.id}`, [kf(ctx.startTime, 0, "bezier", true), kf(ctx.startTime + sec(fade), b, "bezier", true)], b) : staticProp(b),
      },
    }));
    return [{ role: "wash", layer: { ...baseLayer(ctx, `Color — ${ctx.targets.length} region${ctx.targets.length === 1 ? "" : "s"}`, contents, [], end), blendMode: "normal" } }];
  },
};

const regionMask = (id: string, ref: { role: string; index?: number }, feather = 2): Mask => ({
  id,
  name: "Surface",
  source: { kind: "region", ref },
  mode: "add",
  inverted: false,
  feather: staticProp(feather),
  expansion: staticProp(0),
  opacity: staticProp(100),
});

const fadeOpacity = (base: string, start: Flicks, fade: number, value = 100): AnimProp<number> =>
  fade > 0 ? animated(base, [kf(start, 0, "bezier", true), kf(start + sec(fade), value, "bezier", true)], value) : staticProp(value);

export const mediaFill: RecipeDef = {
  id: "media-fill",
  title: "Show a picture or video",
  category: "patterns",
  description: "Put one of your own images or videos on the selected parts, fitted to their shape.",
  keywords: ["picture", "photo", "image", "video", "clip", "movie", "media", "footage", "my", "own", "show", "place", "put"],
  suits: ["window", "door", "wall", "column", "custom"],
  defaultSeconds: 10,
  params: [
    { key: "assetId", label: "Picture or video", control: "media", default: "", primary: true, accepts: ["image", "video"], drives: ["source"] },
    { key: "fit", label: "Fit", control: "choice", default: "fill", primary: true, choices: [{ value: "fill", label: "Fill the shape" }, { value: "fit", label: "Show all of it" }, { value: "stretch", label: "Stretch" }], drives: ["transform"] },
    { key: "spread", label: "With several parts", control: "choice", default: "across", primary: true, choices: [{ value: "across", label: "One picture across all" }, { value: "each", label: "A copy in each" }], drives: ["transform", "masks"] },
    { key: "fade", label: "Fade in", control: "seconds", default: 0.5, min: 0, max: 10, step: 0.1, unit: "s", primary: true, drives: ["transform.opacity"] },
    { key: "opacity", label: "Strength", control: "slider", default: 100, min: 0, max: 100, unit: "%", drives: ["transform.opacity"] },
    { key: "seconds", label: "Duration", control: "seconds", default: 10, min: 0.5, max: 3600, step: 0.5, unit: "s", drives: ["outPoint"] },
  ],
  generate: (ctx) => {
    const p = ctx.params;
    const asset = typeof p.assetId === "string" ? ctx.project.assets[p.assetId] : undefined;
    if (!asset || (asset.kind !== "image" && asset.kind !== "video") || !asset.meta.width || !asset.meta.height) return [];
    const aw = asset.meta.width;
    const ah = asset.meta.height;
    const fit = String(p.fit ?? "fill");
    const end = showEnd(ctx, num(p.seconds, asset.meta.duration ? asset.meta.duration / FLICKS_PER_SECOND : 10));
    const groups = p.spread === "each" ? ctx.targets.map((t) => [t]) : [ctx.targets];
    return groups.map((targets, gi) => {
      const b = pathBounds(targets.map((t) => t.region.path));
      const sx = b.w / aw;
      const sy = b.h / ah;
      const s = fit === "fit" ? Math.min(sx, sy) : Math.max(sx, sy);
      const scale: readonly [number, number, number] = fit === "stretch" ? [sx * 100, sy * 100, 100] : [s * 100, s * 100, 100];
      const layer: Omit<Layer, "id" | "generatedBy"> = {
        name: `${asset.name}${groups.length > 1 ? ` ${gi + 1}` : ""}`,
        source: { kind: "footage", assetId: asset.id },
        startTime: ctx.startTime,
        inPoint: ctx.startTime,
        outPoint: Math.max(end, ctx.startTime + 1),
        stretch: 1,
        enabled: true,
        solo: false,
        locked: false,
        audioEnabled: true,
        is3D: false,
        blendMode: "normal",
        transform: {
          anchor: staticProp([aw / 2, ah / 2, 0] as const),
          position: staticProp([b.x + b.w / 2, b.y + b.h / 2, 0] as const, true),
          scale: staticProp(scale),
          rotation: staticProp([0, 0, 0] as const),
          opacity: fadeOpacity(`${ctx.instanceId}_o${gi}`, ctx.startTime, num(p.fade, 0.5), num(p.opacity, 100)),
        },
        masks: targets.filter((t) => t.region.path.closed).map((t, i) => regionMask(`m${i}`, t.ref)),
        effects: [],
      };
      return { role: `media-${gi}`, layer };
    });
  },
};

export const textOnSurface: RecipeDef = {
  id: "text-on-surface",
  title: "Add text",
  category: "text",
  description: "Words on the selected part, sized to fit, fading in.",
  keywords: ["text", "words", "title", "name", "message", "letters", "type", "write", "caption"],
  suits: ["window", "door", "wall", "column", "custom", "roofline", "edge"],
  defaultSeconds: 8,
  params: [
    { key: "text", label: "Text", control: "text", default: "Hello", primary: true, drives: ["source.doc.text"] },
    { key: "font", label: "Font", control: "font", default: "Segoe UI", primary: true, drives: ["source.doc.font"] },
    { key: "color", label: "Color", control: "color", default: [1, 1, 1, 1], primary: true, drives: ["source.doc.color"] },
    { key: "fade", label: "Fade in", control: "seconds", default: 0.8, min: 0, max: 10, step: 0.1, unit: "s", primary: true, drives: ["transform.opacity"] },
    { key: "size", label: "Size", control: "slider", default: 0, min: 0, max: 600, unit: "px", help: "0 sizes the text to fit the part.", drives: ["source.doc.size"] },
    { key: "weight", label: "Weight", control: "choice", default: "700", choices: [{ value: "400", label: "Regular" }, { value: "700", label: "Bold" }, { value: "900", label: "Heavy" }], drives: ["source.doc.weight"] },
    { key: "seconds", label: "Duration", control: "seconds", default: 8, min: 0.5, max: 3600, step: 0.5, unit: "s", drives: ["outPoint"] },
  ],
  generate: (ctx) => {
    const p = ctx.params;
    const text = String(p.text ?? "Hello").slice(0, 2000) || " ";
    const lines = text.split(/\r?\n/);
    const longest = Math.max(1, ...lines.map((l) => l.length));
    const b = pathBounds(ctx.targets.map((t) => t.region.path));
    const fitSize = Math.max(8, Math.min((b.h * 0.7) / lines.length, (b.w * 0.85) / (0.56 * longest)));
    const size = num(p.size, 0) > 0 ? num(p.size, 0) : Math.round(fitSize);
    const end = showEnd(ctx, num(p.seconds, 8));
    const layer: Omit<Layer, "id" | "generatedBy"> = {
      name: `Text: ${lines[0]!.slice(0, 24)}`,
      source: {
        kind: "text",
        doc: { text, font: String(p.font ?? "Segoe UI"), weight: Number(p.weight ?? 700), size: staticProp(size), color: staticProp(color(p.color, [1, 1, 1, 1])), align: "center", lineHeight: 1.15, tracking: 0 },
      },
      startTime: ctx.startTime,
      inPoint: ctx.startTime,
      outPoint: Math.max(end, ctx.startTime + 1),
      stretch: 1,
      enabled: true,
      solo: false,
      locked: false,
      audioEnabled: false,
      is3D: false,
      blendMode: "normal",
      transform: {
        anchor: staticProp([0, 0, 0] as const),
        position: staticProp([b.x + b.w / 2, b.y + b.h / 2, 0] as const, true),
        scale: staticProp([100, 100, 100] as const),
        rotation: staticProp([0, 0, 0] as const),
        opacity: fadeOpacity(`${ctx.instanceId}_t`, ctx.startTime, num(p.fade, 0.8)),
      },
      masks: [],
      effects: [],
    };
    return [{ role: "text", layer }];
  },
};

/** Where an audio asset sits on the composition's timeline (first layer using it). */
const musicPlacement = (ctx: RecipeContext, assetId: string): { start: Flicks; stretch: number; inPoint: Flicks; outPoint: Flicks } | null => {
  for (const id of ctx.comp.layerOrder) {
    const l = ctx.comp.layers[id];
    if (l && (l.source.kind === "audio" || l.source.kind === "footage") && l.source.assetId === assetId) return { start: l.startTime, stretch: l.stretch, inPoint: l.inPoint, outPoint: l.outPoint };
  }
  return null;
};

export const moveWithBeat: RecipeDef = {
  id: "move-with-beat",
  title: "Move with the beat",
  category: "light",
  description: "Light flashes on the music's beats — every beat, every other beat, or on each bar.",
  keywords: ["beat", "music", "rhythm", "bpm", "sync", "song", "pulse", "dance", "bass", "kick", "flash", "audio", "sound"],
  suits: ["window", "door", "column", "wall", "custom"],
  defaultSeconds: 30,
  params: [
    { key: "musicId", label: "Music", control: "media", default: "", primary: true, accepts: ["audio", "video"], drives: ["source.contents"] },
    { key: "color", label: "Color", control: "color", default: [0.4, 0.65, 1, 1], primary: true, drives: ["source.contents"] },
    { key: "which", label: "Flash on", control: "choice", default: "beat", primary: true, choices: [{ value: "beat", label: "Every beat" }, { value: "half", label: "Every other beat" }, { value: "bar", label: "Each bar" }], drives: ["source.contents"] },
    { key: "decay", label: "Fade after each beat", control: "seconds", default: 0.35, min: 0.05, max: 4, step: 0.05, unit: "s", primary: true, drives: ["source.contents"] },
    { key: "pattern", label: "Pattern", control: "choice", default: "together", choices: [{ value: "together", label: "All together" }, { value: "chase", label: "Chase across" }], drives: ["source.contents"] },
    { key: "strength", label: "Brightness", control: "slider", default: 90, min: 5, max: 100, unit: "%", drives: ["source.contents"] },
    { key: "rest", label: "Between beats", control: "slider", default: 8, min: 0, max: 80, unit: "%", help: "How bright the parts stay between beats.", drives: ["source.contents"] },
    { key: "order", label: "Chase direction", control: "choice", default: "left-right", choices: ORDER_CHOICES, drives: ["source.contents"] },
    { key: "glow", label: "Glow", control: "slider", default: 45, min: 0, max: 100, drives: ["effects.glow"] },
  ],
  generate: (ctx) => {
    const p = ctx.params;
    const assetId = typeof p.musicId === "string" ? p.musicId : "";
    const asset = ctx.project.assets[assetId];
    const analysis = asset?.analysis;
    const place = asset ? musicPlacement(ctx, assetId) : null;
    if (!asset || !analysis || !place || analysis.beats.length === 0) return [];
    const col = color(p.color, [0.4, 0.65, 1, 1]);
    const peak = Math.min(100, Math.max(0, num(p.strength, 90)));
    const rest = Math.min(peak, Math.max(0, num(p.rest, 8)));
    const decay = sec(Math.max(0.05, num(p.decay, 0.35)));
    const which = String(p.which ?? "beat");
    // Beat times on the composition timeline, inside the music layer and the recipe's own span.
    const beats: Flicks[] = [];
    analysis.beats.forEach((b, i) => {
      const rel = i - analysis.downbeatOffset;
      if (which === "half" && ((rel % 2) + 2) % 2 !== 0) return;
      if (which === "bar" && ((rel % 4) + 4) % 4 !== 0) return;
      const t = place.start + Math.round(b / Math.max(1e-6, place.stretch));
      if (t >= place.inPoint && t < place.outPoint && t >= ctx.startTime) beats.push(t);
    });
    const ordered = orderTargets(ctx.targets, String(p.order ?? "left-right"), 1);
    const chase = p.pattern === "chase";
    const diag = Math.hypot(ctx.comp.width, ctx.comp.height);
    const contents: ShapeContents[] = ordered.map((tg, i) => {
      const kfs: Keyframe<number>[] = [kf(ctx.startTime, rest, "linear")];
      beats.forEach((t, bi) => {
        if (chase && bi % ordered.length !== i) return;
        // Instant rise on the beat, smooth fall back to the resting level.
        kfs.push(kf(Math.max(ctx.startTime, t - 1), rest, "linear"), kf(t, peak, "bezier", false), kf(t + decay, rest, "linear"));
      });
      const clean = kfs.filter((k, j) => j === 0 || k.t > kfs[j - 1]!.t);
      return { path: { kind: "region", ref: tg.ref }, fill: { color: staticProp(col), opacity: animated(`${ctx.instanceId}_b${tg.region.id}`, clean, rest) } };
    });
    const end = Math.min(ctx.comp.duration, place.outPoint);
    return [{ role: "beat", layer: baseLayer(ctx, `Beat — ${ordered.length} region${ordered.length === 1 ? "" : "s"}`, contents, [glowEffect("glow", num(p.glow, 45), Math.round(diag * 0.01))], end) }];
  },
};

// ---------------------------------------------------------------------------------------------
// Simulations: real smoke and water, prepared (simulated and stored) before they play.

const QUALITY_CHOICES = [
  { value: "draft", label: "Quick (draft)" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High detail (slower to prepare)" },
];

const simLayer = (ctx: RecipeContext, name: string, sim: SimSettings, end: Flicks, glow: boolean): Omit<Layer, "id" | "generatedBy"> => ({
  ...baseLayer(ctx, name, [], [], end),
  source: { kind: "simulation", sim },
  startTime: ctx.startTime,
  blendMode: glow ? "add" : "normal",
});

const lighter = (c: RGBA): RGBA => [c[0] + (1 - c[0]) * 0.6, c[1] + (1 - c[1]) * 0.6, c[2] + (1 - c[2]) * 0.6, 1];

export const smokeRising: RecipeDef = {
  id: "smoke-rising",
  title: "Smoke rising",
  category: "fire",
  description: "Real, simulated smoke drifts up out of the selected parts, curling and fading as it rises.",
  keywords: ["smoke", "fog", "mist", "haze", "steam", "vapour", "vapor", "cloud", "rising", "drift", "fire", "simulation"],
  suits: ["window", "door", "wall", "column", "custom", "roofline", "edge"],
  defaultSeconds: 10,
  params: [
    { key: "color", label: "Color", control: "color", default: [0.92, 0.94, 1, 1], primary: true, drives: ["source.sim"] },
    { key: "amount", label: "Amount", control: "slider", default: 60, min: 0, max: 100, unit: "%", primary: true, drives: ["source.sim"] },
    { key: "rise", label: "Rise speed", control: "slider", default: 55, min: 0, max: 100, unit: "%", primary: true, drives: ["source.sim"] },
    { key: "swirl", label: "Swirl", control: "slider", default: 45, min: 0, max: 100, unit: "%", primary: true, drives: ["source.sim"] },
    { key: "wind", label: "Wind", control: "slider", default: 0, min: -100, max: 100, help: "Negative blows left, positive blows right.", drives: ["source.sim"] },
    { key: "linger", label: "Lingers for", control: "seconds", default: 3, min: 0.3, max: 20, step: 0.1, unit: "s", drives: ["source.sim"] },
    { key: "glow", label: "Glowing (adds light)", control: "toggle", default: false, drives: ["blendMode"] },
    { key: "quality", label: "Detail", control: "choice", default: "normal", choices: QUALITY_CHOICES, drives: ["source.sim"] },
    { key: "seed", label: "Variation", control: "seed", default: 1, drives: ["source.sim"] },
    { key: "seconds", label: "Duration", control: "seconds", default: 10, min: 0.5, max: 600, step: 0.5, unit: "s", drives: ["outPoint"] },
  ],
  generate: (ctx) => {
    const p = ctx.params;
    const col = color(p.color, [0.92, 0.94, 1, 1]);
    const sim: SimSettings = {
      type: "smoke",
      seed: Math.round(num(p.seed, 1)),
      quality: (["draft", "normal", "high"].includes(String(p.quality)) ? p.quality : "normal") as SimSettings["quality"],
      emitters: ctx.targets.map((tg) => ({ source: { kind: "region" as const, ref: tg.ref }, band: "bottom" as const, amount: num(p.amount, 60), velocity: [0, -90] as const })),
      containers: [],
      preroll: 1,
      forces: { rise: num(p.rise, 55), gravity: 0, wind: [num(p.wind, 0) * 2, 0], swirl: num(p.swirl, 45), turbulence: 30, linger: num(p.linger, 3) },
      look: { color: col, color2: lighter(col), opacity: 90, glow: !!p.glow },
    };
    return [{ role: "smoke", layer: simLayer(ctx, `Smoke — ${ctx.targets.length} part${ctx.targets.length === 1 ? "" : "s"}`, sim, showEnd(ctx, num(p.seconds, 10)), !!p.glow) }];
  },
};

export const waterFill: RecipeDef = {
  id: "water-fill",
  title: "Fill with flowing water",
  category: "water",
  description: "Real, simulated water pours in and fills the selected parts, sloshing as it settles — or pours down the building.",
  keywords: ["water", "fill", "flow", "flowing", "pour", "liquid", "flood", "waterfall", "rain", "splash", "wave", "simulation"],
  suits: ["window", "door", "wall", "column", "custom"],
  defaultSeconds: 10,
  params: [
    { key: "color", label: "Water color", control: "color", default: [0.16, 0.5, 0.95, 1], primary: true, drives: ["source.sim"] },
    { key: "mode", label: "Water", control: "choice", default: "fill", primary: true, choices: [{ value: "fill", label: "Fills the parts" }, { value: "pour", label: "Pours down from them" }], drives: ["source.sim"] },
    { key: "amount", label: "Flow", control: "slider", default: 60, min: 5, max: 100, unit: "%", primary: true, drives: ["source.sim"] },
    { key: "gravity", label: "Weight", control: "slider", default: 50, min: 5, max: 100, unit: "%", primary: true, help: "How strongly the water falls.", drives: ["source.sim"] },
    { key: "quality", label: "Detail", control: "choice", default: "normal", choices: QUALITY_CHOICES, drives: ["source.sim"] },
    { key: "seed", label: "Variation", control: "seed", default: 1, drives: ["source.sim"] },
    { key: "seconds", label: "Duration", control: "seconds", default: 10, min: 0.5, max: 600, step: 0.5, unit: "s", drives: ["outPoint"] },
  ],
  generate: (ctx) => {
    const p = ctx.params;
    const col = color(p.color, [0.16, 0.5, 0.95, 1]);
    const fill = String(p.mode ?? "fill") !== "pour";
    const refs = ctx.targets.map((tg) => ({ kind: "region" as const, ref: tg.ref }));
    const sim: SimSettings = {
      type: "water",
      seed: Math.round(num(p.seed, 1)),
      quality: (["draft", "normal", "high"].includes(String(p.quality)) ? p.quality : "normal") as SimSettings["quality"],
      emitters: refs.map((source) => ({ source, band: fill ? ("top" as const) : ("bottom" as const), amount: num(p.amount, 60), velocity: [0, 80] as const })),
      containers: fill ? refs : [],
      preroll: 0,
      forces: { rise: 0, gravity: num(p.gravity, 50), wind: [0, 0], swirl: 0, turbulence: 10, linger: 0 },
      look: { color: col, color2: lighter(col), opacity: 92, glow: false },
    };
    return [{ role: "water", layer: simLayer(ctx, `Water — ${ctx.targets.length} part${ctx.targets.length === 1 ? "" : "s"}`, sim, showEnd(ctx, num(p.seconds, 10)), false) }];
  },
};

registerRecipe(edgeTrace, sequenceLightUp, pulse, neonOutline, colorWash, mediaFill, textOnSurface, moveWithBeat, smokeRising, waterFill);

/** Path lengths per target, used by the UI to suggest a sensible lap time. */
export const suggestLapSeconds = (targets: readonly ResolvedTarget[], compWidth: number): number => {
  if (targets.length === 0) return 3;
  const avg = targets.reduce((s, t) => s + pathLength(t.region.path), 0) / targets.length;
  const pxPerSec = compWidth * 0.4;
  return Math.min(30, Math.max(0.5, Math.round((avg / pxPerSec) * 10) / 10));
};

export const FLICKS = FLICKS_PER_SECOND;
