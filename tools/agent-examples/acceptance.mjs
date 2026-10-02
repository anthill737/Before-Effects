/**
 * External-agent acceptance run against the normally launched, packaged Before Effects.
 *
 * A separate process (this script) acts as the agent through the MCP server, exactly as Claude
 * Code or Codex would, while the person's manual edits are simulated with real mouse and keyboard
 * input sent to the editor window (Chromium DevTools protocol). The editor is screen-recorded.
 *
 *   node tools/agent-examples/acceptance.mjs            (Agent access must be on; see README)
 *
 * Steps: connect → inspect → create an area and assign media → change a 3D effect and its timing →
 * capture the preview → undo → save and export → monitor the export while editing by hand.
 * Then: retried requests, reconnects (adapter, event stream, app restart), conflicting manual
 * edits, and a failed transaction that must leave no partial edit.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beAdapter, McpClient } from "./mcp-client.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const EXE = process.env.BE_EXE || join(ROOT, "build", "app", "Before Effects.exe");
const DATA = process.env.BE_DATA || "D:/Before Effects";
const OUT = join(DATA, "Renders", "agent-acceptance");
const HOUSE = process.env.BE_HOUSE || `${DATA}/Venue/My house - working copy (4000x2252).png`;
const SWIRL = `${DATA}/Test content/Sample footage (generated, not AtmosFX) - swirl.mp4`;
const PATTERN = `${DATA}/Test content/Sample footage (generated, not AtmosFX) - pattern with tone.mp4`;
const DEBUG_PORT = 9333;
mkdirSync(join(OUT, "frames"), { recursive: true });

const report = { at: new Date().toISOString(), app: EXE, steps: [], ok: true };
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = async (name, fn) => {
  const s = Date.now();
  try {
    const note = await fn();
    report.steps.push({ name, ok: true, ms: Date.now() - s, note });
    log(`PASS ${name} — ${note}`);
  } catch (e) {
    report.ok = false;
    report.steps.push({ name, ok: false, ms: Date.now() - s, error: String(e?.stack ?? e) });
    log(`FAIL ${name} — ${e?.message ?? e}`);
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const conn = () => JSON.parse(readFileSync(join(process.env.APPDATA, "Before Effects", "agent-api.json"), "utf8"));
const http = async (method, params, requestId) => {
  const c = conn();
  const r = await fetch(`${c.url}/v1/call`, { method: "POST", headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" }, body: JSON.stringify({ method, params, ...(requestId ? { requestId } : {}) }) });
  return r.json();
};

// ---- the app, launched normally (plus a DevTools port only to simulate the person's hands) ----------

let app;
const launch = async () => {
  app = spawn(EXE, [`--remote-debugging-port=${DEBUG_PORT}`], { detached: false, stdio: "ignore" });
  for (let i = 0; i < 120; i++) {
    try {
      const r = await (await fetch(`${conn().url}/v1/ping`)).json();
      if (r.app === "Before Effects") return;
    } catch {
      /* starting */
    }
    await sleep(250);
  }
  throw new Error("Before Effects didn't start listening (is Agent access on?)");
};

// ---- Chromium DevTools: real input events into the editor window, and a screen recording ------------

