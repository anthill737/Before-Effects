/**
 * Journey steps for compositing (after the effect steps, on the house they set up): "Adjust these
 * areas" in Content makes an adjustment layer limited to the selected area, a blur added from the
 * layer panel changes the picture only inside it, every blend mode is offered and one that reads the
 * picture below changes it, and "Show only through" sets a track matte (that layer stops being drawn
 * itself) and clears it. Everything is undone afterwards. Skipped when the house isn't there.
 */
import { type BlendMode, evaluateComp, newLayer, secondsToTime, staticProp } from "@be/core";
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
/** A choice shown as a list, or as buttons when there are only a few: its values (by label for buttons), and a way to pick one. */
const choiceOf = (label: string) => {
  const list = select(label);
  if (list) return { values: [...list.options].map((o) => o.value), pick: (v: string) => choose(list, v) };
  const group = document.querySelector<HTMLElement>(`[role="radiogroup"][aria-label="${label}"]`);
  const buttons = group ? [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')] : [];
  // Buttons carry layer names: map them to ids.
  const idOf = (name: string) => (name.startsWith("Nothing") ? "" : (comp().layerOrder.find((id) => comp().layers[id]!.name === name) ?? name));
  return { values: buttons.map((b) => idOf(b.textContent!.trim())), pick: (v: string) => click(buttons.find((b) => idOf(b.textContent!.trim()) === v)) };
};

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


// ---- Blend-mode arithmetic (W3C Compositing / Photoshop / After Effects), for checking drawn colours ----
type C3 = [number, number, number];
const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.max(0, c) ** (1 / 2.4) - 0.055);
const map3 = (a: C3, f: (x: number, i: number) => number): C3 => [f(a[0], 0), f(a[1], 1), f(a[2], 2)];
const lum = (c: C3) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const clipColor = (c: C3): C3 => {
  const l = lum(c), n = Math.min(...c), x = Math.max(...c);
  let o = c;
  if (n < 0) o = map3(o, (v) => l + ((v - l) * l) / (l - n));
  if (x > 1) o = map3(o, (v) => l + ((v - l) * (1 - l)) / (x - l));
  return o;
};
const setLum = (c: C3, l: number) => clipColor(map3(c, (v) => v + (l - lum(c))));
const sat = (c: C3) => Math.max(...c) - Math.min(...c);
const setSat = (c: C3, sv: number): C3 => {
  const mn = Math.min(...c), mx = Math.max(...c);
  return mx <= mn ? [0, 0, 0] : map3(c, (v) => ((v - mn) * sv) / (mx - mn));
};
const screen1 = (b: number, x: number) => b + x - b * x;
const hard1 = (b: number, x: number) => (x <= 0.5 ? b * 2 * x : screen1(b, 2 * x - 1));
const soft1 = (b: number, x: number) => (x <= 0.5 ? b - (1 - 2 * x) * b * (1 - b) : b + (2 * x - 1) * ((b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)) - b));
/** What a fully opaque layer of colour `S` over an opaque `B` looks like in each mode (display values 0–1). */
const expected = (mode: BlendMode, B: C3, S: C3): C3 => {
  const lin = (f: (b: number, x: number) => number) => map3(B, (b, i) => toSrgb(Math.min(1, f(toLin(b), toLin(S[i]!)))));
  const each = (f: (b: number, x: number) => number) => map3(B, (b, i) => f(b, S[i]!));
  switch (mode) {
    case "normal": return S;
    case "add": return lin((b, x) => b + x);
    case "screen": return lin(screen1);
    case "multiply": return lin((b, x) => b * x);
    case "overlay": return each((b, x) => hard1(x, b));
    case "soft-light": return each(soft1);
    case "hard-light": return each(hard1);
    case "color-dodge": return each((b, x) => (b <= 0 ? 0 : x >= 1 ? 1 : Math.min(1, b / (1 - x))));
    case "color-burn": return each((b, x) => (b >= 1 ? 1 : x <= 0 ? 0 : 1 - Math.min(1, (1 - b) / x)));
    case "darken": return each(Math.min);
    case "lighten": return each(Math.max);
    case "difference": return each((b, x) => Math.abs(b - x));
    case "exclusion": return each((b, x) => b + x - 2 * b * x);
    case "hue": return setLum(setSat(S, sat(B)), lum(B));
    case "saturation": return setLum(setSat(B, sat(S)), lum(B));
    case "color": return setLum(S, lum(B));
    case "luminosity": return setLum(B, lum(S));
    case "illuminate": return lin((b, x) => b + b * x);
  }
};
const MODES: BlendMode[] = ["normal", "add", "screen", "multiply", "overlay", "soft-light", "hard-light", "color-dodge", "color-burn", "darken", "lighten", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "illuminate"];

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
    const drawn = () => evaluateComp(st().project!, comp().id, st().time).layers.map((x) => x.id);
    // A layer that's drawn at this moment, so its disappearing shows.
    const other = choiceOf("Show only through").values.find((v) => v && drawn().includes(v));
    if (!other) return { ok: false, note: `no layer drawn here offered to show through (offered: ${choiceOf("Show only through").values.join(", ") || "none"})` };
    choiceOf("Show only through").pick(other);
    const set = await until(() => topLayer().trackMatte?.layerId === other);
    const hidden = !drawn().includes(other);
    await until(() => !!select("Where it shows"));
    choose(select("Where it shows"), "luma-inverted");
    const mode = await until(() => topLayer().trackMatte?.mode === "luma-inverted");
    choiceOf("Show only through").pick("");
    const cleared = await until(() => !topLayer().trackMatte);
    const back = drawn().includes(other);
    return { ok: set && hidden && mode && cleared && back, note: `“${l.name}” shown only through “${comp().layers[other]!.name}” (which then isn't drawn itself), where it's dark; cleared, and that layer is drawn again` };
  },
  "comp-blend-math": async () => {
    // Every blend mode drawn over a known colour, measured against the formulas, then undone.
    const c = comp();
    const at = st().time;
    const before = st().history!.transactions().length;
    const B: C3 = [0.25, 0.5, 0.75];
    const S: C3 = [0.8, 0.4, 0.2];
    const solid = (id: string, color: C3, w: number, h: number, x: number, y: number) => {
      const l = newLayer({ id, name: id, source: { kind: "solid", color: staticProp([...color, 1] as [number, number, number, number]), width: w, height: h }, start: at, duration: secondsToTime(2) });
      return { ...l, transform: { ...l.transform, anchor: staticProp<[number, number, number]>([w / 2, h / 2, 0]), position: staticProp<[number, number, number]>([x, y, 0], true) } };
    };
    const tileW = c.width / (MODES.length + 1);
    st().apply({ type: "layer.add", args: { compId: c.id, layer: solid("blend-check-back", B, c.width, c.height, c.width / 2, c.height / 2) } });
    MODES.forEach((mode, i) => {
      const id = `blend-check-${i}`;
      st().apply({ type: "layer.add", args: { compId: c.id, layer: { ...solid(id, S, tileW * 0.8, c.height * 0.4, tileW * (i + 1), c.height / 2), blendMode: mode } } });
    });
    await sleep(500);
    const loop = currentPreviewLoop();
    const shot = await loop?.sample();
    const off: string[] = [];
    let worst = 0;
    if (shot?.pixels) {
      const k = Math.min(shot.width / c.width, shot.height / c.height);
      const ox = (shot.width - c.width * k) / 2, oy = (shot.height - c.height * k) / 2;
      MODES.forEach((mode, i) => {
        const cx = Math.round(ox + tileW * (i + 1) * k), cy = Math.round(oy + (c.height / 2) * k);
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = cy - 3; y <= cy + 3; y++)
          for (let x = cx - 3; x <= cx + 3; x++) {
            const q = (y * shot.width + x) * 4;
            b += shot.pixels![q]!; g += shot.pixels![q + 1]!; r += shot.pixels![q + 2]!; n++;
          }
        const want = expected(mode, B, S).map((v) => Math.max(0, Math.min(1, v)) * 255);
        const err = Math.max(Math.abs(r / n - want[0]!), Math.abs(g / n - want[1]!), Math.abs(b / n - want[2]!));
        worst = Math.max(worst, err);
        if (err > 3) off.push(`${mode} ${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)} (want ${want.map(Math.round).join(",")})`);
      });
    }
    let undone = 0;
    while (st().history!.transactions().length > before && undone < 40) {
      st().undo();
      undone++;
    }
    const gone = !Object.keys(comp().layers).some((id) => id.startsWith("blend-check-"));
    return { ok: !!shot?.pixels && off.length === 0 && gone, note: shot?.pixels ? `${MODES.length} blend modes drawn over a known colour: worst difference from the formulas ${worst.toFixed(1)}/255${off.length ? `; off: ${off.join("; ")}` : ""}; undone` : "no preview picture" };
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
