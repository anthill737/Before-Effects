/**
 * Acceptance workflow B — 3D collapse and rebuild, through the real interface:
 *   trace a wall (window holes cut out) → give it thickness → collapse & rebuild → adjust piece
 *   size, gravity, mass, friction, bounce → pieces tumble onto the ledge (checked from the prepared
 *   motion) → move the light, shadows change → orbit the inspection view → retime collapse and
 *   rebuild on the timeline → keyframe the light → save. (Run 2, a fresh app process: reopen,
 *   seek, export, and compare exported frames with the preview.)
 */
import { type Object3D, resolveScene3DLayer, secondsToTime, timeToSeconds } from "@be/core";
import { currentPreviewLoop } from "./preview/PreviewPanel.tsx";
import { usePreview } from "./preview/settings.ts";
import { useAssistant } from "./studio/assistant/state.ts";
import { createProjectFromPhoto } from "./space/actions.ts";
import { useTrace } from "./space/traceStore.ts";
import { use3D } from "./studio/actions3d.ts";
import { getRenderer } from "./studio/engineHost.ts";
import { deserialize, serialize } from "./studio/persistence.ts";
import { useSims } from "./studio/simHost.ts";
import { activeVenue, currentComp, useStudio } from "./studio/store.ts";
import { drawHouse, HOUSE } from "./uitestPhoto.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, timeout = 5000) => {
  const t0 = performance.now();
  while (!fn()) {
    if (performance.now() - t0 > timeout) return false;
    await sleep(50);
  }
  return true;
};
const byText = (sel: string, text: string): HTMLElement | null => [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.includes(text)) ?? null;
const click = (el: Element | null) => {
  if (!el) throw new Error("element not found");
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
};
const st = () => useStudio.getState();
const venue = () => activeVenue({ project: st().project! })!;
const setInput = (el: HTMLInputElement | null, value: string | number) => {
  if (!el) throw new Error("input not found");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, String(value));
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const slider = (label: string) => document.querySelector<HTMLInputElement>(`input[type="range"][aria-label="${label}"]`);
const openSection = (title: string) => {
  const b = [...document.querySelectorAll<HTMLButtonElement>(".param-group > button.disclosure")].find((x) => x.textContent?.trim() === title);
  if (b && b.getAttribute("aria-expanded") !== "true") click(b);
};
const pointer = (type: string, cx: number, cy: number, target?: Element | null) => {
  const svg = document.querySelector<SVGSVGElement>("svg.trace")!;
  const r = svg.getBoundingClientRect();
  const v = venue();
  (target ?? svg).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: r.left + (cx / v.canvas.width) * r.width, clientY: r.top + (cy / v.canvas.height) * r.height, pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1 }));
};

