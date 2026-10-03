/**
 * Running Blender for Before Effects: finding it, building a .blend from an exchange file,
 * baking and rendering it in the background (progress, cancel, errors), turning the frames into a
 * video with transparency, and opening a .blend in Blender's own window for editing.
 *
 * Blender is found at the path chosen in Before Effects, else a portable copy in the data folder's
 * Tools folder, else Program Files, Steam or PATH.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findFfmpeg } from "@be/media";
import { app, BrowserWindow, dialog, ipcMain, type WebContents } from "electron";
import { paths } from "./files.ts";
import { log } from "./log.ts";

const settingsFile = () => join(app.getPath("userData"), "blender.json");
const readSettings = (): { path?: string } => {
  try {
    return JSON.parse(readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
};

const candidates = (): string[] => {
  const out: string[] = [];
  const chosen = readSettings().path;
  if (chosen) out.push(chosen);
  const tools = join(dirname(paths().renders), "Tools");
  if (existsSync(tools))
    for (const d of readdirSync(tools).filter((n) => /^blender/i.test(n)).sort().reverse()) out.push(join(tools, d, "blender.exe"));
  for (const root of ["C:\\Program Files\\Blender Foundation", "C:\\Program Files (x86)\\Steam\\steamapps\\common"]) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root).filter((n) => /blender/i.test(n)).sort().reverse()) out.push(join(root, d, "blender.exe"));
  }
  for (const dir of (process.env.PATH ?? "").split(";")) if (dir) out.push(join(dir, "blender.exe"));
  return out;
};

let found: { path: string; version: string } | null | undefined;
export const findBlender = (refresh = false): { path: string; version: string } | null => {
  if (found !== undefined && !refresh) return found;
  found = null;
  for (const p of candidates()) {
    if (!existsSync(p)) continue;
    const r = spawnSync(p, ["--version"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
    const m = /Blender\s+(\d+\.\d+(?:\.\d+)?)/.exec(r.stdout ?? "");
    if (m) {
      found = { path: p, version: m[1]! };
      break;
    }
  }
  return found;
};

/** The bridge script that runs inside Blender. */
const scriptPath = () => (app.isPackaged ? join(process.resourcesPath, "blender", "be_blender.py") : join(app.getAppPath(), "resources", "blender", "be_blender.py"));

const running = new Map<string, ChildProcess>();

export interface BlenderProgress {
  jobId: string;
  stage: string;
  done: number;
  total: number;
}

/** Run the bridge script in a background Blender; progress is reported per line. */
const runBlender = (jobId: string, args: string[], onProgress: (p: BlenderProgress) => void): Promise<{ ok: true } | { ok: false; code: string; message: string }> =>
  new Promise((resolve) => {
    const b = findBlender();
    if (!b) return resolve({ ok: false, code: "no_blender", message: "Blender wasn't found. Install it (blender.org) or choose blender.exe in Before Effects." });
    const child = spawn(b.path, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    running.set(jobId, child);
    let error = "";
    let tail = "";
    let buf = "";
    const onData = (d: Buffer) => {
      buf += String(d);
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        tail = (tail + line + "\n").slice(-3000);
        const m = /^BE_PROGRESS (\w+) (\d+) (\d+)/.exec(line);
        if (m) onProgress({ jobId, stage: m[1]!, done: Number(m[2]), total: Number(m[3]) });
        const e = /^BE_ERROR (.*)$/.exec(line);
        if (e) error = e[1]!;
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (d) => (tail = (tail + String(d)).slice(-3000)));
    child.on("exit", (code, signal) => {
      running.delete(jobId);
      if (signal || code === null) return resolve({ ok: false, code: "cancelled", message: "Cancelled." });
      if (code === 0 && !error) return resolve({ ok: true });
      log(`blender ${jobId} failed (${code}): ${tail.slice(-1500)}`);
      resolve({ ok: false, code: "failed", message: error || `Blender stopped with an error (exit ${code}). ${tail.trim().split("\n").pop() ?? ""}` });
    });
  });

/** Frames (f_0001.png …) to a ProRes 4444 video with transparency. */
const framesToVideo = async (framesDir: string, fps: number, out: string): Promise<void> => {
  const { ffmpeg } = await findFfmpeg();
  await new Promise<void>((resolve, reject) => {
    const p = spawn(ffmpeg, ["-y", "-loglevel", "error", "-framerate", String(fps), "-start_number", "1", "-i", join(framesDir, "f_%04d.png"), "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-alpha_bits", "16", out], { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => (err += String(d)));
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`Couldn't make the video from Blender's frames: ${err.slice(-400)}`))));
  });
};

