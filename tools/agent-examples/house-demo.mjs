/**
 * The house demonstration, recorded: the packaged app driven like a person (mouse and keyboard
 * through the Chromium DevTools protocol, files dropped as from Explorer) while the screen is
 * recorded.
 *
 *   node tools/agent-examples/house-demo.mjs [photo]
 *
 * Drop a house photo → find areas automatically → fix an outline → remove a doubtful one → accept →
 * the front door swings open and the window opens (3D) → a video on the garage door → play the show
 * and the simulated view on the house → export.
 *
 * Photo: the argument, BE_HOUSE_PHOTO, or the first photo in <data folder>\Venue. Results (the
 * recording, the exported video and report.json) go to <data folder>\Renders\house-demo.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const EXE = process.env.BE_EXE || join(ROOT, "build", "app", "Before Effects.exe");
// The app's data folder (the same rule the app uses).
const DATA = process.env.BE_DATA || (existsSync("D:\\") ? "D:\\Before Effects" : join(homedir(), "Documents", "Before Effects"));
const OUT = join(DATA, "Renders", "house-demo");
const venueDir = join(DATA, "Venue");
const PHOTO =
  process.argv[2] ||
  process.env.BE_HOUSE_PHOTO ||
  (existsSync(venueDir) ? readdirSync(venueDir).filter((f) => /\.(heic|heif|jpe?g|png)$/i.test(f)).sort((a, b) => Number(/\.hei[cf]$/i.test(b)) - Number(/\.hei[cf]$/i.test(a))).map((f) => join(venueDir, f))[0] : undefined);
const VIDEO = join(DATA, "Test content", "Sample footage (generated, not AtmosFX) - swirl.mp4");
const PORT = 9334;
if (!PHOTO) throw new Error(`No house photo: pass one, set BE_HOUSE_PHOTO, or put one in ${venueDir}`);
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
    for (let i = 0; i < 120 && !page; i++) {
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
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      } else if (msg.method === "Page.screencastFrame") {
        this.frames.push({ t: msg.params.metadata.timestamp, data: msg.params.data });
        void this.send("Page.screencastFrameAck", { sessionId: msg.params.sessionId });
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
  async mouse(type, x, y, buttons = 0) {
    await this.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
  }
  /** Glide the pointer there (so the recording shows where it goes), then click. */
  async click(js) {
    const p = await this.at(js);
    await this.glide(p);
    await this.mouse("mousePressed", p.x, p.y, 1);
    await this.mouse("mouseReleased", p.x, p.y);
    await sleep(350);
  }
  async glide(to, from = this.last ?? { x: to.x - 60, y: to.y - 40 }) {
    for (let i = 1; i <= 10; i++) await this.mouse("mouseMoved", from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
    this.last = to;
  }
  async drag(from, to) {
    await this.glide(from);
    await this.mouse("mousePressed", from.x, from.y, 1);
    for (let i = 1; i <= 12; i++) await this.mouse("mouseMoved", from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12, 1);
    await this.mouse("mouseReleased", to.x, to.y);
    this.last = to;
    await sleep(300);
  }
  /** Drop files onto the window, as if dragged from Explorer. */
  async dropFiles(files) {
    const box = await this.eval("({ x: innerWidth / 2, y: innerHeight / 2 })");
    const data = { items: [], files, dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"]) await this.send("Input.dispatchDragEvent", { type, x: box.x, y: box.y, data });
  }
  async waitFor(js, timeout = 10_000) {
    const s = Date.now();
    while (Date.now() - s < timeout) {
      if (await this.eval(js)) return (Date.now() - s) / 1000;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${js}`);
  }
  async record() {
    await this.send("Page.enable");
    await this.send("Page.startScreencast", { format: "jpeg", quality: 82, everyNthFrame: 1 });
  }
  async stopRecording(file) {
    await this.send("Page.stopScreencast");
    const dir = join(OUT, "frames");
    const lines = [];
    this.frames.forEach((f, i) => {
      const name = `f${String(i).padStart(5, "0")}.jpg`;
      writeFileSync(join(dir, name), Buffer.from(f.data, "base64"));
      const next = this.frames[i + 1];
      lines.push(`file '${name}'`, `duration ${Math.max(0.02, Math.min(2, next ? next.t - f.t : 0.5)).toFixed(3)}`);
    });
    writeFileSync(join(dir, "list.txt"), lines.join("\n"));
    const ffmpeg = join(EXE, "..", "resources", "bin", "ffmpeg.exe");
    await new Promise((res) => spawn(ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "list.txt", "-vf", "fps=25,scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", file], { cwd: dir, stdio: "ignore" }).on("exit", res));
    rmSync(dir, { recursive: true, force: true });
    return file;
  }
}

const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const byText = (sel, text) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.includes(${JSON.stringify(text)}))`;
const area = (name) => `[...document.querySelectorAll("svg.overlay path.region")].find((p) => (p.getAttribute("aria-label") || "").startsWith(${JSON.stringify(name)}))`;

const app = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: "ignore" });
const ed = await Editor.connect();
await ed.waitFor(`!!document.querySelector(".welcome") || !!document.querySelector(".topbar, .route")`, 30_000);
await ed.record();
await sleep(1500);

await step("drop the house photo on the window", async () => {
  if (!(await ed.eval(`!!${q(".welcome")}`))) throw new Error("expected the welcome screen (close any open show first)");
  await ed.dropFiles([PHOTO]);
  const s = await ed.waitFor(`!!${q(".photo-underlay")}`, 30_000);
  await sleep(1500);
  return `${report.photo} opened as a new 1920×1080 show in ${s.toFixed(1)} s`;
});

await step("find areas automatically", async () => {
  await ed.click(byText(".house-setup button", "Find areas automatically"));
  if (await ed.eval(`!!${byText(".house-setup button", "Download and find areas")}`)) await ed.click(byText(".house-setup button", "Download and find areas"));
  const s = await ed.waitFor(`document.querySelectorAll(".proposal-row").length > 0`, 600_000);
  await sleep(2500);
  const rows = await ed.eval(`[...document.querySelectorAll(".proposal-row")].map((r) => r.querySelector("button").textContent.trim() + (r.querySelector(".why") ? " (check)" : ""))`);
  return `${rows.length} areas in ${s.toFixed(1)} s: ${rows.join(", ")}`;
});

await step("fix an outline: drag a corner of the window", async () => {
  await ed.click(byText(".proposal-row button", "Window"));
  await ed.waitFor(`!!${q('rect.vertex-handle[aria-label="Corner 2"]')}`);
  const c = await ed.at(q('rect.vertex-handle[aria-label="Corner 2"]'));
  await ed.drag(c, { x: c.x + 4, y: c.y - 3 });
  await sleep(800);
  return "dragged the top-right corner of the window";
});

await step("remove a doubtful one", async () => {
  const name = await ed.eval(`(() => { const r = [...document.querySelectorAll(".proposal-row")].find((x) => /decoration/.test(x.querySelector(".why")?.textContent || "")); return r ? r.querySelector("button").textContent.split("·")[0].trim() : null; })()`);
  if (!name) return "nothing flagged as a decoration";
  await ed.click(q(`.proposal-row button[aria-label="Remove ${name}"]`));
  return `removed “${name}” (flagged: may be a decoration)`;
});

await step("accept the rest", async () => {
  await ed.click(byText(".suggest-box button", "Accept all"));
  await ed.waitFor(`document.querySelectorAll(".proposal-row").length === 0`);
  await sleep(1200);
  return "accepted";
});

await step("make the front door swing open", async () => {
  await ed.click(area("Front door"));
  await ed.waitFor(`!!${byText(".action-bar button", "Swing open (3D)")}`);
  await sleep(600);
  await ed.click(byText(".action-bar button", "Swing open (3D)"));
  await ed.waitFor(`!!${q(".part-editor")}`);
  await sleep(1500);
  return "front door: swings into the house on its hinge";
});

await step("open the window", async () => {
  await ed.click(area("Window"));
  await ed.waitFor(`!!${byText(".make-move button", "Swing open")}`);
  await sleep(600);
  await ed.click(byText(".make-move button", "Swing open"));
  await ed.waitFor(`!!${q(".part-editor")}`);
  await sleep(1500);
  return "window: swings out toward the audience, with a lit room behind";
});

await step("a video on the garage door", async () => {
  await ed.click(byText(".route-step", "Content"));
  await ed.dropFiles([VIDEO]);
  await ed.waitFor(`!!${byText(".media-item", "swirl")}`, 30_000);
  await ed.click(area("Garage door"));
  await ed.waitFor(`!!${byText(".media-item .chip", "Put in selection")}`);
  await ed.click(`[...document.querySelectorAll(".media-item")].find((m) => m.textContent.includes("swirl")).querySelector(".chip")`);
  await sleep(1500);
  return "sample video (generated, not AtmosFX) put on the garage door";
});

await step("play the show", async () => {
  await ed.click(q('button[aria-label="Back to start"]'));
  await ed.click(q('button[aria-label="Play"]'));
  await sleep(6500);
  await ed.click(q('button[aria-label="Pause"]'));
  return "played 6.5 s in the show preview";
});

await step("play it on the house (simulated)", async () => {
  await ed.click(byText(".segmented button, button", "On the house"));
  await ed.click(q('button[aria-label="Back to start"]'));
  await ed.click(q('button[aria-label="Play"]'));
  await sleep(6500);
  await ed.click(q('button[aria-label="Pause"]'));
  await ed.click(byText(".segmented button, button", "Show preview"));
  return "played 6.5 s in the simulated view on the house";
});

await step("export a video", async () => {
  const before = await ed.eval("window.be.render.list().then((l) => l.length)");
  await ed.click(byText(".route-step", "Export or play"));
  await ed.waitFor(`!!${q("dialog.export .outcome")}`);
  await ed.click(byText("dialog.export .outcome", "A video to share"));
  await ed.click(byText("dialog.export button.primary", "Export"));
  const s = await ed.waitFor(`window.be.render.list().then((l) => l.length > ${before} && ["done", "failed"].includes(l[l.length - 1].state))`, 600_000);
  const job = await ed.eval("window.be.render.list().then((l) => l[l.length - 1])");
  if (job.state !== "done") throw new Error(`export ${job.state}: ${job.error}`);
  await ed.click(q('dialog.export button[aria-label="Close"]')).catch(() => {});
  report.export = job.result;
  return `${job.result} (${s.toFixed(0)} s; ${job.verify?.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}`).join(", ")})`;
});

await sleep(1500);
report.recording = await ed.stopRecording(join(OUT, "House demo - screen recording.mp4"));
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
log(`${report.ok ? "ALL PASSED" : "SOME FAILED"} · recording: ${report.recording}`);
app.kill();
process.exit(report.ok ? 0 : 1);