const WALL = { x: 200, y: 250, w: 500, h: 650 };
const layer3d = () => {
  const c = currentComp(st())!;
  return Object.values(c.layers).find((l) => l.source.kind === "scene3d");
};
const scene = () => {
  const l = layer3d();
  return l && l.source.kind === "scene3d" ? st().project!.scenes3d?.[l.source.sceneId] : undefined;
};
const obj = (suffix: string): Object3D | undefined => {
  const s = scene();
  return s ? Object.values(s.objects).find((o) => o.id.endsWith(suffix)) : undefined;
};
const resolved = () => {
  const l = layer3d()!;
  return resolveScene3DLayer(st().project!, st().compId!, l.id)!;
};
/** Wait until the physics motion for the 3D layer is prepared. */
const physicsReady = async (timeout = 60_000) => {
  const t0 = performance.now();
  const engine = (await getRenderer()).physics!;
  // The engine's own progress for the current settings (the status line can lag a tick behind an edit).
  const ok = await until(() => {
    const p = layer3d() && resolved().physics;
    return !!p && engine.progress(p).done >= p.frames && (useSims.getState().status[layer3d()!.id]?.done ?? 0) >= p.frames;
  }, timeout);
  return { ok, ms: performance.now() - t0 };
};
/** The preview, sampled when stable, as a coarse grid of luminance blocks (for comparing pictures). */
const sampleBlocks = async (nx = 48, ny = 30) => {
  let prev = "";
  let out: { blocks: Float32Array; mean: number } = { blocks: new Float32Array(0), mean: 0 };
  for (let i = 0; i < 25; i++) {
    await sleep(160);
    const s = await currentPreviewLoop()?.sample();
    if (!s?.pixels) continue;
    out = { blocks: blocksOf(s.pixels, s.width, s.height, nx, ny, true), mean: s.mean };
    const sig = `${s.mean.toFixed(3)}/${s.spread.toFixed(3)}`;
    if (sig === prev) break;
    prev = sig;
  }
  return out;
};
const blocksOf = (px: Uint8Array, w: number, h: number, nx: number, ny: number, bgra: boolean) => {
  const b = new Float32Array(nx * ny);
  const n = new Float32Array(nx * ny);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = px[i + (bgra ? 2 : 0)]!, g = px[i + 1]!, bl = px[i + (bgra ? 0 : 2)]!;
      const k = Math.min(ny - 1, Math.floor((y / h) * ny)) * nx + Math.min(nx - 1, Math.floor((x / w) * nx));
      b[k] = b[k]! + 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      n[k] = n[k]! + 1;
    }
  for (let k = 0; k < b.length; k++) b[k] = b[k]! / Math.max(1, n[k]!);
  return b;
};
const blockDiff = (a: Float32Array, b: Float32Array, region?: { x0: number; x1: number; y0: number; y1: number; nx: number; ny: number }) => {
  let d = 0, n = 0;
  for (let k = 0; k < a.length; k++) {
    if (region) {
      const x = (k % region.nx) / region.nx, y = Math.floor(k / region.nx) / region.ny;
      if (x < region.x0 || x > region.x1 || y < region.y0 || y > region.y1) continue;
    }
    d += Math.abs(a[k]! - b[k]!);
    n++;
  }
  return d / Math.max(1, n);
};
const seek = (s: number) => {
  st().setPlaying(false);
  const l = layer3d()!;
  st().setTime(l.startTime + secondsToTime(s));
};

