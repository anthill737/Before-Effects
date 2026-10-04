/**
 * 3D acceptance, measured on the rendered picture, on a porch house drawn here (so the test needs
 * nothing from outside the repository): two columns standing 1.5 m out from the wall, and a garage
 * with the wall above it as its own panel. Built through the agent API, the way a show is.
 *
 *   - occlusion: a figure walking along the porch, between the wall and the columns, is hidden while
 *     it's behind a column and seen either side of it;
 *   - moving shadows: a lantern carried along in front throws the columns' shadows on the wall where
 *     the geometry says they fall (from its position and the columns' depth), and they move with it;
 *   - impact: a ball thrown into the wall above the garage breaks a hole only around the hit and
 *     inward — the inside shows dark, nothing falls out onto the front, the ball goes in.
 *
 * The building is 1920×1080 canvas pixels at 1 cm a pixel: x metres from its middle, heights in
 * metres from the bottom of the canvas, depth in metres toward the audience.
 */
import { sceneCameraDistance, secondsToTime } from "@be/core";
import { dispatch } from "./agent/core.ts";
import { currentPreviewLoop } from "./preview/PreviewPanel.tsx";
import { usePreview } from "./preview/settings.ts";
import { getRenderer } from "./studio/engineHost.ts";
import { useStudio } from "./studio/store.ts";