class Editor {
  static async connect() {
    let page;
    for (let i = 0; i < 60 && !page; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
        page = list.find((p) => p.type === "page" && /#editor/.test(p.url));
      } catch {
        /* not yet */
      }
      if (!page) await sleep(250);
    }
    if (!page) throw new Error("editor window not found on the DevTools port");
    const e = new Editor(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      e.ws.onopen = res;
      e.ws.onerror = rej;
    });
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
        const { data, sessionId, metadata } = msg.params;
        this.frames.push({ t: metadata.timestamp, data });
        void this.send("Page.screencastFrameAck", { sessionId });
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
    return r.result?.value;
  }
  async center(selectorJs) {
    return this.eval(`(() => { const el = ${selectorJs}; if (!el) return null; el.scrollIntoView({block: "nearest"}); const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const at = document.elementFromPoint(x, y); return { x, y, covered: at && !el.contains(at) ? at.outerHTML.slice(0, 120) : null }; })()`);
  }
  async click(selectorJs) {
    const p = await this.center(selectorJs);
    if (!p) throw new Error(`nothing to click: ${selectorJs}`);
    // Like a person: if something covers the control, that's a real problem, not something to click through.
    if (p.covered) throw new Error(`the control is covered by ${p.covered}`);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
  }
  async key(key, code, modifiers = 0, vk = 0) {
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, modifiers, windowsVirtualKeyCode: vk });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers, windowsVirtualKeyCode: vk });
  }
  async waitFor(js, timeout = 5000) {
    const s = Date.now();
    while (Date.now() - s < timeout) {
      if (await this.eval(js)) return Date.now() - s;
      await sleep(10);
    }
    throw new Error(`timed out waiting for ${js}`);
  }
  async record() {
    await this.send("Page.enable");
    await this.send("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 });
  }
  async stopRecording(file) {
    await this.send("Page.stopScreencast");
    if (!this.frames.length) return null;
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
    await new Promise((res) => spawn(ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"), "-vf", "fps=25,scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", file], { cwd: dir, stdio: "ignore" }).on("exit", res));
    return file;
  }
}

// ---- events (Server-Sent Events, resumable) ---------------------------------------------------------

const events = [];
let lastSeq = 0;
let sseAbort;
const openEvents = async (after) => {
  const c = conn();
  sseAbort = new AbortController();
  const res = await fetch(`${c.url}/v1/events${after !== undefined ? `?after=${after}` : ""}`, { headers: { authorization: `Bearer ${c.token}` }, signal: sseAbort.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split("\n").find((l) => l.startsWith("data: "));
          if (!data) continue;
          const e = JSON.parse(data.slice(6));
          events.push(e);
          lastSeq = Math.max(lastSeq, e.seq);
        }
      }
    } catch {
      /* closed */
    }
  })();
};

// ---- run ------------------------------------------------------------------------------------------

let mcp, editor, revision = 0, jobId, savedPath, windowId, wallScene;

await step("launch app normally (packaged), API listening", async () => {
  assert(existsSync(EXE), `packaged app not found: ${EXE}`);
  await launch();
  editor = await Editor.connect();
  await editor.record();
  await sleep(1500);
  return `${EXE} → ${conn().url}`;
});

await step("1. connect an external MCP client", async () => {
  mcp = await McpClient.start(beAdapter());
  const tools = await mcp.listTools();
  assert(tools.length > 50, `only ${tools.length} tools`);
  await openEvents();
  return `${tools.length} tools, e.g. ${tools.slice(3, 8).map((t) => t.name).join(", ")}; event stream open`;
});

await step("2. inspect the open project (start the house show if none)", async () => {
  let r = await mcp.call("project_get", {});
  assert(r.ok, JSON.stringify(r.data));
  if (!r.data.result.open || r.data.result.name !== "My house acceptance") {
    const n = await mcp.call("project_newFromPhoto", { photo: HOUSE, discardChanges: true });
    assert(n.ok, JSON.stringify(n.data));
    await mcp.call("ops_apply", { operations: [{ type: "project.rename", args: { name: "My house acceptance" } }], label: "Name the show" });
    r = await mcp.call("project_get", {});
  }
  const p = r.data.result;
  revision = p.revision;
  const areas = await mcp.call("areas_list", {});
  const scenes = await mcp.call("scenes_list", {});
  return `“${p.name}”, building ${p.building.canvas.width}×${p.building.canvas.height} from ${p.building.photo}, ${areas.data.result.areas.length} areas, ${scenes.data.result.length} scene(s), revision ${revision}`;
});

await step("3. create an area and assign media", async () => {
  const a = await mcp.call("areas_create", { kind: "window", name: "Front window", rect: { x: 1316, y: 460, w: 292, h: 218 } });
  assert(a.ok, JSON.stringify(a.data));
  windowId = a.data.result.area.id;
  const imp = await mcp.call("assets_import", { paths: [SWIRL, PATTERN] });
  assert(imp.ok, JSON.stringify(imp.data));
  const c = await mcp.call("content_assign", { asset: "Sample footage (generated, not AtmosFX) - swirl.mp4", areas: ["Front window"], settings: { fit: "fill", loop: true }, startSeconds: 0 });
  assert(c.ok, JSON.stringify(c.data));
  const inEditor = await editor.eval(`[...document.querySelectorAll(".bar span")].some(s => s.textContent.includes("swirl"))`);
  return `area ${windowId}; ${imp.data.result.imported.length} files imported; content ${c.data.result.content.id} on Front window; visible in the editor's timeline: ${inEditor}`;
});

