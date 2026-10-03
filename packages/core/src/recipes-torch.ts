/**
 * "Torch flames": a small living flame in each chosen light fitting (a lantern, sconce or torch) —
 * three nested tongues of flame (a deep outer glow, the body, a pale core) that sway and flicker on
 * their own, with a warm glow on the wall around them. Procedural: the flicker is built-in wiggle
 * expressions on each layer (no keyframes), so it lasts as long as the layer at no cost, and preview
 * and export match.
 */
import { staticProp } from "./anim.ts";
import { defaultTransform, type EffectInstance, type Layer, packPath, polygonPath, type RGBA, type ShapeContents, type Vec2, type Vec3 } from "./model.ts";
import { pathBounds } from "./pathmath.ts";
import { type RecipeContext, type RecipeDef, registerRecipe } from "./recipes.ts";
import { hashString } from "./rng.ts";
import { secondsToTime } from "./time.ts";

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const color = (v: unknown, d: RGBA): RGBA => (Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === "number") ? (v as unknown as RGBA) : d);

/** A tongue of flame `h` tall, base at (0, 0), tip at (0, -h): round at the bottom, pointed at the top. */
export const flameOutline = (h: number, width = 0.42, lean = 0): Vec2[] => {
  const n = 24;
  const half = (u: number) => (width * h * 0.5 * Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.08)), 0.75) * Math.pow(1 - u, 0.35));
  const right: Vec2[] = [], left: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const w = half(u);
    const x = lean * h * u * u;
    right.push([x + w, -h * u]);
    left.push([x - w, -h * u]);
  }
  return [...right, ...left.reverse()];
};

const mix = (a: RGBA, b: RGBA, k: number): RGBA => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, 1];