export interface BlenderRunSpec {
  /** "build" makes the .blend from the exchange then renders; "render" re-renders an existing .blend (keeping edits made in Blender). */
  mode: "build" | "render";
  /** The exchange (Before Effects' JSON) — for render, at least fps, frames, render size and output. */
  exchange: { fps: number; frames: number; output: { blend: string; frames: string; cache: string } } & Record<string, unknown>;
  /** Where to write the finished video. */
  video: string;
}

export const runBlenderJob = async (jobId: string, spec: BlenderRunSpec, onProgress: (p: BlenderProgress) => void) => {
  const x = spec.exchange;
  mkdirSync(dirname(x.output.blend), { recursive: true });
  const exchangeFile = join(dirname(x.output.blend), "exchange.json");
  writeFileSync(exchangeFile, JSON.stringify(x, null, 1));
  if (spec.mode === "build") {
    onProgress({ jobId, stage: "build", done: 0, total: 1 });
    const r = await runBlender(jobId, ["-b", "--factory-startup", "-P", scriptPath(), "--", "build", exchangeFile], onProgress);
    if (!r.ok) return r;
  }
  if (!existsSync(x.output.blend)) return { ok: false as const, code: "missing", message: `The Blender file is missing: ${x.output.blend}` };
  // A fresh render: old frames and baked cache go.
  rmSync(x.output.frames, { recursive: true, force: true });
  rmSync(x.output.cache, { recursive: true, force: true });
  const r = await runBlender(jobId, ["-b", x.output.blend, "-P", scriptPath(), "--", "render", exchangeFile], onProgress);
  if (!r.ok) return r;
  onProgress({ jobId, stage: "video", done: 0, total: 1 });
  try {
    await framesToVideo(x.output.frames, x.fps, spec.video);
  } catch (e) {
    return { ok: false as const, code: "failed", message: String((e as Error).message) };
  }
  onProgress({ jobId, stage: "video", done: 1, total: 1 });
  return { ok: true as const, video: spec.video, blendMtime: statSync(x.output.blend).mtimeMs };
};

export const registerBlender = () => {
  ipcMain.handle("blender:status", (_e, refresh?: boolean) => {
    const b = findBlender(!!refresh);
    return { found: !!b, path: b?.path ?? null, version: b?.version ?? null, running: [...running.keys()] };
  });
  ipcMain.handle("blender:choose", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win!, { title: "Choose blender.exe", filters: [{ name: "Blender", extensions: ["exe"] }], properties: ["openFile"] });
    if (r.canceled || !r.filePaths[0]) return null;
    writeFileSync(settingsFile(), JSON.stringify({ path: r.filePaths[0] }));
    return findBlender(true);
  });
  ipcMain.handle("blender:run", async (e, jobId: string, spec: BlenderRunSpec) => {
    const sender: WebContents = e.sender;
    log(`blender ${jobId}: ${spec.mode} ${spec.exchange.output.blend}`);
    const t0 = Date.now();
    const r = await runBlenderJob(jobId, spec, (p) => !sender.isDestroyed() && sender.send("blender:progress", p));
    log(`blender ${jobId}: ${r.ok ? "done" : `failed: ${r.message}`} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return r;
  });
  ipcMain.handle("blender:cancel", (_e, jobId: string) => {
    const c = running.get(jobId);
    if (!c) return false;
    c.kill();
    return true;
  });
  /** Open a .blend in Blender's own window (for editing; Before Effects re-renders it on Update). */
  ipcMain.handle("blender:open", (_e, blend: string) => {
    const b = findBlender();
    if (!b) return { ok: false, message: "Blender wasn't found." };
    spawn(b.path, [blend], { detached: true, stdio: "ignore" }).unref();
    return { ok: true };
  });
  ipcMain.handle("blender:mtime", (_e, file: string) => (existsSync(file) ? statSync(file).mtimeMs : null));
  ipcMain.handle("blender:chooseBlend", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win!, { title: "Link a Blender file", filters: [{ name: "Blender files", extensions: ["blend"] }], properties: ["openFile"] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
};

export const shutdownBlender = () => {
  for (const c of running.values()) c.kill();
  running.clear();
};
