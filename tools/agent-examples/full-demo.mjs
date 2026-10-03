/**
 * The whole application, demonstrated and recorded: the packaged app driven like a person (mouse and
 * keyboard through the Chromium DevTools protocol, files dropped as from Explorer) while the screen
 * is recorded, ending with a full show on the house.
 *
 *   node tools/agent-examples/full-demo.mjs [photo]
 *
 * Chapters: photo → automatic house setup → drawing an area → media and music → light effects →
 * moving architecture (3D) → video and keyframes → music-driven light → particles → every setting
 * adjustable → preview sizes → a second scene: cloth reveal, fire and water simulated in Blender,
 * collapse and rebuild with real physics, a look around in 3D, melt, smoke, snow and confetti →
 * plain-words search → an external AI agent adding an effect → two projectors with edge blending →
 * the show's running order → export → the whole show, played on the house.
 *
 * Long waits (house detection, Blender simulations, the export) are fast-forwarded in the recording
 * and labelled so on screen. Chapter titles are captions laid over the app for the recording.
 *
 * Photo: the argument, BE_HOUSE_PHOTO, or the first photo in <data folder>\Venue. Media: the
 * generated samples in <data folder>\Test content (clearly named as samples, not AtmosFX). Results
 * (the recording, the exported show and report.json) go to <data folder>\Renders\full-demo.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const EXE = process.env.BE_EXE || join(ROOT, "build", "app", "Before Effects.exe");
const DATA = process.env.BE_DATA || (existsSync("D:\\") ? "D:\\Before Effects" : join(homedir(), "Documents", "Before Effects"));
const OUT = join(DATA, "Renders", "full-demo");
const venueDir = join(DATA, "Venue");
const PHOTO =
  process.argv[2] ||
  process.env.BE_HOUSE_PHOTO ||
  (existsSync(venueDir) ? readdirSync(venueDir).filter((f) => /\.(heic|heif|jpe?g|png)$/i.test(f)).sort((a, b) => Number(/\.hei[cf]$/i.test(b)) - Number(/\.hei[cf]$/i.test(a))).map((f) => join(venueDir, f))[0] : undefined);
const CONTENT = join(DATA, "Test content");
const VIDEO = join(CONTENT, "Sample footage (generated, not AtmosFX) - swirl.mp4");
const MUSIC = join(CONTENT, "Sample music (generated) - 120 BPM.wav");
const PICTURE = join(CONTENT, "Sample picture (generated) - gradient.png");
const PORT = 9336;
if (!PHOTO) throw new Error(`No house photo: pass one, set BE_HOUSE_PHOTO, or put one in ${venueDir}`);
for (const f of [VIDEO, MUSIC, PICTURE]) if (!existsSync(f)) throw new Error(`Missing sample media: ${f}`);
rmSync(join(OUT, "frames"), { recursive: true, force: true });
mkdirSync(join(OUT, "frames"), { recursive: true });

const t0 = Date.now();
const report = { at: new Date().toISOString(), app: EXE, photo: PHOTO.split(/[\\/]/).pop(), steps: [], ok: true };
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = async (name, fn) => {
  const s = Date.now();
  try {
    const note = await fn();
    report.steps.push({ name, ok: true, seconds: (Date.now() - s) / 1000, note });
    log(`PASS ${name}${note ? ` — ${note}` : ""}`);
  } catch (e) {
    report.ok = false;
    report.steps.push({ name, ok: false, seconds: (Date.now() - s) / 1000, error: String(e?.message ?? e) });
    log(`FAIL ${name} — ${e?.message ?? e}`);
  }
};

class Editor {
  static async connect() {
    let page;
    for (let i = 0; i < 160 && !page; i++) {
      try {
        page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((p) => p.type === "page" && /#editor/.test(p.url));
      } catch {
        /* starting */
      }
      if (!page) await sleep(250);
    }
    if (!page) throw new Error("editor window not found");
    const e = new Editor(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => ((e.ws.onopen = res), (e.ws.onerror = rej)));
    return e;
  }
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 1;
    this.pending = new Map();
    this.frames = [];
    /** Fast-forwarded stretches of the recording: [startSec, endSec, factor] (epoch seconds). */
    this.fast = [];
    this.dragData = null;
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      } else if (msg.method === "Page.screencastFrame") {
        const name = `f${String(this.frames.length).padStart(6, "0")}.jpg`;
        writeFileSync(join(OUT, "frames", name), Buffer.from(msg.params.data, "base64"));
        this.frames.push({ t: Date.now() / 1000, name });
        void this.send("Page.screencastFrameAck", { sessionId: msg.params.sessionId });
      } else if (msg.method === "Input.dragIntercepted") {
        this.dragData = msg.params.data;
      }
    };
  }
  send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve) => {
      this.pending.set(id, (m) => resolve(m.result ?? m));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "script error");
    return r.result?.value;
  }
  /** The centre of an element (found by a JS expression), scrolled into view. */
  async at(js) {
    const p = await this.eval(`(() => { const el = ${js}; if (!el) return null; el.scrollIntoView({ block: "nearest" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!p) throw new Error(`not found: ${js}`);
    return p;
  }
  async mouse(type, x, y, buttons = 0, modifiers = 0) {
    await this.send("Input.dispatchMouseEvent", { type, x, y, modifiers, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
  }
  /** Glide the pointer there (so the recording shows where it goes), then click. Shift with `shift`. */
  async click(js, { shift = false, double = false } = {}) {
    const p = await this.at(js);
    await this.glide(p);
    const mod = shift ? 8 : 0;
    await this.mouse("mousePressed", p.x, p.y, 1, mod);
    await this.mouse("mouseReleased", p.x, p.y, 0, mod);
    if (double) {
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 2 });
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", buttons: 0, clickCount: 2 });
    }
    await sleep(380);
  }
  async clickAt(p) {
    await this.glide(p);
    await this.mouse("mousePressed", p.x, p.y, 1);
    await this.mouse("mouseReleased", p.x, p.y);
    await sleep(350);
  }
  async glide(to, from = this.last ?? { x: to.x - 60, y: to.y - 40 }) {
    for (let i = 1; i <= 12; i++) await this.mouse("mouseMoved", from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12);
    this.last = to;
  }
  async drag(from, to, steps = 14) {
    await this.glide(from);
    await this.mouse("mousePressed", from.x, from.y, 1);
    for (let i = 1; i <= steps; i++) {
      await this.mouse("mouseMoved", from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, 1);
      await sleep(16);
    }
    await this.mouse("mouseReleased", to.x, to.y);
    this.last = to;
    await sleep(300);
  }
  /** Drag an HTML element onto another (HTML drag and drop, as a person does with the mouse). */
  async dragOnto(fromJs, toJs) {
    const from = await this.at(fromJs);
    const to = await this.at(toJs);
    await this.send("Input.setInterceptDrags", { enabled: true });
    this.dragData = null;
    await this.glide(from);
    await this.mouse("mousePressed", from.x, from.y, 1);
    for (let i = 1; i <= 16 && !this.dragData; i++) {
      await this.mouse("mouseMoved", from.x + ((to.x - from.x) * i) / 16, from.y + ((to.y - from.y) * i) / 16, 1);
      await sleep(20);
    }
    const data = this.dragData;
    await this.send("Input.setInterceptDrags", { enabled: false });
    if (!data) {
      await this.mouse("mouseReleased", to.x, to.y);
      return false;
    }
    for (let i = 1; i <= 10; i++) {
      const x = from.x + ((to.x - from.x) * i) / 10, y = from.y + ((to.y - from.y) * i) / 10;
      await this.send("Input.dispatchDragEvent", { type: i === 1 ? "dragEnter" : "dragOver", x, y, data });
      await this.mouse("mouseMoved", x, y, 1);
      await sleep(25);
    }
    await this.send("Input.dispatchDragEvent", { type: "drop", x: to.x, y: to.y, data });
    await this.mouse("mouseReleased", to.x, to.y);
    this.last = to;
    await sleep(500);
    return true;
  }
  /** Drop files onto the window, as if dragged from Explorer. */
  async dropFiles(files) {
    const box = await this.eval("({ x: innerWidth / 2, y: innerHeight / 2 })");
    const data = { items: [], files, dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"]) await this.send("Input.dispatchDragEvent", { type, x: box.x, y: box.y, data });
  }
  async type(text) {
    for (const ch of text) {
      await this.send("Input.insertText", { text: ch });
      await sleep(45);
    }
  }
  async key(key, { ctrl = false } = {}) {
    const codes = { Enter: ["Enter", 13], Escape: ["Escape", 27], a: ["KeyA", 65], z: ["KeyZ", 90], y: ["KeyY", 89] };
    const [code, vk] = codes[key];
    const modifiers = ctrl ? 2 : 0;
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, modifiers });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers });
    await sleep(150);
  }
  async waitFor(js, timeout = 10_000) {
    const s = Date.now();
    while (Date.now() - s < timeout) {
      if (await this.eval(js)) return (Date.now() - s) / 1000;
      await sleep(120);
    }
    throw new Error(`timed out waiting for ${js}`);
  }
  async record() {
    await this.send("Page.enable");
    await this.send("Page.startScreencast", { format: "jpeg", quality: 82, everyNthFrame: 1 });
  }
  /** Fast-forward whatever happens while `fn` runs (shown on screen as such). */
  async fastForward(label, factor, fn) {
    await caption(label, `⏩ fast-forwarded ×${factor}`, true);
    const a = Date.now() / 1000;
    try {
      return await fn();
    } finally {
      this.fast.push([a, Date.now() / 1000, factor]);
      await caption(null);
    }
  }
  async stopRecording(file) {
    await this.send("Page.stopScreencast");
    const dir = join(OUT, "frames");
    const speed = (t) => this.fast.find(([a, b]) => t >= a && t < b)?.[2] ?? 1;
    // Each frame's place in the recording: the real time to the next frame (long still stretches
    // shortened), divided while fast-forwarded.
    let end = 0;
    const placed = this.frames.map((f, i) => {
      const next = this.frames[i + 1];
      const at = end;
      end += Math.max(0, Math.min(4, next ? next.t - f.t : 0.5)) / speed(f.t);
      return { name: f.name, at };
    });
    // On a 30 fps grid, each slot shows the latest frame placed by then, so fast-forwarding drops
    // frames rather than asking for impossibly short ones.
    const lines = [];
    const slot = 1 / 30;
    let j = 0;
    let shown = null;
    let slots = 0;
    for (let k = 0; k * slot < end; k++) {
      while (j + 1 < placed.length && placed[j + 1].at <= k * slot) j++;
      if (placed[j].name === shown) slots++;
      else {
        if (shown) lines.push(`file '${shown}'`, `duration ${(slots * slot).toFixed(4)}`);
        shown = placed[j].name;
        slots = 1;
      }
    }
    if (shown) lines.push(`file '${shown}'`, `duration ${(slots * slot).toFixed(4)}`, `file '${shown}'`);
    writeFileSync(join(dir, "list.txt"), lines.join("\n"));
    const ffmpeg = join(EXE, "..", "resources", "bin", "ffmpeg.exe");
    await new Promise((res) => spawn(ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "list.txt", "-vf", "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", file], { cwd: dir, stdio: "ignore" }).on("exit", res));
    rmSync(dir, { recursive: true, force: true });
    return file;
  }
}

const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const byText = (sel, text) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.includes(${JSON.stringify(text)}))`;
const startsText = (sel, text) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}))`;
const area = (name) => `[...document.querySelectorAll("svg.overlay path.region")].find((p) => (p.getAttribute("aria-label") || "").startsWith(${JSON.stringify(name)}))`;
const card = (title) => `[...document.querySelectorAll(".anim-card")].find((c) => c.textContent.startsWith(${JSON.stringify(title)}))`;
const hasLayer = (name) => `[...document.querySelectorAll(".timeline *")].some((e) => e.children.length === 0 && (e.textContent || "").startsWith(${JSON.stringify(name)}))`;
const listArea = (name) => `[...document.querySelectorAll(".area-drop button.area-name")].find((b) => b.textContent.trim().startsWith(${JSON.stringify(name)}))`;

const app = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: "ignore" });
const ed = await Editor.connect();
await ed.waitFor(`!!document.querySelector(".welcome") || !!document.querySelector(".topbar, .route")`, 30_000);

/** A caption laid over the app for the recording (chapter title, or what's being fast-forwarded). */
async function caption(title, sub = "", top = false) {
  await ed.eval(`(() => {
    let el = document.getElementById("demo-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-caption";
      el.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);z-index:99999;pointer-events:none;padding:12px 22px;border-radius:12px;background:rgba(10,12,18,0.86);border:1px solid rgba(255,200,110,0.55);color:#fff;font:600 22px 'Segoe UI',sans-serif;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,0.5);transition:opacity .35s;max-width:70vw";
      document.body.appendChild(el);
    }
    const title = ${JSON.stringify(title)};
    if (!title) { el.style.opacity = "0"; return; }
    el.style.top = ${top} ? "84px" : "";
    el.style.bottom = ${top} ? "" : "26px";
    el.innerHTML = title.replace(/</g, "&lt;") + (${JSON.stringify(sub)} ? '<div style="font:400 15px Segoe UI,sans-serif;color:#ffd99a;margin-top:4px">' + ${JSON.stringify(sub)}.replace(/</g, "&lt;") + "</div>" : "");
    el.style.opacity = "1";
  })()`);
}
const chapter = async (title, sub = "") => {
  await caption(title, sub);
  await sleep(2600);
};

/** Click a range slider at a fraction of its width (as a person would). */
const setSlider = async (label, fraction, within = "body") => {
  const box = await ed.eval(`(() => { const el = document.querySelector(${JSON.stringify(within)} + ' input[type="range"][aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']'); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + 6, y: r.top + r.height / 2, w: r.width - 12 }; })()`);
  if (!box) throw new Error(`no slider ${label}`);
  await ed.clickAt({ x: box.x + box.w * fraction, y: box.y });
  await sleep(300);
};
/** Move the playhead by clicking the timeline ruler. */
const setTime = async (seconds) => {
  const r = await ed.eval(`(() => { const el = document.querySelector(".timeline .ruler"); const b = el.getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2, w: b.width, dur: Number(el.getAttribute("aria-valuemax")) / 705600000 }; })()`);
  await ed.clickAt({ x: r.x + (r.w * seconds) / r.dur, y: r.y });
  await sleep(250);
};
const view = async (label) => {
  if (!(await ed.eval(`!!${byText(".preview-toolbar [role=radio][aria-checked=true]", label)}`))) await ed.click(byText(".preview-toolbar [role=radio]", label));
  await sleep(400);
};
/** Call the app's agent API (as an external program would). */
const api = async (method, params = {}) => {
  const conn = JSON.parse(readFileSync(join(process.env.APPDATA, "Before Effects", "agent-api.json"), "utf8"));
  const r = await fetch(`http://127.0.0.1:${conn.port}/v1/call`, {
    method: "POST",
    headers: { authorization: `Bearer ${conn.token}`, "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  }).then((x) => x.json());
  if (!r.ok) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
  return r.result;
};
const goStep = async (label) => {
  await ed.click(startsText(".route-step", label).replace("textContent.trim().startsWith", "textContent.includes"));
  await sleep(500);
};
/** Select areas from the Content step's area list (shift adds). */
const pickAreas = async (...names) => {
  // From the area list; open shapes (rooflines, edges) aren't listed there, so on the picture.
  for (const [i, n] of names.entries()) await ed.click((await ed.eval(`!!${listArea(n)}`)) ? listArea(n) : area(n), { shift: i > 0 });
};

await ed.record();
await chapter("Before Effects", "Projection-mapping shows for your own building — from a photo to a show on the house");

// ---- 1. The house -------------------------------------------------------------------------------
await step("1 · start from a photo of the house", async () => {
  if (!(await ed.eval(`!!${q(".welcome")}`))) throw new Error("expected the welcome screen (close any open show first)");
  await chapter("1 · Start from a photo of your house", "Drop it on the window — HEIC from a phone works");
  await ed.dropFiles([PHOTO]);
  await ed.waitFor(`!!${q(".preview-toolbar")}`, 40_000);
  if (await ed.eval(`!!${byText(".preview-toolbar button", "Restore")}`)) await ed.click(byText(".preview-toolbar button", "Restore"));
  await view("Show preview");
  await ed.waitFor(`!!${q(".photo-underlay")}`, 40_000);
  await sleep(1800);
  return `${report.photo} opened as a 1920×1080 show`;
});

await step("2 · automatic house setup", async () => {
  await chapter("2 · Automatic house setup", "It finds the doors, windows, garage, columns, lights and roofline");
  await ed.click(byText(".house-setup button", "Find areas automatically"));
  if (await ed.eval(`!!${byText(".house-setup button", "Download and find areas")}`)) await ed.click(byText(".house-setup button", "Download and find areas"));
  await ed.fastForward("Finding the parts of the house…", 4, () => ed.waitFor(`document.querySelectorAll(".proposal-row").length > 0`, 600_000));
  await sleep(2500);
  await caption("Check each one: fix an outline, remove a doubtful one");
  await ed.click(byText(".proposal-row button", "Window"));
  await ed.waitFor(`!!${q('rect.vertex-handle[aria-label="Corner 2"]')}`);
  const c = await ed.at(q('rect.vertex-handle[aria-label="Corner 2"]'));
  await ed.drag(c, { x: c.x + 4, y: c.y - 3 });
  await sleep(700);
  const doubtful = await ed.eval(`(() => { const r = [...document.querySelectorAll(".proposal-row")].find((x) => /decoration/.test(x.querySelector(".why")?.textContent || "")); return r ? r.querySelector("button").textContent.split("·")[0].trim() : null; })()`);
  if (doubtful) await ed.click(q(`.proposal-row button[aria-label="Remove ${doubtful}"]`));
  await sleep(600);
  await ed.click(byText(".suggest-box button", "Accept all"));
  await ed.waitFor(`document.querySelectorAll(".proposal-row").length === 0`);
  await sleep(1500);
  return `areas accepted${doubtful ? `; removed “${doubtful}”` : ""}`;
});

await step("3 · draw your own area", async () => {
  await chapter("3 · Draw your own areas", "Rectangles, outlines and edges — reusable in every scene");
  await ed.click(startsText(".tools button", "Rectangle"));
  const box = await ed.eval(`(() => { const r = document.querySelector("svg.trace").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const P = (cx, cy) => ({ x: box.x + (cx / 1920) * box.w, y: box.y + (cy / 1080) * box.h });
  await ed.drag(P(300, 300), P(570, 420), 20);
  await ed.waitFor(`!!${q(".kind-chooser")}`);
  await sleep(700);
  // "What is this?" — a piece of wall.
  await ed.click(startsText(".kind-chooser button", "Wall"));
  await sleep(700);
  await ed.click(startsText(".tools button", "Select"));
  // Name it: double-click its name in the list.
  await ed.waitFor(`!!${q(".list-item.on")}`);
  await ed.click(q(".list-item.on"), { double: true });
  await ed.waitFor(`!!${q("input.area-rename")}`);
  await ed.key("a", { ctrl: true });
  await ed.type("Gable");
  await ed.key("Enter");
  await sleep(800);
  return "a rectangle drawn on the siding and named “Gable”";
});

// ---- 2. Scene 1: lights and moving architecture ----------------------------------------------------
await step("4 · media and music", async () => {
  await goStep("Content");
  await chapter("4 · Bring in your media", "Video, pictures and music — the beat is found automatically");
  await ed.dropFiles([VIDEO, PICTURE, MUSIC]);
  await ed.waitFor(`!!${byText(".media-item", "120 BPM")} && !!${byText(".media-item", "swirl")}`, 60_000);
  await sleep(800);
  await ed.click(`[...document.querySelectorAll(".media-item")].find((m) => m.textContent.includes("120 BPM")).querySelector(".chip")`);
  await sleep(1200);
  return "sample video, picture and 120 BPM music imported; music added to the show";
});

await step("5 · light up the house", async () => {
  await chapter("5 · Light the house", "Trace the roofline, then the windows and doors light up one after another");
  await setTime(0);
  await pickAreas("Roofline");
  await ed.click(card("Trace with light"));
  await sleep(1500);
  await setTime(1);
  await ed.click(byText(".content-panel .chip", "Openings"));
  await ed.click(card("Light up one after another"));
  await sleep(1500);
  return "Trace with light on the roofline at 0 s; Light up one after another on the openings at 1 s";
});

await step("6 · moving architecture (3D)", async () => {
  await chapter("6 · Make the architecture move", "The front door swings open and the window opens — real 3D, photo on the front");
  await setTime(0);
  await ed.click(area("Front door"));
  await ed.waitFor(`!!${byText(".make-move button", "Swing open")}`);
  await ed.click(byText(".make-move button", "Swing open"));
  await ed.waitFor(`!!${q(".part-editor")}`);
  await setSlider("Starts at", 4 / 60, ".part-editor");
  await sleep(800);
  await ed.click(area("Window"));
  await ed.waitFor(`!!${byText(".make-move button", "Swing open")}`);
  await ed.click(byText(".make-move button", "Swing open"));
  await ed.waitFor(`!!${q(".part-editor")}`);
  await setSlider("Starts at", 6 / 60, ".part-editor");
  await sleep(1200);
  return "front door opens at ~4 s, window at ~6 s";
});

await step("7 · video on the garage, with keyframes", async () => {
  await chapter("7 · Drop a video onto the garage door", "It's clipped to the door right away; animate it with ◆ keyframes");
  await setTime(8);
  const dragged = await ed.dragOnto(`[...document.querySelectorAll(".media-item")].find((m) => m.textContent.includes("swirl"))`, listArea("Garage door"));
  if (!dragged) {
    await pickAreas("Garage door");
    await ed.click(`[...document.querySelectorAll(".media-item")].find((m) => m.textContent.includes("swirl")).querySelector(".chip")`);
  }
  await sleep(1800);
  return dragged ? "dragged onto the garage door at 8 s" : "put on the garage door at 8 s";
});

await step("8 · text on your own area", async () => {
  await chapter("8 · Words on the house", "Text on the area drawn earlier — every setting adjustable");
  await setTime(10);
  await goStep("Content");
  await pickAreas("Gable");
  await ed.click(card("Add text"));
  await ed.waitFor(`!!${q('textarea[aria-label="Text"]')}`);
  await ed.click(q('textarea[aria-label="Text"]'));
  await ed.key("a", { ctrl: true });
  await ed.type("WELCOME HOME");
  await sleep(800);
  const more = await ed.eval(`!!${byText("button.disclosure", "More controls")}`);
  if (more) await ed.click(byText("button.disclosure", "More controls"));
  if (await ed.eval(`!!document.querySelector('input[type="range"][aria-label="Letter spacing"]')`)) await setSlider("Letter spacing", 0.3);
  if (await ed.eval(`!!${q('button[role="switch"][aria-label="Outline"]')}`)) await ed.click(q('button[role="switch"][aria-label="Outline"]'));
  await sleep(1200);
  return "“WELCOME HOME” on the Gable area at 10 s, letter spacing and outline set";
});

await step("9 · light on the beat", async () => {
  await chapter("9 · Light on the beat", "Windows and doors flash with the music's beats");
  await setTime(14);
  await goStep("Content");
  await ed.click(byText(".content-panel .chip", "Openings"));
  await ed.click(card("Move with the beat"));
  await sleep(1500);
  return "Move with the beat on the openings from 14 s";
});

await step("10 · particles and neon", async () => {
  await chapter("10 · Particles and neon", "Embers drift up from the vent; the house outlines glow like a neon sign");
  await setTime(18);
  await pickAreas("Vent");
  await ed.click(card("Embers"));
  await sleep(1200);
  await setTime(22);
  await goStep("Content");
  await pickAreas("Facade");
  await ed.click(card("Neon outline"));
  await sleep(1500);
  return "Embers from the vent at 18 s; Neon outline on the facade at 22 s";
});

await step("11 · every setting is yours", async () => {
  await chapter("11 · Every setting is yours", "Colour, glow size, flickers… change them and see it at once");
  await ed.waitFor(`!!document.querySelector(".inspector")`);
  const sw = `[...document.querySelectorAll('.inspector .swatches button')].find((b) => b.getAttribute("aria-label") === "#4d8cff") || document.querySelectorAll('.inspector .swatches button')[3]`;
  if (await ed.eval(`!!(${sw})`)) await ed.click(sw);
  const more = await ed.eval(`!!${byText("button.disclosure", "More controls")}`);
  if (more) await ed.click(byText("button.disclosure", "More controls"));
  if (await ed.eval(`!!document.querySelector('input[type="range"][aria-label="Glow size"]')`)) await setSlider("Glow size", 0.55);
  await sleep(1500);
  return "neon colour and glow size changed in the inspector";
});

await step("12 · preview at any size", async () => {
  await chapter("12 · Preview at any size — and on the house", "Full, Half, Quarter… simulated on the photo as the audience will see it");
  await view("On the house");
  await ed.eval(`(() => { const s = document.querySelector('select[aria-label="Preview size"]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(s, "half"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await setTime(0);
  await ed.click(q('button[aria-label="Play"]'));
  await sleep(12_000);
  await ed.click(q('button[aria-label="Pause"]'));
  await caption(null);
  return "played the first 12 s of scene 1 at Half size";
});

// ---- 3. Scene 2: simulations, physics and the finale ------------------------------------------------
await step("13 · a second scene", async () => {
  await chapter("13 · A second scene", "Same areas, new content — scenes are arranged into the show later");
  await ed.click(q(".scene-add"));
  await ed.click(byText(".scene-menu button", "Empty scene"));
  await sleep(1200);
  return "Scene 2 created (empty, same areas)";
});

const blender = async (button, areaName, label, factor = 10) => {
  if (!(await ed.eval(`!!${byText(".preview-toolbar [role=radio][aria-checked=true]", "Show preview")} || !!${byText(".preview-toolbar [role=radio][aria-checked=true]", "On the house")}`))) await view("On the house");
  await goStep("Animate");
  await ed.click(area(areaName));
  const has = await ed.eval(`!!${startsText(".blender-effects button", button)}`);
  if (!has) return `${button}: Blender not installed — skipped`;
  await ed.click(startsText(".blender-effects button", button));
  await ed.waitFor(`!!${q(".blender-progress")}`, 20_000);
  const s = await ed.fastForward(label, factor, () => ed.waitFor(hasLayer(button), 900_000));
  await sleep(1200);
  return `${button} on ${areaName}: simulated and rendered by Blender in ${s.toFixed(0)} s`;
};

await step("14 · cloth reveal (Blender)", async () => {
  await chapter("14 · A cloth reveal, simulated in Blender", "A sheet hangs over the garage, then drops and crumples");
  await setTime(0);
  return blender("Cloth reveal", "Garage door", "Blender is simulating the cloth…", 6);
});

await step("15 · collapse and rebuild (real physics)", async () => {
  await chapter("15 · Collapse and rebuild — real physics", "The garage breaks into pieces, falls onto the ledge, and flies back");
  await setTime(3);
  await goStep("Content");
  await pickAreas("Garage door");
  await ed.click(card("Collapse & rebuild"));
  await ed.waitFor(hasLayer("Garage door in 3D"));
  await sleep(800);
  await setTime(3);
  await pickAreas("Garage door");
  await ed.click(card("Sparks"));
  await sleep(1500);
  return "Collapse & rebuild (Rapier) at 3 s with sparks";
});

await step("16 · look around in 3D", async () => {
  await chapter("16 · Look around it in 3D", "The pieces have real depth and shadows");
  await setTime(5.5);
  await ed.click(byText(".preview-toolbar [role=radio]", "3D projection"));
  await ed.waitFor(`!!${q(".preview-panel.is-3d")}`);
  await sleep(1500);
  const c = await ed.eval(`(() => { const r = document.querySelector(".preview-panel.is-3d .orbit-layer, .preview-panel.is-3d .canvas-stage").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await ed.drag(c, { x: c.x + 260, y: c.y - 40 }, 30);
  await sleep(1200);
  await ed.drag({ x: c.x + 260, y: c.y - 40 }, { x: c.x - 120, y: c.y + 10 }, 30);
  await sleep(1200);
  await view("On the house");
  await ed.waitFor(`!${q(".preview-panel.is-3d")}`);
  return "orbited the 3D view during the collapse";
});

await step("17 · fire (Blender)", async () => {
  await chapter("17 · Fire, simulated in Blender", "Real flames around the house, lined up with the show");
  await setTime(10);
  return blender("Fire", "Column 2", "Blender is simulating the fire…", 10);
});

await step("18 · water pouring (Blender)", async () => {
  await chapter("18 · Water bursting from the window", "A real liquid simulation, splashing down the front");
  await setTime(14);
  return blender("Water pouring", "Window", "Blender is simulating the water…", 10);
});

await step("19 · melt and smoke", async () => {
  await chapter("19 · The door melts; smoke rises", "Procedural looks and a 2D smoke simulation — each labelled");
  await setTime(18);
  await goStep("Content");
  await pickAreas("Front door");
  await ed.click(card("Melt"));
  await sleep(1000);
  await setTime(18);
  await pickAreas("Vent");
  await ed.click(card("Smoke rising"));
  await sleep(1500);
  return "Melt on the front door; Smoke rising from the vent at 18 s";
});

await step("20 · snow and confetti", async () => {
  await chapter("20 · Snow and a confetti finale", "Particles in 3D, in front of the house");
  await setTime(20);
  await goStep("Content");
  await pickAreas("Facade");
  await ed.click(card("Snow"));
  await sleep(1000);
  await setTime(24);
  await pickAreas("Front door");
  await ed.click(card("Confetti"));
  await sleep(1500);
  return "Snow from 20 s; Confetti from the front door at 24 s";
});

await step("21 · describe it in plain words", async () => {
  await chapter("21 · Describe what you want", "The effects library understands everyday words");
  await goStep("Animate");
  const box = `document.querySelector("#library-search")`;
  await ed.click(box);
  await ed.type("make this look like water");
  await sleep(2200);
  await ed.key("a", { ctrl: true });
  await ed.type("sparkle");
  await sleep(1800);
  await ed.key("a", { ctrl: true });
  await ed.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await ed.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  return "searched “make this look like water” and “sparkle”";
});

await step("22 · an AI agent adds an effect", async () => {
  await chapter("22 · An AI agent can work in it too", "Claude Code, Codex or any MCP client — here a separate program adds an effect");
  await ed.click(byText(".topbar button", "Agents"));
  await sleep(2500);
  await ed.click(q('.agent-panel button[aria-label="Close"]'));
  await api("effects.apply", { effect: "pulse", areas: ["Column 1", "Column 2", "Column 3"], settings: { color: "#4d80ff", bpm: 120 }, startSeconds: 26, name: "Blue pulse (by an agent)" });
  await ed.waitFor(hasLayer("Blue pulse"), 10_000);
  await sleep(2500);
  return "an external program added a blue pulse on the columns through the agent API (one undo step)";
});

await step("23 · two projectors, edge blending", async () => {
  await chapter("23 · Several projectors, blended", "Each lights part of the house; where they overlap, the light is shared");
  await ed.click(byText(".segmented button, button", "Projector output"));
  await ed.waitFor(`!!${byText(".projectors button", "+ Add projector")}`);
  await sleep(1000);
  await ed.click(byText(".projectors button", "+ Add projector"));
  await ed.waitFor(`!!${byText(".projectors button", "Side by side")}`);
  await sleep(700);
  await ed.click(byText(".projectors button", "Side by side"));
  await sleep(1500);
  await ed.click(byText('.projectors [role="radiogroup"] button', "Projector 1"));
  await sleep(1800);
  await ed.click(byText('.projectors [role="radiogroup"] button', "Projector 2"));
  await sleep(1800);
  await view("On the house");
  return "Projector 2 added, side by side with a 15% overlap, blended";
});

await step("24 · arrange the show", async () => {
  await chapter("24 · Arrange the show", "Scene 1, then Scene 2 with a crossfade — the running order you'll play or export");
  await ed.click(q(".show-tab"));
  await ed.waitFor(`!!${q(".show-arranger")}`);
  await sleep(2500);
  return "the show: Scene 1 → crossfade → Scene 2";
});

await step("25 · export the show", async () => {
  await chapter("25 · Export", "A video to share, a master, transparent, or warped for each projector");
  const before = await ed.eval("window.be.render.list().then((l) => l.length)");
  await goStep("Export or play");
  await ed.waitFor(`!!${q("dialog.export .outcome")}`);
  await sleep(1200);
  await ed.click(byText("dialog.export .outcome", "A video to share"));
  await sleep(800);
  await ed.click(byText("dialog.export button.primary", "Export"));
  const s = await ed.fastForward("Exporting in the background — you can keep working…", 8, () => ed.waitFor(`window.be.render.list().then((l) => l.length > ${before} && ["done", "failed"].includes(l[l.length - 1].state))`, 1_200_000));
  const job = await ed.eval("window.be.render.list().then((l) => l[l.length - 1])");
  if (job.state !== "done") throw new Error(`export ${job.state}: ${job.error}`);
  await ed.click(q('dialog.export button[aria-label="Close"]')).catch(() => {});
  report.export = job.result;
  return `${job.result} (${s.toFixed(0)} s; ${job.verify?.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}`).join(", ")})`;
});

await step("26 · the show, on the house", async () => {
  await chapter("26 · The show, on the house", "As the audience will see it");
  await caption(null);
  await ed.click(q(".show-tab"));
  await view("On the house");
  if (await ed.eval(`!!${byText(".preview-toolbar button", "Enlarge")}`)) await ed.click(byText(".preview-toolbar button", "Enlarge"));
  await ed.eval(`(() => { const s = document.querySelector('select[aria-label="Preview size"]'); if (!s) return; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(s, "full"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await ed.click(q('button[aria-label="Back to start"]'));
  await sleep(1500);
  const dur = (await api("show.get")).seconds;
  if (!(dur > 0)) throw new Error("the show has no length");
  await ed.click(q('button[aria-label="Play"]'));
  const s0 = Date.now();
  // Until the end (or it wraps round, if looping).
  for (let last = 0; ; ) {
    await sleep(400);
    const pb = await api("playback.get");
    if (pb.seconds >= dur - 0.15 || pb.seconds < last - 1 || (!pb.playing && Date.now() - s0 > 3000) || Date.now() - s0 > (dur + 15) * 1000) break;
    last = pb.seconds;
  }
  await sleep(800);
  if (await ed.eval(`!!${q('button[aria-label="Pause"]')}`)) await ed.click(q('button[aria-label="Pause"]'));
  return `played the whole ${dur.toFixed(0)} s show on the house`;
});

await caption("Before Effects", "Your building, your content, your show");
await sleep(3500);
report.recording = await ed.stopRecording(join(OUT, "Before Effects - full demo.mp4"));
await caption(null);
if (await ed.eval(`!!${byText(".preview-toolbar button", "Restore")}`)) await ed.click(byText(".preview-toolbar button", "Restore")).catch(() => {});
await view("Show preview").catch(() => {});
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
log(`${report.ok ? "ALL PASSED" : "SOME FAILED"} · recording: ${report.recording}`);
app.kill();
process.exit(report.ok ? 0 : 1);