export const WORKFLOW_B_STEPS: Record<string, () => Promise<{ ok: boolean; note?: string; settle?: number }>> = {
  "wb-photo-and-wall": async () => {
    // Start from a clean screen (earlier journeys may leave the assistant or the exports list open).
    useAssistant.setState({ open: false });
    useStudio.setState({ rendersOpen: false });
    const blob = await drawHouse();
    const paths = await window.be.app.paths();
    const photo = `${paths.renders}\\ui-test\\workflow-b-house.png`;
    await window.be.files.writeBinary(photo, new Uint8Array(await blob.arrayBuffer()));
    await createProjectFromPhoto({ path: photo, dataUrl: "" });
    await until(() => !!document.querySelector("svg.trace"), 5000);
    usePreview.getState().set({ resolution: "full", view: "show", zoom: "fit" });
    useTrace.getState().set({ tool: "rect" });
    await sleep(80);
    pointer("pointerdown", WALL.x, WALL.y);
    pointer("pointermove", WALL.x + WALL.w, WALL.y + WALL.h);
    pointer("pointerup", WALL.x + WALL.w, WALL.y + WALL.h);
    await until(() => !!document.querySelector(".kind-chooser"));
    click(byText(".kind-chooser button", "Wall"));
    await sleep(120);
    const wall = Object.values(venue().regions).find((r) => r.kind === "wall")!;
    // Cut the two windows on this part of the wall out of it.
    for (const w of HOUSE.windows.filter((x) => x.x === 330)) {
      st().selectRegions([wall.id]);
      useTrace.getState().set({ tool: "hole" });
      await sleep(60);
      for (const [x, y] of [[w.x, w.y], [w.x + w.w, w.y], [w.x + w.w, w.y + w.h], [w.x, w.y + w.h]] as const) pointer("pointerup", x, y);
      document.querySelector("svg.trace")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      await sleep(100);
    }
    useTrace.getState().set({ tool: "select" });
    st().selectRegions([wall.id]);
    await sleep(200);
    return { ok: (venue().regions[wall.id]!.holes?.length ?? 0) === 2, note: `wall traced (${WALL.w}×${WALL.h} px) with its 2 windows cut out`, settle: 500 };
  },
  "wb-give-thickness": async () => {
    click(byText(".make-3d button", "Give it thickness (3D)"));
    await until(() => !!document.querySelector(".scene3d-panel"));
    const area = obj("-area");
    setInput(slider("Thickness"), 40);
    await sleep(200);
    const g = obj("-area")?.geometry;
    return { ok: !!area && g?.kind === "area" && Math.abs(g.depth - 0.4) < 1e-6 && !obj("-area")?.fracture, note: `3D layer “${layer3d()?.name}”: the wall as a solid, thickness set to 40 cm; objects: ${scene()!.objectOrder.map((id) => scene()!.objects[id]!.name).join(", ")}`, settle: 800 };
  },
  "wb-collapse-rebuild": async () => {
    openSection("Breaking apart");
    await sleep(100);
    click(document.querySelector('button[role="switch"][aria-label="Collapse and rebuild"]'));
    await sleep(200);
    const fr = obj("-area")?.fracture;
    const ready = await physicsReady();
    const p = resolved().physics;
    return { ok: !!fr && obj("-area")?.physics?.body === "dynamic" && ready.ok, note: `collapse at ${fr?.collapseAt} s, rebuild at ${fr?.rebuildAt} s over ${fr?.rebuildSeconds} s; ${p?.bodies.filter((b) => b.kind === "fragment").length} pieces; physics prepared in ${(ready.ms / 1000).toFixed(1)} s (${p?.frames} frames × ${p?.substeps} steps)`, settle: 500 };
  },
  "wb-adjust-physics": async () => {
    const before = resolved().physics!.key;
    const fragsBefore = resolved().physics!.bodies.filter((b) => b.kind === "fragment").length;
    setInput(slider("Piece size"), 90);
    await sleep(80);
    openSection("Gravity");
    await sleep(80);
    setInput(slider("Gravity strength"), 12);
    await sleep(80);
    openSection("Physics");
    await sleep(80);
    setInput(slider("Mass"), 3000);
    setInput(slider("Friction"), 0.5);
    setInput(slider("Bounce"), 0.3);
    await sleep(200);
    const o = obj("-area")!;
    const after = resolved().physics!;
    const ready = await physicsReady();
    const frags = after.bodies.filter((b) => b.kind === "fragment").length;
    const ok = o.fracture?.pieceSize === 90 && Math.abs(Math.hypot(...scene()!.gravity) - 12) < 0.01 && o.physics?.mass === 3000 && o.physics.friction === 0.5 && o.physics.bounce === 0.3 && after.key !== before && frags < fragsBefore && ready.ok;
    return { ok, note: `piece size 90 cm (${fragsBefore} → ${frags} pieces), gravity 12 m/s², mass 3000 kg, friction 0.5, bounce 0.3; motion prepared again in ${(ready.ms / 1000).toFixed(1)} s`, settle: 500 };
  },
  "wb-tumble-onto-ledge": async () => {
    const r = await getRenderer();
    const p = resolved().physics!;
    const m = r.physics!.motion(p.key)!;
    const ledge = obj("-ledge")!;
    const top = ledge.position.value[1] + (ledge.geometry?.kind === "box" ? ledge.geometry.size[1] / 2 : 0);
    const fr = obj("-area")!.fracture!;
    const frags = p.bodies.filter((b) => b.kind === "fragment");
    const size = ledge.geometry?.kind === "box" ? ledge.geometry.size : [0, 0, 0];
    const [lx, , lz] = ledge.position.value;
    const at = (f: number) => frags.map((b) => ({ x: m.data[(f * p.movers + b.poseIndex) * 7]!, y: m.data[(f * p.movers + b.poseIndex) * 7 + 1]!, z: m.data[(f * p.movers + b.poseIndex) * 7 + 2]! }));
    const settled = Math.round(fr.rebuildAt! * p.fps) - 1;
    const end = at(settled);
    // Over the ledge's footprint: pieces rest on top or stack up; none ends up inside the ledge.
    const over = end.filter((q) => Math.abs(q.x - lx) < size[0]! / 2 && Math.abs(q.z - lz) < size[2]! / 2);
    const bottom = top - size[1]!;
    const through = over.filter((q) => q.y < top - 0.05 && q.y > bottom + 0.05).length;
    const ground = end.filter((q) => q.y < top - 0.05).length;
    const lowest = Math.min(...end.map((q) => q.y));
    // A frame mid-fall, for the record.
    seek(fr.collapseAt + 0.8);
    await sampleBlocks();
    return {
      ok: m.ready >= p.frames && over.length / frags.length > 0.3 && through === 0 && lowest > -0.05,
      note: `${fr.rebuildAt! - fr.collapseAt} s after the collapse: ${over.length} of ${frags.length} pieces lie on the ledge (top ${top.toFixed(2)} m), stacked up to ${Math.max(...over.map((q) => q.y)).toFixed(2)} m, ${through} inside it; ${ground} rolled off onto the ground (lowest centre ${lowest.toFixed(2)} m, none below it)`,
      settle: 600,
    };
  },
  "wb-move-light-shadows": async () => {
    const fr = obj("-area")!.fracture!;
    seek(fr.collapseAt + 1.5);
    const a = await sampleBlocks();
    use3D.setState({ objectId: obj("-key")!.id });
    await until(() => !!slider("Light position X"));
    const x0 = obj("-key")!.position.value[0];
    setInput(slider("Light position X"), 8);
    setInput(slider("Light position Y"), 6);
    await sleep(300);
    const b = await sampleBlocks();
    // The lower part of the picture (ledge, ground, inside of the wall) is where the shadows fall.
    const lower = blockDiff(a.blocks, b.blocks, { x0: 0, x1: 0.5, y0: 0.55, y1: 1, nx: 48, ny: 30 });
    return { ok: obj("-key")!.position.value[0] === 8 && lower > 1.5, note: `key light moved from x=${x0.toFixed(1)} m to x=8 m, y=6 m: the lit picture of the ledge and fallen pieces changed by ${lower.toFixed(1)}/255 on average (shadows move with the light)`, settle: 700 };
  },
  "wb-orbit-inspection": async () => {
    usePreview.getState().set({ view: "3d" });
    await until(() => !!document.querySelector(".orbit-layer"));
    usePreview.getState().set({ orbit: { yaw: -18, pitch: 8, distance: 1.55, panX: 0, panY: 0 } });
    const a = await sampleBlocks();
    // Drag on the 3D view to orbit.
    const el = document.querySelector<HTMLElement>(".orbit-layer")!;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: cx, clientY: cy, pointerId: 2, button: 0, buttons: 1 }));
    for (let i = 1; i <= 10; i++) el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: cx - i * 18, clientY: cy + i * 4, pointerId: 2, button: 0, buttons: 1 }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: cx - 180, clientY: cy + 40, pointerId: 2, button: 0, buttons: 0 }));
    await sleep(200);
    const o = usePreview.getState().orbit;
    const b = await sampleBlocks();
    return { ok: o.yaw !== -18 && blockDiff(a.blocks, b.blocks) > 3, note: `orbited the 3D inspection view to yaw ${o.yaw.toFixed(0)}°, pitch ${o.pitch.toFixed(0)}° (picture changed by ${blockDiff(a.blocks, b.blocks).toFixed(1)}/255)`, settle: 900 };
  },
  "wb-retime-on-timeline": async () => {
    usePreview.getState().set({ view: "show" });
    await sleep(200);
    const l = layer3d()!;
    const c = currentComp(st())!;
    const tracks = document.querySelector<HTMLElement>(".tracks")!.getBoundingClientRect();
    const xAt = (s: number) => tracks.left + ((l.startTime + secondsToTime(s)) / c.duration) * tracks.width;
    const dragMark = async (sel: string, to: number) => {
      const m = document.querySelector<HTMLElement>(sel)!;
      const r = m.getBoundingClientRect();
      const y = r.top + r.height / 2;
      m.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: y, pointerId: 3, button: 0, buttons: 1 }));
      for (let i = 1; i <= 6; i++) m.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: r.left + r.width / 2 + ((xAt(to) - r.left - r.width / 2) * i) / 6, clientY: y, pointerId: 3, buttons: 1 }));
      m.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: xAt(to), clientY: y, pointerId: 3 }));
      await sleep(150);
    };
    const before = { ...obj("-area")!.fracture! };
    await dragMark(".mark.collapse", 2);
    await dragMark(".mark.rebuild", 5.5);
    const fr = obj("-area")!.fracture!;
    const ready = await physicsReady();
    return {
      ok: Math.abs(fr.collapseAt - 2) < 0.05 && Math.abs(fr.rebuildAt! - 5.5) < 0.05 && ready.ok,
      note: `dragged ▼ collapse ${before.collapseAt} s → ${fr.collapseAt.toFixed(2)} s and ▲ rebuild ${before.rebuildAt} s → ${fr.rebuildAt!.toFixed(2)} s on the timeline; motion prepared again in ${(ready.ms / 1000).toFixed(1)} s`,
      settle: 600,
    };
  },
  "wb-keyframe-light": async () => {
    use3D.setState({ objectId: obj("-key")!.id });
    seek(1);
    await until(() => !!document.querySelector('button[aria-label="Add a position keyframe at the playhead"]'));
    click(document.querySelector('button[aria-label="Add a position keyframe at the playhead"]'));
    await sleep(100);
    seek(6);
    await sleep(100);
    setInput(slider("Light position X"), -6);
    await sleep(200);
    const k = obj("-key")!.position.keyframes ?? [];
    const diamonds = document.querySelectorAll(".key-diamond").length;
    // Easing from the timeline: click the first diamond, choose "Steady (linear)".
    const d = document.querySelector<HTMLElement>(".key-diamond")!;
    const r = d.getBoundingClientRect();
    d.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 4, pointerId: 4, buttons: 1 }));
    d.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: r.left + 4, clientY: r.top + 4, pointerId: 4 }));
    await until(() => !!document.querySelector(".key-menu"));
    click(byText(".key-menu button", "Steady (linear)"));
    await sleep(150);
    const k2 = obj("-key")!.position.keyframes ?? [];
    return { ok: k.length === 2 && diamonds >= 2 && k2[0]?.out === "linear", note: `light position keyframed at 1 s (x=8 m) and 6 s (x=−6 m), shown as ${diamonds} ◆ on the timeline; first key set to steady (linear) from the timeline`, settle: 600 };
  },
  "wb-save": async () => {
    const paths = await window.be.app.paths();
    const path = `${paths.projects}\\Workflow B.beproj`;
    const r = await window.be.files.saveProject(serialize(st().project!), path);
    if (r) st().markSaved(r.path, r.savedAt);
    return { ok: !!r, note: `saved to ${path}` };
  },
  // ---- Run 2: a fresh app process ----
  "wb-reopen": async () => {
    const paths = await window.be.app.paths();
    const path = `${paths.projects}\\Workflow B.beproj`;
    const opened = await window.be.files.openProject(path);
    if (!opened) return { ok: false, note: "the saved show wasn't found (run the first part first)" };
    st().openProject(deserialize(opened.json), path);
    await until(() => !!document.querySelector(".preview-panel"));
    const l = layer3d();
    if (l) st().selectLayer(l.id);
    usePreview.getState().set({ resolution: "full", view: "show", zoom: "fit" });
    const ready = await physicsReady();
    const o = obj("-area");
    const ok = !!o?.fracture && o.fracture.pieceSize === 90 && Math.abs(o.fracture.collapseAt - 2) < 0.05 && Math.abs(Math.hypot(...scene()!.gravity) - 12) < 0.01 && (obj("-key")?.position.keyframes?.length ?? 0) === 2 && ready.ok;
    return { ok, note: `reopened in a new app process: ${scene()!.objectOrder.length} 3D objects, piece size ${o?.fracture?.pieceSize} cm, gravity ${Math.hypot(...scene()!.gravity).toFixed(1)} m/s², collapse ${o?.fracture?.collapseAt.toFixed(2)} s, light keyframes kept; prepared motion ready in ${(ready.ms / 1000).toFixed(1)} s`, settle: 800 };
  },
  "wb-seek-export-consistent": async () => {
    const l = layer3d()!;
    const c = currentComp(st())!;
    const fr = obj("-area")!.fracture!;
    const fps = c.frameRate.num / c.frameRate.den;
    const times = [fr.collapseAt + 0.6, fr.collapseAt + 2, fr.rebuildAt! + 0.5];
    // Seek around: the same moment shows the same picture.
    seek(times[1]!);
    const p1 = await sampleBlocks();
    seek(times[0]!);
    await sampleBlocks();
    seek(times[2]!);
    await sampleBlocks();
    seek(times[1]!);
    const p2 = await sampleBlocks();
    const seekDiff = blockDiff(p1.blocks, p2.blocks);
    const previews: Float32Array[] = [];
    for (const t of times) {
      seek(t);
      previews.push((await sampleBlocks()).blocks);
    }
    const paths = await window.be.app.paths();
    const output = `${paths.renders}\\Workflow B - collapse and rebuild.mp4`;
    const frames = Math.round(timeToSeconds(l.outPoint - l.startTime) * fps);
    const startFrame = Math.round(timeToSeconds(l.startTime) * fps);
    const t0 = performance.now();
    const id = await window.be.render.enqueue({
      name: "Workflow B — collapse and rebuild",
      outcome: "share",
      preset: "h264",
      compId: c.id,
      target: { kind: "master", keepAlpha: false },
      output,
      width: c.width,
      height: c.height,
      frameRate: c.frameRate,
      startFrame,
      frames,
      alpha: false,
      withAudio: false,
      estimatedBytes: 20_000_000,
      snapshot: JSON.stringify(st().project),
    });
    let job: Awaited<ReturnType<typeof window.be.render.list>>[number] | undefined;
    while (performance.now() - t0 < 600_000) {
      job = (await window.be.render.list()).find((j) => j.id === id);
      if (job?.state === "done" || job?.state === "failed") break;
      await sleep(250);
    }
    const secs = (performance.now() - t0) / 1000;
    if (job?.state !== "done") return { ok: false, note: `export ${job?.state}: ${job?.error}` };
    // Exported frames at the same moments match the preview; different moments don't.
    const ex: Float32Array[] = [];
    for (const t of times) {
      const f = Math.round(t * fps);
      const d = await window.be.media.decodeFrame(job.result!, f, fps, 480, c.width, c.height);
      ex.push(d ? blocksOf(d.data, d.width, d.height, 48, 30, false) : new Float32Array(48 * 30));
    }
    const same = times.map((_, i) => blockDiff(previews[i]!, ex[i]!));
    const other = blockDiff(previews[0]!, ex[1]!);
    return {
      ok: seekDiff < 0.5 && same.every((d) => d < 4) && other > Math.max(...same) * 2 && !!job.verify?.checks.every((x) => x.ok),
      note: `seek back and forth: ${seekDiff.toFixed(2)}/255 apart; exported ${frames} frames in ${secs.toFixed(1)} s (${job.verify?.checks.map((x) => `${x.ok ? "✓" : "✗"}${x.name}`).join(" ")}); export vs preview at ${times.map((t) => t.toFixed(1)).join(", ")} s: ${same.map((d) => d.toFixed(2)).join(", ")}/255 (a different moment: ${other.toFixed(1)}/255) → ${output}`,
    };
  },
};

