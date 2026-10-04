/**
 * Journey steps for compositing (after the effect steps, on the house they set up): "Adjust these
 * areas" in Content makes an adjustment layer limited to the selected area, a blur added from the
 * layer panel changes the picture only inside it, every blend mode is offered and one that reads the
 * picture below changes it, and "Show only through" sets a track matte (that layer stops being drawn
 * itself) and clears it. Everything is undone afterwards. Skipped when the house isn't there.
 */
import { evaluateComp, secondsToTime } from "@be/core";
import { currentPreviewLoop } from "./preview/PreviewPanel.tsx";
import { activeVenue, currentComp, useStudio } from "./studio/store.ts";

type Step = () => Promise<{ ok: boolean; note?: string; settle?: number }>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, timeout = 5000) => {
  const t0 = performance.now();
  while (!fn()) {
    if (performance.now() - t0 > timeout) return false;
    await sleep(80);
  }
  return true;
};
const click = (el: Element | null | undefined) => {
  if (!el) throw new Error("element not found");
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
};
const byText = (sel: string, text: string): HTMLElement | null => [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.trim().startsWith(text)) ?? null;
/** Pick an option the way a person does (React sees a change event). */
const choose = (el: HTMLSelectElement | null, value: string) => {
  if (!el) throw new Error("list not found");
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
};
const slide = (el: HTMLInputElement | null, value: number) => {
  if (!el) throw new Error("slider not found");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, String(value));
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const st = () => useStudio.getState();
const comp = () => currentComp(st())!;
const topLayer = () => comp().layers[comp().layerOrder[0]!]!;
const select = (label: string) => document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);

/** The preview once it stops changing, as luminance in a grid of blocks over the composition. */
const NX = 64, NY = 36;
const sample = async () => {
  let prev = "";
  let blocks = new Float32Array(NX * NY);
  for (let i = 0; i < 25; i++) {
    await sleep(160);
    const s = await currentPreviewLoop()?.sample();
    if (!s?.pixels) continue;
    const b = new Float32Array(NX * NY), n = new Float32Array(NX * NY);
    for (let y = 0; y < s.height; y++)
      for (let x = 0; x < s.width; x++) {
        const k = Math.min(NY - 1, Math.floor((y / s.height) * NY)) * NX + Math.min(NX - 1, Math.floor((x / s.width) * NX));
        const p = (y * s.width + x) * 4;
        b[k] = b[k]! + 0.2126 * s.pixels[p + 2]! + 0.7152 * s.pixels[p + 1]! + 0.0722 * s.pixels[p]!;
        n[k] = n[k]! + 1;
      }
    for (let k = 0; k < b.length; k++) b[k] = b[k]! / Math.max(1, n[k]!);
    blocks = b;
    const sig = `${s.mean.toFixed(3)}/${s.spread.toFixed(3)}`;
    if (sig === prev) break;
    prev = sig;
  }
  return blocks;
};
/** Mean change between two samples inside and outside a rectangle (composition pixels). */
const change = (a: Float32Array, b: Float32Array, r: { x: number; y: number; w: number; h: number }) => {
  const { width: W, height: H } = comp();
  let din = 0, nin = 0, dout = 0, nout = 0;
  for (let k = 0; k < a.length; k++) {
    // Blocks wholly inside, or well clear of, the rectangle (a blur spreads a little past its edge).
    const x0 = ((k % NX) / NX) * W, x1 = (((k % NX) + 1) / NX) * W, y0 = (Math.floor(k / NX) / NY) * H, y1 = ((Math.floor(k / NX) + 1) / NY) * H;
    const d = Math.abs(a[k]! - b[k]!);
    if (x0 >= r.x && x1 <= r.x + r.w && y0 >= r.y && y1 <= r.y + r.h) (din += d), nin++;
    else if (x1 < r.x - 80 || x0 > r.x + r.w + 80 || y1 < r.y - 80 || y0 > r.y + r.h + 80) (dout += d), nout++;
  }
  return { inside: din / Math.max(1, nin), outside: dout / Math.max(1, nout) };
};

let skip = "";
const skipped = () => ({ ok: true, note: `SKIPPED: ${skip}` });
let undoTo = 0;
let window0: { x: number; y: number; w: number; h: number } | null = null;
let before = new Float32Array(0);