export const torchFlames: RecipeDef = {
  id: "torch-flames",
  title: "Torch flames",
  category: "light",
  description: "A small living flame in each chosen light fitting — like a torch or lantern — swaying and flickering, with a warm glow on the wall around it.",
  keywords: ["torch", "torches", "flame", "flames", "fire", "candle", "lantern", "sconce", "flicker", "light", "halloween", "spooky", "warm"],
  suits: ["light", "custom", "window", "door"],
  defaultSeconds: 60,
  params: [
    { key: "size", label: "Flame size", control: "slider", default: 70, min: 10, max: 200, unit: "%", primary: true, help: "How tall the flame is compared with the area.", drives: ["source.contents"] },
    { key: "color", label: "Flame colour", control: "color", default: [1, 0.5, 0.1, 1], primary: true, drives: ["source.contents"] },
    { key: "flicker", label: "Flicker", control: "slider", default: 70, min: 0, max: 100, unit: "%", primary: true, help: "How much it sways, stretches and dims.", drives: ["transform"] },
    { key: "speed", label: "Flicker speed", control: "slider", default: 6, min: 0.5, max: 20, step: 0.5, unit: "/s", drives: ["transform"] },
    { key: "glow", label: "Glow around it", control: "slider", default: 55, min: 0, max: 100, help: "Warm light on the wall around the flame (0: none).", drives: ["source.contents", "transform.opacity"] },
    { key: "base", label: "Flame sits at", control: "slider", default: 80, min: 0, max: 100, unit: "%", help: "Where the flame's base is, from the top of the area (100: the bottom).", drives: ["transform.position"] },
    { key: "seed", label: "Variation", control: "seed", default: 1, drives: ["transform"] },
    { key: "seconds", label: "Duration", control: "seconds", default: 60, min: 1, max: 3600, step: 1, unit: "s", drives: ["outPoint"] },
  ],
  generate: (ctx: RecipeContext) => {
    const p = ctx.params;
    const end = Math.min(ctx.comp.duration, ctx.startTime + secondsToTime(num(p.seconds, 60)));
    const flick = Math.max(0, Math.min(100, num(p.flicker, 70))) / 100;
    const speed = Math.max(0.5, num(p.speed, 6));
    const glow = Math.max(0, Math.min(100, num(p.glow, 55)));
    const base = Math.max(0, Math.min(100, num(p.base, 80))) / 100;
    const col = color(p.color, [1, 0.5, 0.1, 1]);
    const seed = (hashString(ctx.instanceId.replace(/_preview$/, "")) % 997) + Math.round(num(p.seed, 1)) * 31;
    const out: Array<{ role: string; layer: Omit<Layer, "id" | "generatedBy"> }> = [];
    const layer = (name: string, contents: ShapeContents[], at: Vec2, exprSeed: number, amount: { scale: number; sway: number; dim: number }, effects: EffectInstance[], opacity = 100): Omit<Layer, "id" | "generatedBy"> => ({
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
      transform: {
        ...defaultTransform(0, 0),
        // Anchored at the flame's base, so it stretches and sways from there.
        position: { value: [at[0], at[1], 0] as Vec3, spatial: true, ...(amount.sway > 0 ? { expression: { src: `wiggle(${speed * 0.8}, ${amount.sway}, 2, ${exprSeed})`, enabled: true } } : {}) },
        scale: { value: [100, 100, 100] as Vec3, ...(amount.scale > 0 ? { expression: { src: `wiggle(${speed}, ${amount.scale}, 2, ${exprSeed + 1})`, enabled: true } } : {}) },
        opacity: { value: opacity, ...(amount.dim > 0 ? { expression: { src: `wiggle(${speed * 1.4}, ${amount.dim}, 2, ${exprSeed + 2})`, enabled: true } } : {}) },
      },
      masks: [],
      effects,
    });
    const blur = (r: number): EffectInstance => ({ id: "glow", type: "glow", enabled: true, params: { radius: staticProp(r), intensity: staticProp(1.1), threshold: staticProp(0) } });
    ctx.targets.forEach((tg, i) => {
      const b = pathBounds([tg.region.path]);
      const at: Vec2 = [b.x + b.w / 2, b.y + b.h * base];
      const h = Math.max(6, b.h * (num(p.size, 70) / 100) * 0.62);
      const s = seed + i * 101;
      const tongue = (k: number, c: RGBA, opacity: number, lean: number): ShapeContents => ({
        path: { kind: "path", path: staticProp(packPath(polygonPath(flameOutline(h * k, 0.44 - 0.08 * (1 - k), lean), true))) },
        fill: { color: staticProp(c), opacity: staticProp(opacity) },
      });
      if (glow > 0) {
        const r = Math.max(b.w, b.h) * 0.55;
        const ring = Array.from({ length: 32 }, (_, k) => [Math.cos((k / 32) * Math.PI * 2) * r * 0.8, -h * 0.45 + Math.sin((k / 32) * Math.PI * 2) * r] as Vec2);
        out.push({
          role: `glow-${i}`,
          layer: layer(`Torch glow ${i + 1}`, [{ path: { kind: "path", path: staticProp(packPath(polygonPath(ring, true))) }, fill: { color: staticProp(mix(col, [1, 0.8, 0.5, 1], 0.2)), opacity: staticProp(glow * 0.3) } }], at, s + 10, { scale: 4 * flick, sway: 0, dim: 18 * flick }, [{ id: "blur", type: "gaussian-blur", enabled: true, params: { radius: staticProp(r * 0.35) } }]),
        });
      }
      out.push({ role: `flame-${i}`, layer: layer(`Torch flame ${i + 1}`, [tongue(1, mix(col, [0.9, 0.15, 0.02, 1], 0.35), 85, 0.05)], at, s + 20, { scale: 16 * flick, sway: 2.5 * flick, dim: 10 * flick }, [blur(h * 0.25)]) });
      out.push({ role: `body-${i}`, layer: layer(`Torch flame body ${i + 1}`, [tongue(0.78, col, 90, -0.04)], at, s + 30, { scale: 20 * flick, sway: 2 * flick, dim: 8 * flick }, []) });
      out.push({ role: `core-${i}`, layer: layer(`Torch flame core ${i + 1}`, [tongue(0.45, mix(col, [1, 0.95, 0.75, 1], 0.75), 95, 0.02)], at, s + 40, { scale: 24 * flick, sway: 1.2 * flick, dim: 6 * flick }, []) });
    });
    return out;
  },
};

registerRecipe(torchFlames);
