/**
 * Journey steps for automatic house setup with a real house photo: the first photo in the data
 * folder's "Venue" folder (or BE_HOUSE_PHOTO). Find areas → correct an outline → remove a doubtful
 * one → split and join → accept → undo/redo. Skipped (and reported) when there's no photo.
 */
import { regionHoles } from "@be/core";
import { createProjectFromPhoto } from "./space/actions.ts";
import { proposedAreas, useHouseSetup } from "./space/houseSetup.ts";
import { activeVenue, useStudio } from "./studio/store.ts";

type Step = () => Promise<{ ok: boolean; note?: string; settle?: number }>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, timeout = 5000) => {
  const t0 = performance.now();
  while (!fn()) {
    if (performance.now() - t0 > timeout) return false;
    await sleep(100);
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
const found = () => proposedAreas(venue());
const byName = (name: string) => Object.values(venue().regions).find((r) => r.name === name);
const toClient = (cx: number, cy: number) => {
  const svg = document.querySelector<SVGSVGElement>("svg.trace")!;
  const r = svg.getBoundingClientRect();
  return { clientX: r.left + (cx / venue().canvas.width) * r.width, clientY: r.top + (cy / venue().canvas.height) * r.height };
};
const pointer = (target: Element, type: string, cx: number, cy: number) =>
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...toClient(cx, cy), pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1 }));

let skip = "";
const skipped = () => ({ ok: true, note: `SKIPPED: ${skip}` });

export const HOUSE_STEPS: Record<string, Step> = {
  "house-photo": async () => {
    const dir = `${(await window.be.app.paths()).renders.replace(/[\\/]Renders$/, "")}\\Venue`;
    const list = await window.be.files.findByName(dir, []).catch(() => ({}));
    void list;
    const photo = (window as unknown as { beHousePhoto?: string }).beHousePhoto;
    if (!photo) {
      skip = `no house photo (set BE_HOUSE_PHOTO or put one in ${dir})`;
      return skipped();
    }
    const ok = await createProjectFromPhoto({ path: photo, dataUrl: "" });
    await until(() => !!document.querySelector(".photo-underlay"), 8000);
    const v = venue();
    return { ok: ok && v.canvas.width === 1920 && v.canvas.height === 1080, note: `new show from ${photo.split("\\").pop()} (${st().project!.assets[v.photo!.assetId]!.meta.width}×${st().project!.assets[v.photo!.assetId]!.meta.height}) in a ${v.canvas.width}×${v.canvas.height} show`, settle: 900 };
  },
  "house-find-areas": async () => {
    if (skip) return skipped();
    const t0 = performance.now();
    click(byText(".house-setup button", "Find areas automatically"));
    await until(() => useHouseSetup.getState().phase !== "idle", 5000);
    if (useHouseSetup.getState().phase === "consent") return { ok: false, note: "the detection models aren't downloaded (the consent box is showing)" };
    const sawProgress = await until(() => !!document.querySelector(".house-setup .progress-bar"), 5000);
    await until(() => useHouseSetup.getState().phase !== "running", 180_000);
    const seconds = (performance.now() - t0) / 1000;
    const f = found();
    const kinds = new Set(f.map((r) => r.kind));
    const facade = f.find((r) => r.kind === "wall");
    const ok = useHouseSetup.getState().phase === "done" && ["garage", "door", "window", "roofline", "wall"].every((k) => kinds.has(k as never)) && (facade?.cutouts?.length ?? 0) >= 3 && sawProgress;
    return {
      ok,
      note: `found ${f.length} areas in ${seconds.toFixed(1)} s (${useHouseSetup.getState().summary?.device}): ${f.map((r) => `${r.name}${r.proposal!.uncertain ? " (check)" : ""}`).join(", ")}; facade has ${facade?.cutouts?.length ?? 0} openings cut out`,
      settle: 1200,
    };
  },
  "house-correct-outline": async () => {
    if (skip) return skipped();
    const win = found().find((r) => r.kind === "window")!;
    click(byText(".proposal-row button", win.name));
    await until(() => !!document.querySelector('rect.vertex-handle[aria-label="Corner 1"]'));
    const before = win.path.vertices[0]!.p;
    const handle = document.querySelector('rect.vertex-handle[aria-label="Corner 1"]')!;
    const svg = document.querySelector("svg.trace")!;
    pointer(handle, "pointerdown", before[0], before[1]);
    pointer(svg, "pointermove", before[0] - 4, before[1] - 3);
    pointer(svg, "pointermove", before[0] - 9, before[1] - 7);
    pointer(svg, "pointerup", before[0] - 9, before[1] - 7);
    await sleep(200);
    const after = byName(win.name)!.path.vertices[0]!.p;
    const facade = found().find((r) => r.kind === "wall")!;
    const hole = regionHoles(facade, venue()).find((h) => h.vertices.some((x) => x.p[0] === after[0] && x.p[1] === after[1]));
    const moved = Math.hypot(after[0] - before[0], after[1] - before[1]) > 5;
    return { ok: moved && !!hole, note: `dragged a corner of “${win.name}” from (${before.map(Math.round).join(", ")}) to (${after.map(Math.round).join(", ")}); the facade's cut-out followed`, settle: 800 };
  },
  "house-remove-doubtful": async () => {
    if (skip) return skipped();
    const doubtful = found().find((r) => /decoration|may not be part/.test(r.proposal!.uncertain ?? ""));
    if (!doubtful) return { ok: true, note: "nothing flagged as doubtful to remove" };
    click(document.querySelector(`.proposal-row button[aria-label="Remove ${doubtful.name}"]`));
    const ok = await until(() => !venue().regions[doubtful.id]);
    return { ok, note: `removed “${doubtful.name}” (${doubtful.proposal!.uncertain})` };
  },
  "house-split-join": async () => {
    if (skip) return skipped();
    const win = found().find((r) => r.kind === "window")!;
    st().selectRegions([win.id]);
    await sleep(150);
    click(byText(".panel button", "Split ⇆"));
    const split = await until(() => found().filter((r) => r.kind === "window").length === 2);
    const panes = found().filter((r) => r.kind === "window");
    const facadeCuts = found().find((r) => r.kind === "wall")!.cutouts?.length ?? 0;
    st().selectRegions(panes.map((r) => r.id));
    await sleep(150);
    click(byText(".panel button", "Join 2 areas"));
    const joined = await until(() => found().filter((r) => r.kind === "window").length === 1);
    return { ok: split && joined && facadeCuts >= 4, note: `split “${win.name}” into its two panes (both cut out of the facade: ${facadeCuts} openings), then joined them again`, settle: 700 };
  },
  "house-accept": async () => {
    if (skip) return skipped();
    const n = found().length;
    click(byText(".suggest-box button", "Accept all"));
    const ok = await until(() => found().length === 0);
    const v = venue();
    const groups = Object.values(v.groups).map((g) => `${g.name} (${g.regionIds.length})`);
    const roles = st().project!.bindings[v.id]?.roles ?? {};
    return { ok: ok && !!roles.windows?.length && !!roles["garage doors"]?.length && groups.some((g) => g.startsWith("Openings")), note: `accepted ${n} areas; groups ${groups.join(", ")}; roles windows ${roles.windows?.length}, doors ${roles.doors?.length}, garage doors ${roles["garage doors"]?.length}`, settle: 900 };
  },
  "house-undo-redo": async () => {
    if (skip) return skipped();
    st().undo();
    const back = await until(() => found().length > 0);
    st().redo();
    const again = await until(() => found().length === 0);
    return { ok: back && again, note: "undo brings the proposals back for review; redo accepts them again" };
  },
};