await step("4. modify a 3D effect and its timing", async () => {
  const w = await mcp.call("areas_create", { kind: "wall", name: "Garage wall", rect: { x: 160, y: 250, w: 660, h: 250 } });
  assert(w.ok, JSON.stringify(w.data));
  const s = await mcp.call("scene3d_createFromAreas", { areas: ["Garage wall"], collapse: true, thicknessCm: 25 });
  assert(s.ok, JSON.stringify(s.data));
  wallScene = s.data.result.scene;
  const u = await mcp.call("scene3d_objectUpdate", { scene: wallScene, object: "Wall (3D)", fracture: { collapseAt: 1.5, rebuildAt: 5, pieceSize: 60, push: 0.8 } });
  assert(u.ok && u.data.result.object.fracture.collapseAt === 1.5, JSON.stringify(u.data));
  const l = await mcp.call("scene3d_layer", { scene: wallScene, startSeconds: 0.5, seconds: 7 });
  assert(l.ok, JSON.stringify(l.data));
  const prep = await mcp.call("prepare_wait", { timeoutMs: 60000 });
  assert(prep.ok && prep.data.result.ready, JSON.stringify(prep.data));
  return `collapse at 1.5 s, rebuild at 5 s, 60 cm pieces; layer starts at 0.5 s for 7 s; physics prepared in ${prep.data.result.waitedMs} ms`;
});

await step("5. capture the resulting preview", async () => {
  await mcp.call("preview_set", { view: "show", resolution: "full" });
  const c = await mcp.call("preview_capture", { seconds: 3.2, inline: true });
  assert(c.ok && c.images.length === 1, JSON.stringify(c.data).slice(0, 300));
  const file = join(OUT, "agent-preview-capture.png");
  writeFileSync(file, Buffer.from(c.images[0].data, "base64"));
  const r = c.data.result;
  return `${r.width}×${r.height} at ${r.seconds} s (${r.view}, ${r.resolution}, complete: ${r.complete}); image returned to the agent and saved to ${file}`;
});

await step("6. undo an edit", async () => {
  const content = (await mcp.call("content_list", { area: "Front window" })).data.result[0];
  const before = content.settings.scale;
  const u = await mcp.call("content_update", { id: content.id, settings: { scale: 160 } });
  assert(u.ok && u.data.result.content.settings.scale === 160, "update failed");
  const und = await mcp.call("history_undo", {});
  assert(und.ok, JSON.stringify(und.data));
  const after = (await mcp.call("content_list", { area: "Front window" })).data.result[0].settings.scale;
  assert(after === before, `scale after undo ${after}, expected ${before}`);
  return `scale ${before} → 160 → undo → ${after} (undid “${und.data.result.undone[0]}”)`;
});

await step("7. save and export", async () => {
  const s = await mcp.call("project_save", { path: `${DATA.replace(/\//g, "\\")}\\Venue\\My house acceptance.beproj` });
  assert(s.ok, JSON.stringify(s.data));
  savedPath = s.data.result.path;
  const e = await mcp.call("export_start", { purpose: "share", size: "full", range: { startSeconds: 0, endSeconds: 8 } });
  assert(e.ok, JSON.stringify(e.data));
  jobId = e.data.result.job;
  return `saved ${savedPath}; export ${jobId} → ${e.data.result.output} (${e.data.result.width}×${e.data.result.height}, ${e.data.result.frames} frames)`;
});

