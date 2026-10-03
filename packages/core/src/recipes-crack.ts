/**
 * "Crack and rebuild": glowing cracks spread across the selected parts from an impact point, the
 * pieces fall (or burst) away leaving darkness, then fly back and the surface rebuilds.
 *
 * Every piece is its own editable layer with ordinary keyframes. On a venue traced from a photo,
 * the pieces carry the photo itself (so the building appears to break); otherwise they're lit
 * slabs. Deterministic: the same seed always breaks the surface the same way.
 */
import { EASY_EASE, type Keyframe, staticProp } from "./anim.ts";
import { defaultTransform, type Layer, type Mask, packPath, type RGBA, type ShapeContents, type Vec2, type Vec3 } from "./model.ts";
import { flattenPath } from "./pathmath.ts";
import { type RecipeContext, type RecipeDef, registerRecipe } from "./recipes.ts";
import { hashString, rand01 } from "./rng.ts";
import { type Flicks, secondsToTime } from "./time.ts";

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const col = (v: unknown, d: RGBA): RGBA => (Array.isArray(v) && v.length >= 3 ? [Number(v[0]), Number(v[1]), Number(v[2]), Number(v[3] ?? 1)] : d);

/** Keep the part of a polygon on the side of the line through p with normal n where (x - p)·n ≤ 0. */
const clipHalf = (poly: Vec2[], p: Vec2, n: Vec2): Vec2[] => {
  const out: Vec2[] = [];
  const side = (q: Vec2) => (q[0] - p[0]) * n[0] + (q[1] - p[1]) * n[1];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const sa = side(a);
    const sb = side(b);
    if (sa <= 0) out.push(a);
    if (sa <= 0 !== sb <= 0) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
};

const centroid = (poly: readonly Vec2[]): Vec2 => {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i]!;
    const [x1, y1] = poly[(i + 1) % poly.length]!;
    const k = x0 * y1 - x1 * y0;
    a += k;
    cx += (x0 + x1) * k;
    cy += (y0 + y1) * k;
  }
  if (Math.abs(a) < 1e-6) return poly.reduce<Vec2>((s, q) => [s[0] + q[0] / poly.length, s[1] + q[1] / poly.length], [0, 0]);
  return [cx / (3 * a), cy / (3 * a)];
};

/** Voronoi pieces of a shape around seeded points (cells clipped to the shape). */
export const breakIntoPieces = (outline: readonly Vec2[], count: number, seed: number): Vec2[][] => {
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const seeds: Vec2[] = [];
  for (let i = 0; seeds.length < count && i < count * 20; i++) {
    const p: Vec2 = [x0 + rand01(seed, i * 2) * (x1 - x0), y0 + rand01(seed, i * 2 + 1) * (y1 - y0)];
    if (clipHalf([p], [p[0] + 1e9, 0], [1, 0]).length) seeds.push(p);
  }
  return seeds
    .map((s, i) => {
      let cell = [...outline];
      seeds.forEach((o, j) => {
        if (i === j || cell.length < 3) return;
        const mid: Vec2 = [(s[0] + o[0]) / 2, (s[1] + o[1]) / 2];
        cell = clipHalf(cell, mid, [o[0] - s[0], o[1] - s[1]]);
      });
      return cell;
    })
    .filter((c) => c.length >= 3);
};

const k3 = (id: string, t: Flicks, v: Vec3, ease: "in" | "out" | "both" | "hold"): Keyframe<Vec3> => ({
  id,
  t,
  v,
  in: ease === "hold" ? "linear" : "bezier",
  out: ease === "hold" ? "hold" : "bezier",
  // "in": accelerate away (falling), "out": decelerate into place (rebuilding).
  ...(ease === "in" ? { easeOut: [{ speed: 0, influence: 0.6 }] } : ease === "out" ? { easeIn: [{ speed: 0, influence: 0.75 }] } : ease === "both" ? { easeIn: [EASY_EASE], easeOut: [EASY_EASE] } : {}),
});
const k1 = (id: string, t: Flicks, v: number, interp: "linear" | "bezier" | "hold" = "linear"): Keyframe<number> => ({ id, t, v, in: interp === "hold" ? "linear" : interp, out: interp });