export const COMPOSITING_STEPS: Record<string, Step> = {
  "comp-adjust-areas": async () => {
    const venue = activeVenue({ project: st().project! });
    const win = Object.values(venue?.regions ?? {}).find((r) => r.name === "Window");
    if (!win) {
      skip = "no house with a window";
      return skipped();
    }
    skip = "";
    undoTo = st().history!.transactions().length;
    const xs = win.path.vertices.map((v) => v.p[0]), ys = win.path.vertices.map((v) => v.p[1]);
    window0 = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    useStudio.setState({ step: "content" });
    st().setPlaying(false);
    st().setTime(secondsToTime(1));
    st().selectLayer(null);
    st().selectRegions([win.id]);
    before = await sample();
    await until(() => !!byText("button", "Adjust these areas"));
    click(byText("button", "Adjust these areas"));
    const made = await until(() => topLayer().source.kind === "adjustment");
    const l = topLayer();
    const src = l.masks[0]?.source;
    const limited = l.masks.length === 1 && src?.kind === "region" && (src.ref.regionIds ?? []).includes(win.id);
    // The layer panel opens on it: add a blur and make it strong.
    await until(() => !!byText("button", "+ Blur"));
    click(byText("button", "+ Blur"));
    const blurred = await until(() => topLayer().effects.some((e) => e.type === "gaussian-blur"));
    await until(() => !!document.querySelector('input[aria-label="Blur Radius"]'));
    slide(document.querySelector('input[aria-label="Blur Radius"]'), 40);
    await until(() => (topLayer().effects[0]?.params.radius?.value as number) === 40);
    const after = await sample();
    const c = change(before, after, window0);
    return {
      ok: made && limited && blurred && st().selection.layerId === l.id && c.inside > 2 && c.outside < 0.5,
      note: `“${l.name}” added on top, limited to the Window area; blur (radius 40) added from the layer panel: the picture changed by ${c.inside.toFixed(1)}/255 inside the window, ${c.outside.toFixed(2)}/255 away from it`,
      settle: 400,
    };
  },
  "comp-blend-modes": async () => {
    if (skip) return skipped();
    const list = select("Mix with what's below");
    const offered = list ? list.options.length : 0;
    const blurredOnly = await sample();
    choose(list, "difference");
    const set = await until(() => topLayer().blendMode === "difference");
    const diff = await sample();
    const c = change(blurredOnly, diff, window0!);
    choose(select("Mix with what's below"), "normal");
    const back = await until(() => topLayer().blendMode === "normal");
    return {
      ok: offered === 17 && set && back && c.inside > 2 && c.outside < 0.5,
      note: `${offered} ways to mix offered; “Difference” on the adjustment changed the window by ${c.inside.toFixed(1)}/255 (${c.outside.toFixed(2)}/255 elsewhere); back to Cover`,
    };
  },
  "comp-show-through": async () => {
    if (skip) return skipped();
    const l = topLayer();
    const list = select("Show only through");
    const drawn = () => evaluateComp(st().project!, comp().id, st().time).layers.map((x) => x.id);
    // A layer that's drawn at this moment, so its disappearing shows.
    const other = list ? [...list.options].map((o) => o.value).find((v) => v && drawn().includes(v)) : undefined;
    if (!other) return { ok: false, note: "no layer drawn here offered to show through" };
    choose(list, other);
    const set = await until(() => topLayer().trackMatte?.layerId === other);
    const hidden = !drawn().includes(other);
    await until(() => !!select("Where it shows"));
    choose(select("Where it shows"), "luma-inverted");
    const mode = await until(() => topLayer().trackMatte?.mode === "luma-inverted");
    choose(select("Show only through"), "");
    const cleared = await until(() => !topLayer().trackMatte);
    const back = drawn().includes(other);
    return { ok: set && hidden && mode && cleared && back, note: `“${l.name}” shown only through “${comp().layers[other]!.name}” (which then isn't drawn itself), where it's dark; cleared, and that layer is drawn again` };
  },
  "comp-undo": async () => {
    if (skip) return skipped();
    let n = 0;
    while (st().history!.transactions().length > undoTo && n < 50) {
      st().undo();
      n++;
    }
    const gone = await until(() => topLayer().source.kind !== "adjustment");
    const after = await sample();
    const c = change(before, after, window0!);
    return { ok: gone && c.inside < 1 && c.outside < 0.5, note: `${n} steps undone: the adjustment layer is gone and the window looks as before (${c.inside.toFixed(2)}/255)` };
  },
};