await step("8. monitor the export while editing by hand", async () => {
  const lat = [];
  // Manual edits through real input while the export renders.
  await editor.click(`[...document.querySelectorAll(".route-step")].find(b => b.textContent.includes("Content"))`);
  await sleep(300);
  for (let i = 0; i < 3; i++) {
    const name = "Sample footage (generated, not AtmosFX) - swirl.mp4";
    const hideSel = `[...document.querySelectorAll('button[aria-label^="Hide"]')].find(b => b.getAttribute("aria-label").includes("swirl"))`;
    const showSel = `[...document.querySelectorAll('button[aria-label^="Show"]')].find(b => b.getAttribute("aria-label").includes("swirl"))`;
    let s = Date.now();
    await editor.click(hideSel);
    await editor.waitFor(`!!(${showSel})`);
    lat.push(Date.now() - s);
    s = Date.now();
    await editor.click(showSel);
    await editor.waitFor(`!!(${hideSel})`);
    lat.push(Date.now() - s);
    void name;
  }
  // Scrub the timeline by hand.
  const ruler = await editor.center(`document.querySelector(".ruler")`);
  for (let k = 0; k < 10; k++) {
    const x = ruler.x - 300 + k * 40;
    const s = Date.now();
    await editor.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y: ruler.y, button: "left", clickCount: 1 });
    await editor.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y: ruler.y, button: "left", clickCount: 1 });
    lat.push(Date.now() - s);
  }
  const progress = [];
  for (;;) {
    const j = events.filter((e) => e.type === "jobs").map((e) => e.data.find((x) => x.id === jobId)).filter(Boolean).at(-1);
    if (j && !progress.includes(j.done)) progress.push(j.done);
    if (j && ["done", "failed", "cancelled"].includes(j.state)) break;
    await sleep(200);
  }
  const w = await mcp.call("jobs_wait", { job: jobId, timeoutMs: 600000 });
  assert(w.ok && w.data.result.state === "done", JSON.stringify(w.data).slice(0, 400));
  const checks = w.data.result.checks.map((c) => `${c.ok ? "✓" : "✗"}${c.name}`).join(" ");
  assert(w.data.result.checks.every((c) => c.ok), checks);
  lat.sort((a, b) => a - b);
  return `export done (${checks}); progress events seen at frames ${progress.slice(0, 6).join(", ")}…${progress.at(-1)}; ${lat.length} manual UI actions during the export: median ${lat[lat.length >> 1]} ms, worst ${lat.at(-1)} ms (input → screen updated, incl. DevTools round trip)`;
});

await step("retry: the same request id is applied once", async () => {
  const before = (await http("areas.list", {})).result.areas.length;
  const id = `retry-${Date.now()}`;
  const a = await http("areas.create", { kind: "custom", name: "Retry test", rect: { x: 40, y: 40, w: 60, h: 60 } }, id);
  const b = await http("areas.create", { kind: "custom", name: "Retry test", rect: { x: 40, y: 40, w: 60, h: 60 } }, id);
  const after = (await http("areas.list", {})).result.areas.length;
  assert(a.ok && b.ok && b.replayed === true && after === before + 1, JSON.stringify({ a: a.ok, b, before, after }).slice(0, 300));
  await http("history.undo", {});
  return `first call added the area; the retry returned the same result (replayed) — ${before} → ${after} areas`;
});

await step("conflict: a manual edit between read and write is detected", async () => {
  const content = (await mcp.call("content_list", { area: "Front window" })).data.result[0];
  const rev = (await mcp.call("project_get", {})).data.result.revision;
  // The person hides the content's layer by hand.
  await editor.click(`document.querySelector('button[aria-label="Hide Sample footage (generated, not AtmosFX) - swirl.mp4"], button[aria-label="Show Sample footage (generated, not AtmosFX) - swirl.mp4"]')`);
  await sleep(300);
  const c = await mcp.call("content_update", { id: content.id, settings: { opacity: 50 }, expectRevision: rev });
  assert(!c.ok && c.data.code === "conflict", JSON.stringify(c.data).slice(0, 300));
  const since = c.data.details.changesSince.map((x) => `${x.label} (${x.source})`).join(", ");
  const rev2 = (await mcp.call("project_get", {})).data.result.revision;
  const ok = await mcp.call("content_update", { id: content.id, settings: { opacity: 50 }, expectRevision: rev2 });
  assert(ok.ok, JSON.stringify(ok.data));
  await editor.click(`document.querySelector('button[aria-label="Hide Sample footage (generated, not AtmosFX) - swirl.mp4"], button[aria-label="Show Sample footage (generated, not AtmosFX) - swirl.mp4"]')`);
  return `refused with “conflict” (changes since: ${since}); after re-reading revision ${rev2} the same edit succeeded`;
});