export const crackRebuild: RecipeDef = {
  id: "crack-rebuild",
  title: "Crack and rebuild",
  category: "cracks",
  description: "Glowing cracks spread across the selected parts, the pieces fall away into darkness, then fly back and rebuild.",
  keywords: ["crack", "cracks", "break", "shatter", "smash", "crumble", "fall", "explode", "destroy", "rebuild", "pieces", "collapse"],
  suits: ["window", "door", "garage", "roof", "vent", "wall", "column", "custom"],
  defaultSeconds: 8,
  params: [
    { key: "color", label: "Crack light", control: "color", default: [1, 0.82, 0.55, 1], primary: true, drives: ["source.contents"] },
    { key: "pieces", label: "Pieces", control: "slider", default: 10, min: 3, max: 40, primary: true, drives: ["source", "transform", "masks"] },
    { key: "motion", label: "How pieces move", control: "choice", default: "fall", primary: true, choices: [{ value: "fall", label: "Fall away" }, { value: "burst", label: "Burst outward" }], drives: ["transform"] },
    { key: "rebuild", label: "Rebuild afterwards", control: "toggle", default: true, primary: true, drives: ["transform"] },
    { key: "crackSeconds", label: "Cracks spread for", control: "seconds", default: 1.6, min: 0.2, max: 10, step: 0.1, unit: "s", drives: ["source.contents"] },
    { key: "hold", label: "Wait before breaking", control: "seconds", default: 0.8, min: 0, max: 10, step: 0.1, unit: "s", drives: ["transform"] },
    { key: "glow", label: "Glow", control: "slider", default: 60, min: 0, max: 100, unit: "%", drives: ["effects"] },
    { key: "glowSize", label: "Glow size", control: "slider", default: 14, min: 1, max: 80, unit: "px", drives: ["effects"] },
    { key: "crackWidth", label: "Crack width", control: "slider", default: 2.5, min: 0.5, max: 20, step: 0.5, unit: "px", drives: ["source.contents"] },
    { key: "fallSeconds", label: "Pieces fall for", control: "seconds", default: 1.3, min: 0.2, max: 10, step: 0.1, unit: "s", drives: ["transform"] },
    { key: "gone", label: "Stay gone for", control: "seconds", default: 0.9, min: 0, max: 30, step: 0.1, unit: "s", help: "With rebuild: the wait before they fly back.", drives: ["transform"] },
    { key: "backSeconds", label: "Fly back over", control: "seconds", default: 1, min: 0.2, max: 10, step: 0.1, unit: "s", drives: ["transform"] },
    { key: "throw", label: "Throw distance", control: "slider", default: 100, min: 10, max: 300, unit: "%", drives: ["transform"] },
    { key: "spin", label: "Spin", control: "slider", default: 100, min: 0, max: 400, unit: "%", drives: ["transform"] },
    { key: "seed", label: "Variation", control: "seed", default: 4, drives: ["source", "transform"] },
    { key: "seconds", label: "Duration", control: "seconds", default: 8, min: 1, max: 600, step: 0.5, unit: "s", drives: ["outPoint"] },
  ],
  generate: (ctx: RecipeContext) => {
    const p = ctx.params;
    const light = col(p.color, [1, 0.82, 0.55, 1]);
    const count = Math.max(3, Math.min(40, Math.round(num(p.pieces, 10))));
    const burst = p.motion === "burst";
    const rebuild = p.rebuild !== false;
    const crackT = Math.max(0.2, num(p.crackSeconds, 1.6));
    const hold = Math.max(0, num(p.hold, 0.8));
    const seed = (hashString(ctx.instanceId.replace(/_preview$/, "")) ^ Math.round(num(p.seed, 4) * 7919)) >>> 0;
    const t0 = ctx.startTime;
    const at = (s: number) => t0 + secondsToTime(s);
    const end = Math.min(ctx.comp.duration, t0 + secondsToTime(num(p.seconds, 8)));
    const breakAt = crackT + hold;
    const fallFor = Math.max(0.2, num(p.fallSeconds, 1.3));
    const backFor = Math.max(0.2, num(p.backSeconds, 1));
    const backAt = breakAt + fallFor + Math.max(0, num(p.gone, 0.9));
    const doneAt = backAt + backFor + 0.2;
    const throwK = Math.max(0.1, num(p.throw, 100) / 100);
    const spinK = Math.max(0, num(p.spin, 100) / 100);

    // The venue photo, when there is one, so the pieces carry the real surface.
    const venue = ctx.project.activeVenueId ? ctx.project.venues[ctx.project.activeVenueId] : undefined;
    const photo = venue?.referenceAssetId ? ctx.project.assets[venue.referenceAssetId] : undefined;
    const photoScale = photo?.meta.width && venue ? venue.canvas.width / photo.meta.width : 1;

    const base = (name: string): Omit<Layer, "id" | "generatedBy" | "source"> => ({
      name,
      startTime: 0,
      inPoint: t0,
      outPoint: Math.max(end, t0 + 1),
      stretch: 1,
      enabled: true,
      solo: false,
      locked: false,
      audioEnabled: false,
      is3D: false,
      blendMode: "normal",
      transform: defaultTransform(0, 0),
      masks: [],
      effects: [],
    });

    const holes: ShapeContents[] = [];
    const cracks: ShapeContents[] = [];
    const pieces: Array<{ role: string; layer: Omit<Layer, "id" | "generatedBy"> }> = [];
    ctx.targets.forEach((tg, ti) => {
      const outline = flattenPath(tg.region.path, 8);
      if (outline.length < 3) return;
      const regionSeed = (seed + ti * 977) >>> 0;
      const cells = breakIntoPieces(outline, count, regionSeed);
      const [cx, cy] = centroid(outline);
      // Impact point: somewhere near the middle; cracks reach pieces in order of distance.
      const impact: Vec2 = [cx + (rand01(regionSeed, 900) - 0.5) * 0.4 * (Math.max(...outline.map((q) => q[0])) - Math.min(...outline.map((q) => q[0]))), cy + (rand01(regionSeed, 901) - 0.5) * 0.3 * (Math.max(...outline.map((q) => q[1])) - Math.min(...outline.map((q) => q[1])))];
      const far = Math.max(1, ...cells.map((c) => Math.hypot(centroid(c)[0] - impact[0], centroid(c)[1] - impact[1])));
      holes.push({ path: { kind: "region", ref: tg.ref }, fill: { color: staticProp<RGBA>([0, 0, 0, 1]), opacity: { value: 0, keyframes: [k1(`${ctx.instanceId}_h${ti}a`, at(breakAt), 0), k1(`${ctx.instanceId}_h${ti}b`, at(breakAt + 0.15), 100), ...(rebuild ? [k1(`${ctx.instanceId}_h${ti}c`, at(doneAt - 0.1), 100), k1(`${ctx.instanceId}_h${ti}d`, at(doneAt), 0)] : [])] } } });
      cells.forEach((cell, ci) => {
        const c = centroid(cell);
        const d = Math.hypot(c[0] - impact[0], c[1] - impact[1]) / far;
        const id = `${ctx.instanceId}_${ti}_${ci}`;
        // Crack along the piece's edge, drawn on as the crack front reaches it.
        const drawFrom = d * crackT * 0.75;
        cracks.push({
          path: { kind: "path", path: staticProp(packPath({ closed: true, vertices: cell.map((q) => ({ p: q })) })) },
          stroke: {
            color: staticProp(light),
            width: staticProp(Math.max(0.5, num(p.crackWidth, 2.5))),
            opacity: { value: 100, keyframes: [k1(`${id}_co0`, at(breakAt), 100), k1(`${id}_co1`, at(breakAt + 0.3), 0), ...(rebuild ? [k1(`${id}_co2`, at(backAt + 0.9), 0), k1(`${id}_co3`, at(doneAt), 100, "bezier"), k1(`${id}_co4`, at(doneAt + 0.8), 0)] : [])] },
            cap: "round",
            join: "round",
          },
          trim: { start: staticProp(0), end: { value: 0, keyframes: [k1(`${id}_t0`, at(drawFrom), 0, "bezier"), k1(`${id}_t1`, at(drawFrom + crackT * 0.25), 100, "bezier")] }, offset: staticProp(rand01(regionSeed, 300 + ci) * 360) },
        });
        // Where the piece goes: down and spinning (fall) or out from the impact (burst).
        const r = (k: number) => rand01(regionSeed, 1000 + ci * 8 + k);
        const thrown: Vec2 = burst
          ? [(c[0] - impact[0]) * (1.5 + r(0) * 2) + (r(1) - 0.5) * 80, (c[1] - impact[1]) * (1.5 + r(2) * 2) + 200 + r(3) * 250]
          : [(r(0) - 0.5) * 120, ctx.comp.height * (0.7 + r(1) * 0.5)];
        const away: Vec2 = [thrown[0] * throwK, thrown[1] * throwK];
        const spin = (r(4) - 0.5) * (burst ? 540 : 220) * spinK;
        const start = at(breakAt + d * 0.35);
        const home: Vec3 = [c[0], c[1], 0];
        const gone: Vec3 = [c[0] + away[0], c[1] + away[1], 0];
        const pos = { value: home, spatial: true, keyframes: [k3(`${id}_p0`, start, home, "in"), k3(`${id}_p1`, at(breakAt + d * 0.35 + fallFor), gone, rebuild ? "hold" : "in"), ...(rebuild ? [k3(`${id}_p2`, at(backAt + d * 0.3), gone, "out"), k3(`${id}_p3`, at(backAt + d * 0.3 + backFor), home, "out")] : [])] };
        const rot = { value: [0, 0, 0] as Vec3, keyframes: [k3(`${id}_r0`, start, [0, 0, 0], "in"), k3(`${id}_r1`, at(breakAt + d * 0.35 + fallFor), [0, 0, spin], rebuild ? "hold" : "in"), ...(rebuild ? [k3(`${id}_r2`, at(backAt + d * 0.3), [0, 0, spin], "out"), k3(`${id}_r3`, at(backAt + d * 0.3 + backFor), [0, 0, 0], "out")] : [])] };
        const piecePath = packPath({ closed: true, vertices: cell.map((q) => ({ p: [q[0] - c[0], q[1] - c[1]] as Vec2 })) });
        if (photo) {
          // The photo, masked to the piece; anchored at the piece's centre so it turns about it.
          const s = photoScale;
          const mask: Mask = { id: `${id}_m`, name: "Piece", source: { kind: "path", path: staticProp(packPath({ closed: true, vertices: cell.map((q) => ({ p: [q[0] / s, q[1] / s] as Vec2 })) })) }, mode: "add", inverted: false, feather: staticProp(0.5), expansion: staticProp(0), opacity: staticProp(100) };
          pieces.push({
            role: `piece-${ti}-${ci}`,
            layer: { ...base(`Piece ${ci + 1}`), source: { kind: "footage", assetId: photo.id }, transform: { ...defaultTransform(0, 0), anchor: staticProp<Vec3>([c[0] / s, c[1] / s, 0]), position: pos, scale: staticProp<Vec3>([s * 100, s * 100, 100]), rotation: rot }, masks: [mask] },
          });
        } else {
          pieces.push({
            role: `piece-${ti}-${ci}`,
            layer: {
              ...base(`Piece ${ci + 1}`),
              source: { kind: "shape", contents: [{ path: { kind: "path", path: staticProp(piecePath) }, fill: { color: staticProp<RGBA>([0.78, 0.8, 0.86, 1]), opacity: { value: 0, keyframes: [k1(`${id}_f0`, at(breakAt - 0.05), 0), k1(`${id}_f1`, at(breakAt), 85), ...(rebuild ? [k1(`${id}_f2`, at(doneAt), 85), k1(`${id}_f3`, at(doneAt + 0.4), 0)] : [])] } } }] },
              transform: { ...defaultTransform(0, 0), position: pos, rotation: rot },
            },
          });
        }
      });
    });

    const glow = num(p.glow, 60);
    return [
      {
        role: "cracks",
        layer: {
          ...base("Cracks"),
          source: { kind: "shape", contents: cracks },
          blendMode: "add",
          effects: [{ id: `${ctx.instanceId}_glow`, type: "glow", enabled: glow > 0, params: { radius: staticProp(Math.max(1, num(p.glowSize, 14))), intensity: staticProp(glow / 50), threshold: staticProp(0) } }],
        },
      },
      ...pieces,
      { role: "holes", layer: { ...base("Darkness behind"), source: { kind: "shape", contents: holes } } },
    ];
  },
};

registerRecipe(crackRebuild);
