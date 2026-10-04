/**
 * Runs house detection (detect-host.js) as a separate process and relays its progress. One run
 * at a time per request id; cancelling ends the process. Models live in the data folder's
 * Models\hf-cache (or BE_MODELS_DIR), downloaded once with the person's consent.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HouseDetection } from "@be/core";
import { ipcMain, type WebContents } from "electron";
import { DETECT_MODELS, modelsMissing } from "./detect-models.ts";
import { paths } from "./files.ts";
import { log } from "./log.ts";

export const modelsDir = () => process.env.BE_MODELS_DIR ?? join(dirname(paths().renders), "Models", "hf-cache");

const runs = new Map<string, ChildProcess>();
const hostScript = () => join(__dirname, "detect-host.js").replace(`app.asar${"\\"}`, `app.asar.unpacked${"\\"}`);

export interface DetectProgress {
  requestId: string;
  stage: string;
  fraction: number;
  text: string;
}

/** Remove pieces of downloads that were stopped part-way (complete files are renamed into place). */
const cleanPartialDownloads = () => {
  for (const m of DETECT_MODELS) {
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (/\.tmp\.[\w.]+$/.test(e.name)) rmSync(join(dir, e.name), { force: true });
      }
    };
    walk(join(modelsDir(), m.id));
  }
};

/**
 * On the graphics card, a run that says nothing for this long has stalled (it waits for memory the
 * card doesn't have — e.g. while the editor's frame caches fill it — instead of failing).
 */
const GPU_STALL_MS = 45_000;

/**
 * Run detection on a canvas-sized image; progress goes to `onProgress`. Rejects with code
 * "needs-download" or "cancelled". A run on the graphics card that stalls starts again on the
 * processor (slower, but it finishes).
 */
export const detectHouse = (requestId: string, image: string, opts: { allowDownload: boolean; device?: "gpu" | "cpu" }, onProgress: (p: DetectProgress) => void): Promise<HouseDetection> =>
  new Promise((resolve, reject) => {
    if (!runs.size) cleanPartialDownloads();
    let settled = false;
    const finish = (f: () => void) => {
      if (settled) return;
      settled = true;
      runs.delete(requestId);
      f();
    };
    const attempt = (device: "gpu" | "cpu" | undefined) => {
      const child = spawn(process.execPath, [hostScript()], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
      runs.set(requestId, child);
      let stderr = "";
      let lastHeard = Date.now();
      let retried = false;
      const watchdog = setInterval(() => {
        if (settled || retried || device === "cpu" || Date.now() - lastHeard < GPU_STALL_MS) return;
        retried = true;
        clearInterval(watchdog);
        log(`house detection ${requestId}: nothing from the graphics card for ${GPU_STALL_MS / 1000} s; starting again on the processor`);
        onProgress({ requestId, stage: "load", fraction: 0.02, text: "The graphics card is busy: finding the parts with the processor instead (slower)" });
        child.kill();
        attempt("cpu");
      }, 1000);
      child.stderr?.on("data", (d) => (stderr = (stderr + String(d)).slice(-4000)));
      child.stdout?.on("data", () => {});
      child.on("message", (m: { type: string; stage?: string; fraction?: number; text?: string; detection?: HouseDetection; message?: string; code?: string }) => {
        lastHeard = Date.now();
        if (retried) return;
        if (m.type === "ready") child.send({ type: "run", image, cacheDir: modelsDir(), allowDownload: opts.allowDownload, ...(device ? { device } : {}) });
        else if (m.type === "progress") onProgress({ requestId, stage: m.stage!, fraction: m.fraction!, text: m.text! });
        else if (m.type === "result") finish(() => resolve(m.detection!));
        else if (m.type === "error") finish(() => reject(Object.assign(new Error(m.message), { code: m.code })));
      });
      child.on("exit", (code, signal) => {
        clearInterval(watchdog);
        if (retried) return;
        finish(() => {
          if (signal === "SIGTERM" || code === null) reject(Object.assign(new Error("Cancelled."), { code: "cancelled" }));
          else {
            log(`house detection exited (${code}): ${stderr.slice(-1500)}`);
            reject(new Error(`House detection stopped unexpectedly (exit ${code}). ${stderr.trim().split("\n").pop() ?? ""}`));
          }
        });
      });
    };
    attempt(opts.device);
  });

export const cancelDetect = (requestId: string) => {
  const c = runs.get(requestId);
  if (!c) return false;
  c.kill();
  return true;
};

export const detectStatus = () => {
  const dir = modelsDir();
  const missing = new Set(modelsMissing(dir).map((m) => m.id));
  return {
    modelsDir: dir,
    models: DETECT_MODELS.map((m) => ({ id: m.id, role: m.role, license: m.license, sizeMB: m.sizeMB, present: !missing.has(m.id) })),
    downloadMB: DETECT_MODELS.filter((m) => missing.has(m.id)).reduce((a, m) => a + m.sizeMB, 0),
    running: [...runs.keys()],
  };
};

export const registerHouseDetect = () => {
  ipcMain.handle("detect:status", () => detectStatus());
  ipcMain.handle("detect:run", async (e, requestId: string, image: string, opts: { allowDownload: boolean; device?: "gpu" | "cpu" }) => {
    const sender: WebContents = e.sender;
    log(`house detection ${requestId} on ${image}`);
    try {
      const r = await detectHouse(requestId, image, opts, (p) => !sender.isDestroyed() && sender.send("detect:progress", p));
      log(`house detection ${requestId}: ${r.proposals.length} proposals in ${r.seconds.toFixed(1)} s on the ${r.device}`);
      return { ok: true as const, detection: r };
    } catch (err) {
      const x = err as Error & { code?: string };
      return { ok: false as const, code: x.code ?? "failed", message: x.message };
    }
  });
  ipcMain.handle("detect:cancel", (_e, requestId: string) => cancelDetect(requestId));
};

export const shutdownHouseDetect = () => {
  for (const c of runs.values()) c.kill();
  runs.clear();
};