await step("atomic: a failed transaction leaves no partial edit", async () => {
  const before = await mcp.call("project_get", {});
  const areasBefore = (await mcp.call("areas_list", {})).data.result.areas.length;
  const histBefore = (await mcp.call("history_list", {})).data.result.steps.length;
  const t = await mcp.call("transaction", { steps: [{ method: "areas.create", params: { kind: "window", name: "Ghost", rect: { x: 10, y: 10, w: 50, h: 50 } } }, { method: "content.assign", params: { asset: "no-such-file.mp4", areas: ["Ghost"] } }] });
  assert(!t.ok, "transaction should fail");
  const areasAfter = (await mcp.call("areas_list", {})).data.result.areas.length;
  const histAfter = (await mcp.call("history_list", {})).data.result.steps.length;
  assert(areasAfter === areasBefore && histAfter === histBefore, `areas ${areasBefore}→${areasAfter}, undo steps ${histBefore}→${histAfter}`);
  return `step 2 failed (${t.data.message.slice(0, 80)}…); areas ${areasBefore}→${areasAfter}, undo list ${histBefore}→${histAfter}; revision was ${before.data.result.revision}`;
});

await step("reconnect: MCP adapter restart and resumable event stream", async () => {
  mcp.close();
  sseAbort.abort();
  const seenBefore = lastSeq;
  // While disconnected, the person makes a change.
  try {
    await editor.click(`document.querySelector('button[aria-label="Hide Sample footage (generated, not AtmosFX) - swirl.mp4"], button[aria-label="Show Sample footage (generated, not AtmosFX) - swirl.mp4"]')`);
    await sleep(300);
  } finally {
    mcp = await McpClient.start(beAdapter());
  }
  const r = await mcp.call("project_get", {});
  assert(r.ok, "no answer after reconnect");
  await openEvents(seenBefore);
  await sleep(500);
  const missed = events.filter((e) => e.seq > seenBefore && e.type === "revision" && e.data.source === "user");
  assert(missed.length >= 1, "the change made while disconnected wasn't delivered after resuming");
  await editor.click(`document.querySelector('button[aria-label="Hide Sample footage (generated, not AtmosFX) - swirl.mp4"], button[aria-label="Show Sample footage (generated, not AtmosFX) - swirl.mp4"]')`);
  return `new adapter answered (revision ${r.data.result.revision}); resumed events after #${seenBefore} delivered the manual change made while disconnected (“${missed[0].data.label}”)`;
});

await step("reconnect: app closed and relaunched while the agent keeps running", async () => {
  await http("project.save", {});
  await editor.stopRecording(join(OUT, "agent-acceptance-part1.mp4"));
  editor.ws.close();
  app.kill();
  await sleep(2500);
  const down = await mcp.call("project_get", {});
  assert(!down.ok, "should fail while the app is closed");
  await launch();
  editor = await Editor.connect();
  await editor.record();
  await sleep(1500);
  const o = await mcp.call("project_open", { path: savedPath, discardChanges: true });
  assert(o.ok, JSON.stringify(o.data));
  const p = await mcp.call("project_get", {});
  const s3 = await mcp.call("scene3d_get", { scene: wallScene });
  assert(p.ok && s3.ok && s3.data.result.objects.find((x) => x.fracture)?.fracture.collapseAt === 1.5, "reopened show is different");
  return `while closed: “${String(down.data?.message ?? down.data).slice(0, 70)}…”; after relaunch the same adapter reconnected, reopened ${savedPath} (collapse at 1.5 s kept)`;
});

await editor.stopRecording(join(OUT, "agent-acceptance-part2.mp4"));
mcp.close();
sseAbort?.abort();
app.kill();
writeFileSync(join(OUT, "agent-acceptance-report.json"), JSON.stringify(report, null, 2));
log(`${report.ok ? "ALL PASSED" : "SOME FAILED"} — ${report.steps.filter((s) => s.ok).length}/${report.steps.length}; report ${join(OUT, "agent-acceptance-report.json")}`);
process.exit(report.ok ? 0 : 1);