type Result = { ok: boolean; note?: string; settle?: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const st = () => useStudio.getState();

let calls = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async (method: string, params: Record<string, unknown> = {}): Promise<any> => {
  calls++;
  const r = await dispatch({ callId: `uitest3d-${calls}`, requestId: `uitest3d-${calls}`, method, params });
  if (!r.ok) throw new Error(`${method}: ${r.error?.message ?? "failed"}`);
  return r.result;
};

// ---- the drawn porch house ---------------------------------------------------------------------

const W = 1920;
const H = 1080;
const FACADE = { x: 260, y: 300, w: 1400, h: 700 };
const COLUMNS = [
  { name: "Column 1", x: 560, y: 520, w: 60, h: 480 },
  { name: "Column 2", x: 860, y: 520, w: 60, h: 480 },
];
const GARAGE = { x: 1200, y: 700, w: 400, h: 300 };
const ABOVE = { x: 1200, y: 480, w: 400, h: 220 };
/** The porch floor (the bottom of the columns), metres above the bottom of the canvas. */
const FLOOR_M = (H - 1000) / 100;
const STAND_OUT_M = 1.5;
const COLUMN_DEPTH_M = 0.3;
const mx = (px: number) => (px - W / 2) / 100;
const px = (m: number) => Math.round(m * 100 + W / 2);
const pyOf = (heightM: number) => Math.round(H - heightM * 100);

const drawPorchHouse = async (): Promise<Blob> => {
  const c = new OffscreenCanvas(W, H);
  const g = c.getContext("2d")!;
  g.fillStyle = "#1d2433";
  g.fillRect(0, 0, W, H);
  g.fillStyle = "#d8d2c4";
  g.fillRect(FACADE.x, FACADE.y, FACADE.w, FACADE.h);
  g.fillStyle = "#c9c2b2";
  g.fillRect(ABOVE.x, ABOVE.y, ABOVE.w, ABOVE.h);
  g.fillStyle = "#8e8a82";
  g.fillRect(GARAGE.x, GARAGE.y, GARAGE.w, GARAGE.h);
  g.fillStyle = "#f2efe8";
  for (const col of COLUMNS) g.fillRect(col.x, col.y, col.w, col.h);
  g.fillStyle = "#4a4a4a";
  g.fillRect(0, 1000, W, 80);
  return c.convertToBlob({ type: "image/png" });
};

/** A figure for the porch: a bright cut-out, narrower than a column (so a column can hide it). */
const drawFigure = async (): Promise<Blob> => {
  const c = new OffscreenCanvas(100, 400);
  const g = c.getContext("2d")!;
  g.fillStyle = "#ff2fd0";
  g.beginPath();
  g.arc(50, 50, 40, 0, Math.PI * 2);
  g.fill();
  g.fillRect(15, 95, 70, 305);
  return c.convertToBlob({ type: "image/png" });
};

const writeBlob = async (name: string, blob: Blob): Promise<string> => {
  const path = `${(await window.be.app.paths()).renders}\\ui-test\\${name}`;
  await window.be.files.writeBinary(path, new Uint8Array(await blob.arrayBuffer()));
  return path;
};

// ---- the picture -------------------------------------------------------------------------------

interface Shot {
  readonly w: number;
  readonly h: number;
  /** BGRA. */
  readonly px: Uint8Array;
}

/** The show as rendered at `seconds` (once media and prepared physics are in). */
const shotAt = async (seconds: number): Promise<Shot> => {
  const loop = currentPreviewLoop();
  if (!loop) throw new Error("no preview");
  st().setPlaying(false);
  st().setTime(secondsToTime(seconds));
  const r = await getRenderer();
  const t0 = performance.now();
  await sleep(150);
  let s = await loop.sample();
  while ((r.lastFrameIncomplete || !s.pixels) && performance.now() - t0 < 60_000) {
    await sleep(200);
    s = await loop.sample();
  }
  if (!s.pixels || s.width !== W || s.height !== H) throw new Error(`capture ${s.width}×${s.height}${s.pixels ? "" : " (none)"}`);
  return { w: s.width, h: s.height, px: s.pixels };
};

/** Mean absolute colour difference over a box (canvas pixels). */
const diff = (a: Shot, b: Shot, box: { x0: number; x1: number; y0: number; y1: number }): number => {
  let sum = 0;
  let n = 0;
  for (let y = Math.max(0, box.y0); y < Math.min(H, box.y1); y++)
    for (let x = Math.max(0, box.x0); x < Math.min(W, box.x1); x++) {
      const i = (y * W + x) * 4;
      sum += Math.abs(a.px[i]! - b.px[i]!) + Math.abs(a.px[i + 1]! - b.px[i + 1]!) + Math.abs(a.px[i + 2]! - b.px[i + 2]!);
      n++;
    }
  return n ? sum / n / 3 : 0;
};
const level = (s: Shot, x: number, y: number) => {
  const i = (y * W + x) * 4;
  return s.px[i]! + s.px[i + 1]! + s.px[i + 2]!;
};

// ---- building it ---------------------------------------------------------------------------------

let built = false;
const objectNamed = async (scene: string, start: string): Promise<{ id: string; position: [number, number, number] }> => {
  const o = (await call("scene3d.get", { scene })).objects.find((x: { name: string }) => x.name.startsWith(start));
  if (!o) throw new Error(`no object "${start}"`);
  return o;
};
/** A scene with the whole house in 3D. */
const houseScene = async (name: string, seconds: number): Promise<string> => {
  await call("scenes.create", { name });
  await call("playback.set", { seconds: 0, playing: false });
  return (await call("scene3d.createHouse", { name: `${name} (3D house)`, seconds })).scene;
};

export const STEPS_3D: Record<string, () => Promise<Result>> = {
  "accept3d-porch-house": async () => {
    const photo = await writeBlob("accept3d-porch-house.png", await drawPorchHouse());
    await call("project.newFromPhoto", { photo, discardChanges: true });
    const area = (kind: string, name: string, r: { x: number; y: number; w: number; h: number }) => call("areas.create", { kind, name, rect: r, select: false });
    await area("wall", "Facade", FACADE);
    for (const c of COLUMNS) await area("column", c.name, c);
    await area("garage", "Garage door", GARAGE);
    await area("wall", "Wall above the garage", ABOVE);
    for (const c of COLUMNS) await call("areas.update", { area: c.name, standOutCm: STAND_OUT_M * 100, thicknessCm: COLUMN_DEPTH_M * 100 });
    await call("areas.update", { area: "Wall above the garage", standOutCm: 0, thicknessCm: 30 });
    // The wall above the garage is its own piece (it can break on its own): cut out of the facade.
    const { areas } = await call("areas.list", {});
    const id = (n: string) => areas.find((a: { name: string }) => a.name === n).id;
    const venueId = st().project!.activeVenueId!;
    await call("ops.apply", { operations: [{ type: "region.update", args: { venueId, regionId: id("Facade"), changes: { cutouts: [id("Wall above the garage")] } } }] });
    // To the studio, where the show plays.
    st().setStep("animate");
    const t0 = performance.now();
    while (!currentPreviewLoop() && performance.now() - t0 < 10_000) await sleep(100);
    usePreview.getState().set({ view: "show", resolution: "full", playbackMode: "realtime" });
    built = !!currentPreviewLoop();
    return { ok: areas.length === 5, note: `drawn porch house ${W}×${H}: ${areas.map((a: { name: string }) => a.name).join(", ")}; columns stand ${STAND_OUT_M} m out` };
  },

  "accept3d-behind-column": async () => {
    if (!built) return { ok: false, note: "needs accept3d-porch-house" };
    const scene = await houseScene("Behind the column", 6);
    const figure = await writeBlob("accept3d-figure.png", await drawFigure());
    // Between the wall and the columns' fronts (0.75 m out), on the porch floor, 1.6 m tall (0.4 m wide).
    const fig = (await call("scene3d.objectAdd", { scene, kind: "picture", picture: figure, name: "Figure", heightM: 1.6, xM: -3, aheadM: 0.75, standsAtM: FLOOR_M })).object;
    const at = (await objectNamed(scene, "Figure")).position;
    await call("scene3d.objectKeyframe", { scene, object: fig, property: "position", seconds: 0, value: [-3, at[1], at[2]], ease: "linear" });
    await call("scene3d.objectKeyframe", { scene, object: fig, property: "position", seconds: 6, value: [1.6, at[1], at[2]], ease: "linear" });
    // Column 2's middle: x −0.7 m, reached at 3 s.
    const col = COLUMNS[1]!;
    const behindAt = ((mx(col.x + col.w / 2) + 3) / 4.6) * 6;
    const xAt = (t: number) => -3 + (4.6 * t) / 6;
    const box = (t: number) => ({ x0: px(xAt(t)) - 25, x1: px(xAt(t)) + 25, y0: 1000 - 150, y1: 1000 - 20 });
    const colBox = { x0: col.x + 4, x1: col.x + col.w - 4, y0: col.y + 4, y1: 1000 - 4 };
    const shots: Record<string, number> = {};
    for (const [label, t] of [["before", 1], ["behind", behindAt], ["after", 5]] as const) {
      await call("scene3d.objectUpdate", { scene, object: fig, visible: true });
      const seen = await shotAt(t);
      await call("scene3d.objectUpdate", { scene, object: fig, visible: false });
      const without = await shotAt(t);
      shots[label] = label === "behind" ? diff(seen, without, colBox) : diff(seen, without, box(t));
    }
    await call("scene3d.objectUpdate", { scene, object: fig, visible: true });
    const ok = shots.behind! < 2 && shots.before! > 25 && shots.after! > 25;
    return { ok, note: `figure behind Column 2 at ${behindAt.toFixed(2)} s: the column's pixels change ${shots.behind!.toFixed(2)} (hidden if < 2); seen before ${shots.before!.toFixed(1)} and after ${shots.after!.toFixed(1)} (seen if > 25)` };
  },

  "accept3d-moving-shadows": async () => {
    if (!built) return { ok: false, note: "needs accept3d-porch-house" };
    const scene = await houseScene("Moving shadows", 6);
    // A dim evening: the picture's own light low, so the lantern's light and shadows read.
    await call("scene3d.objectUpdate", { scene, object: (await objectNamed(scene, "Key light")).id, light: { intensity: 0.5 } });
    await call("scene3d.objectUpdate", { scene, object: (await objectNamed(scene, "Soft fill")).id, light: { intensity: 0.12 } });
    const lantern = (await call("scene3d.objectAdd", { scene, kind: "light", name: "Lantern" })).object;
    const LZ = 3.5;
    const LY = 3.2;
    await call("scene3d.objectUpdate", { scene, object: lantern, name: "Lantern", light: { type: "point", intensity: 0.12, castShadow: true, softness: 0.3, color: [1, 0.78, 0.45, 1], balance: false } });
    await call("scene3d.objectKeyframe", { scene, object: lantern, property: "position", seconds: 0, value: [-6.5, LY, LZ], ease: "linear" });
    await call("scene3d.objectKeyframe", { scene, object: lantern, property: "position", seconds: 6, value: [6.5, LY, LZ], ease: "linear" });
    // Where each column's shadow falls on the wall (z 0): its edges seen from the lantern. A column
    // standing out is placed along the audience's lines of sight (it still covers its picture from
    // the camera, camD metres away), so its solid is a little nearer the middle than its picture.
    const camD = sceneCameraDistance(st().project!, st().project!.scenes3d![scene]!, st().project!.activeVenueId ?? undefined) * W / 100;
    const predicted = (lx: number) =>
      COLUMNS.map((c) => {
        const xs: number[] = [];
        for (const x of [mx(c.x), mx(c.x + c.w)])
          for (const z of [STAND_OUT_M, STAND_OUT_M - COLUMN_DEPTH_M]) {
            const solid = (x * (camD - z)) / camD;
            xs.push(lx + ((solid - lx) * LZ) / (LZ - z));
          }
        return { name: c.name, from: px(Math.min(...xs)), to: px(Math.max(...xs)) };
      });
    const y0 = 660;
    const y1 = 860;
    const rows: string[] = [];
    let ok = true;
    const centres: Record<string, Array<[number, number]>> = {};
    for (const t of [1, 2, 3, 4, 5]) {
      const lx = -6.5 + (13 * t) / 6;
      await call("scene3d.objectUpdate", { scene, object: lantern, light: { castShadow: true, intensity: 0.12 } });
      const withShadow = await shotAt(t);
      await call("scene3d.objectUpdate", { scene, object: lantern, light: { castShadow: false } });
      const plain = await shotAt(t);
      await call("scene3d.objectUpdate", { scene, object: lantern, light: { intensity: 0 } });
      const off = await shotAt(t);
      // Per picture column: the share of the lantern's light its shadow takes away (where it lights at all).
      const shadowed: boolean[] = [];
      for (let x = 0; x < W; x++) {
        let frac = 0;
        for (let y = y0; y < y1; y++) {
          const lamp = level(plain, x, y) - level(off, x, y);
          const lost = level(plain, x, y) - level(withShadow, x, y);
          frac += lamp > 6 ? lost / lamp : 0;
        }
        shadowed.push(frac / (y1 - y0) > 0.5);
      }
      const runs: Array<[number, number]> = [];
      for (let x = 0; x < W; x++) {
        if (!shadowed[x]) continue;
        const s = x;
        while (x < W && shadowed[x]) x++;
        if (x - s > 8) runs.push([s, x - 1]);
      }
      const pred = predicted(lx);
      const matched = runs.map((r) => ({ r, col: pred.find((p) => r[0] >= p.from - 10 && r[1] <= p.to + 10) }));
      for (const m of matched) if (m.col) (centres[m.col.name] ??= []).push([t, (m.r[0] + m.r[1]) / 2]);
      // Every shadow measured lies where a column's shadow should fall, and there is one.
      ok &&= runs.length > 0 && matched.every((m) => m.col);
      rows.push(`${t} s lantern x ${lx.toFixed(1)} m: ${matched.map((m) => `${m.r[0]}–${m.r[1]} px ${m.col?.name ?? "UNEXPECTED"}`).join(", ") || "no shadow"} (predicted ${pred.map((p) => `${p.from}–${p.to}`).join(", ")})`);
    }
    // The shadows move: as the lantern goes right, a column's shadow goes left.
    const moving = Object.values(centres).some((c) => c.length >= 2 && c.at(-1)![1] < c[0]![1] - 40);
    await call("scene3d.objectUpdate", { scene, object: lantern, light: { castShadow: true, intensity: 0.12 } });
    return { ok: ok && moving, note: `${rows.join("; ")}; shadows ${moving ? "move against the lantern" : "DON'T MOVE"}` };
  },

  "accept3d-impact": async () => {
    if (!built) return { ok: false, note: "needs accept3d-porch-house" };
    const scene = await houseScene("Ball through the wall", 5);
    const wall = (await objectNamed(scene, "Wall above the garage")).id;
    const fracture = { trigger: "impact", impactRadius: 0.75, impactSpeed: 3, pieceSize: 40, pattern: "bricks", collapseAt: 0, rebuildAt: null, push: 0, spin: 0.3 };
    await call("scene3d.objectUpdate", { scene, object: wall, physics: { body: "dynamic", mass: 1800, friction: 0.7, bounce: 0.05 }, fracture });
    // A ball thrown from 6 m out: it follows its animation, then flies on at 1 s (12 m/s at the wall).
    const ball = (await call("scene3d.objectAdd", { scene, kind: "ball", name: "Ball" })).object;
    const hx = mx(ABOVE.x + ABOVE.w / 2);
    await call("scene3d.objectUpdate", { scene, object: ball, material: { style: "color", color: [0.1, 1, 0.2, 1] }, physics: { body: "dynamic", mass: 6, friction: 0.5, bounce: 0.1, releaseAt: 1 } });
    await call("scene3d.objectKeyframe", { scene, object: ball, property: "position", seconds: 0, value: [hx, 5.0, 7.2], ease: "linear" });
    await call("scene3d.objectKeyframe", { scene, object: ball, property: "position", seconds: 0.9, value: [hx, 5.0, 6.0], ease: "linear" });
    await call("scene3d.objectKeyframe", { scene, object: ball, property: "position", seconds: 1, value: [hx, 5.12, 4.8], ease: "linear" });
    const end = await shotAt(4);
    // The same moment with no throw and no breaking: what the picture would be.
    await call("scene3d.objectUpdate", { scene, object: ball, visible: false, physics: null });
    await call("scene3d.objectUpdate", { scene, object: wall, fracture: null, physics: null });
    const whole = await shotAt(4);
    // Where the ball hit: the middle of the hole (most changed), expected near the wall's middle.
    let n = 0;
    let far = 0;
    let sx = 0;
    let sy = 0;
    const changed: Array<[number, number]> = [];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (Math.abs(end.px[i]! - whole.px[i]!) + Math.abs(end.px[i + 1]! - whole.px[i + 1]!) + Math.abs(end.px[i + 2]! - whole.px[i + 2]!) > 60) changed.push([x, y]);
      }
    for (const [x, y] of changed) (sx += x), (sy += y), n++;
    const cx = n ? sx / n : 0;
    const cy = n ? sy / n : 0;
    for (const [x, y] of changed) if (Math.hypot(x - cx, y - cy) > 140) far++;
    const onWall = cx > ABOVE.x && cx < ABOVE.x + ABOVE.w && cy > ABOVE.y && cy < ABOVE.y + ABOVE.h;
    let dark = 0;
    let m = 0;
    for (let y = Math.round(cy) - 20; y < Math.round(cy) + 20; y++)
      for (let x = Math.round(cx) - 20; x < Math.round(cx) + 20; x++) {
        dark += level(end, x, y) / 3;
        m++;
      }
    dark /= Math.max(1, m);
    let green = 0;
    for (let i = 0; i < end.px.length; i += 4) if (end.px[i + 1]! > 170 && end.px[i]! < 110 && end.px[i + 2]! < 110) green++;
    const ok = n > 2000 && far < 150 && onWall && dark < 25 && green < 50;
    return { ok, note: `hole ${n} pixels around (${Math.round(cx)}, ${Math.round(cy)}) ${onWall ? "on the wall above the garage" : "OFF THE WALL"}; ${far} changed further than 1.4 m from it (local if < 150); hole middle brightness ${dark.toFixed(1)} (dark inside if < 25); ball pixels left in front ${green} (went in if < 50)` };
  },
};
