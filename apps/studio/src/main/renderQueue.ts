/**
 * Background rendering. Exports are jobs in a queue, rendered one at a time by a hidden worker
 * window (its own GPU device). Each job carries an immutable snapshot of the show, so editing
 * continues while it renders and later edits never change a job already queued.
 *
 * Jobs report progress, can be cancelled and retried, check disk space first, are verified when
 * done, and are kept in an export history. Delivery to Google Drive copies the finished file into
 * Before Effects' Exports folder in the Drive-for-desktop folder (drive.ts); a failed copy can be
 * retried without rendering again.
 */
import { statfs } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import type { RenderJob, RenderJobSpec } from "../shared/api.ts";
import { DRIVE_UPLOAD_NOTE } from "../shared/drive.ts";
import { copyVerified, driveTarget, myDrive, setTestMyDrive } from "./drive.ts";
import { paths } from "./files.ts";
import { log } from "./log.ts";
import { webPrefs } from "./windows.ts";

const jobs: RenderJob[] = [];
let worker: BrowserWindow | null = null;
let workerReady = false;
let current: string | null = null;
let counter = 0;
let modeArg = "studio";

const historyFile = () => join(app.getPath("userData"), "render-history.json");

const save = () => {
  try {
    const keep = jobs.filter((j) => j.state === "done" || j.state === "failed" || j.state === "cancelled").slice(-200).map(({ snapshot: _s, ...rest }) => rest);
    writeFileSync(historyFile(), JSON.stringify(keep, null, 2));
  } catch (e) {
    log(`render history not saved: ${String(e)}`);
  }
};

const load = () => {
  try {
    if (!existsSync(historyFile())) return;
    for (const j of JSON.parse(readFileSync(historyFile(), "utf8")) as RenderJob[]) jobs.push({ ...j, snapshot: "" });
  } catch {
    /* history is a convenience */
  }
};

const queueListeners = new Set<(list: RenderJob[]) => void>();
/** Notified on every queue change (the agent API streams job progress from here). */
export const onQueueChange = (fn: (list: RenderJob[]) => void): (() => void) => {
  queueListeners.add(fn);
  return () => queueListeners.delete(fn);
};

const broadcast = () => {
  const list = jobs.map(({ snapshot: _s, ...rest }) => rest);
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w !== worker) w.webContents.send("render:update", list);
  for (const fn of queueListeners) fn(list as RenderJob[]);
};

const update = (id: string, changes: Partial<RenderJob>) => {
  const j = jobs.find((x) => x.id === id);
  if (!j) return;
  Object.assign(j, changes);
  broadcast();
  if (changes.state && changes.state !== "rendering") save();
};

const ensureWorker = () => {
  if (worker && !worker.isDestroyed()) return worker;
  workerReady = false;
  worker = new BrowserWindow({ show: false, width: 640, height: 360, webPreferences: webPrefs("render", modeArg) });
  const url = process.env.ELECTRON_RENDERER_URL;
  if (url) void worker.loadURL(`${url}#render`);
  else void worker.loadFile(join(import.meta.dirname, "../renderer/index.html"), { hash: "render" });
  worker.webContents.on("console-message", (d) => {
    if (d.level === "error" || d.level === "warning") log(`[render:${d.level}] ${d.message}`);
  });
  worker.webContents.on("render-process-gone", (_e, d) => {
    log(`render worker gone: ${d.reason}`);
    if (current) update(current, { state: "failed", error: "The renderer stopped unexpectedly. Try again; if it keeps happening, lower the export size." });
    current = null;
    worker = null;
    pump();
  });
  worker.on("closed", () => {
    worker = null;
    workerReady = false;
  });
  return worker;
};

/** Free space on the drive holding `path`, in bytes (null when unknown). */
const freeBytes = async (path: string): Promise<number | null> => {
  try {
    let dir = dirname(path);
    while (!existsSync(dir) && dir !== dirname(dir)) dir = dirname(dir);
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
};

const pump = () => {
  if (current) return;
  const next = jobs.find((j) => j.state === "queued");
  if (!next) return;
  const w = ensureWorker();
  // The worker announces itself ("render:ready") once its job handler is listening.
  if (!workerReady) return;
  current = next.id;
  update(next.id, { state: "rendering", startedAt: new Date().toISOString(), phase: "Starting" });
  w.webContents.send("render:job", next);
};

/**
 * Copy a finished export into Google Drive (Before Effects' Exports folder, or `folder` in My Drive).
 * "Copied" means the whole file is in the Drive folder; Drive for desktop uploads it afterwards and
 * Before Effects can't see when that's done, so the delivery says so. A failure leaves the export
 * where it is, ready to try again.
 */
const deliver = async (id: string, folder?: string): Promise<string> => {
  const j = jobs.find((x) => x.id === id);
  if (!j || j.state !== "done" || !j.result) throw new Error("Only finished exports can be sent to Google Drive.");
  const drive = myDrive();
  let target = j.result;
  try {
    if (!drive) throw Object.assign(new Error("no drive"), { code: "NODRIVE" });
    target = await driveTarget(j.result, "exports", folder ? { folder } : {});
    update(id, { delivery: { state: "copying", target } });
    await copyVerified(j.result, target);
    update(id, { delivery: { state: "copied", target, at: new Date().toISOString(), confirmed: false, note: DRIVE_UPLOAD_NOTE } });
    log(`copied ${j.result} → ${target} (Drive for desktop uploads it in the background)`);
    return target;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const why =
      code === "NODRIVE"
        ? "Google Drive for desktop isn't installed or signed in, so there's no Drive folder to copy into (install it from google.com/drive/download)"
        : code === "ENOENT" || code === "ENOTDIR"
          ? `the Google Drive folder (${drive}) isn't reachable. Check that Google Drive for desktop is running and signed in`
          : code === "ENOSPC"
            ? "there isn't enough space for the copy on the Drive folder's disk"
            : code === "EACCES" || code === "EPERM" || code === "EBUSY"
              ? "Windows wouldn't allow the copy (the file may be open in another program)"
              : String((e as Error).message ?? e);
    log(`drive copy failed for ${j.result}: ${String((e as Error).message ?? e)}`);
    update(id, { delivery: { state: "failed", target, error: why } });
    throw new Error(`Couldn't copy to Google Drive: ${why}. Your exported file is safe, so you can try again without exporting again.`);
  }
};

/** Videos still being written are named "….partial" until they're complete; any left at start-up were cut off. */
const tidyPartials = () => {
  try {
    const dir = paths().renders;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".partial")) continue;
      unlinkSync(join(dir, f));
      log(`removed an export that was cut off: ${f}`);
    }
  } catch {
    /* tidying is a convenience */
  }
};

export const registerRenderQueue = (mode: string) => {
  modeArg = mode;
  load();
  tidyPartials();

  ipcMain.handle("render:enqueue", async (_e, spec: RenderJobSpec) => {
    const free = await freeBytes(spec.output);
    if (free !== null && free < spec.estimatedBytes * 1.2 + 200 * 1024 * 1024) {
      throw new Error(`There isn't enough free space on that drive (needs about ${Math.ceil((spec.estimatedBytes * 1.2) / 1e9)} GB, has ${(free / 1e9).toFixed(1)} GB). Choose another folder or free some space.`);
    }
    const job: RenderJob = { ...spec, id: `job${Date.now().toString(36)}${++counter}`, state: "queued", createdAt: new Date().toISOString(), done: 0, phase: "Waiting" };
    jobs.push(job);
    log(`render job ${job.id} queued: ${job.name} → ${job.output}`);
    broadcast();
    pump();
    return job.id;
  });

  ipcMain.handle("render:list", () => jobs.map(({ snapshot: _s, ...rest }) => rest));

  ipcMain.handle("render:cancel", (_e, id: string) => {
    const j = jobs.find((x) => x.id === id);
    if (!j) return;
    if (j.state === "queued") update(id, { state: "cancelled", phase: "Cancelled" });
    if (j.state === "rendering") worker?.webContents.send("render:cancel", id);
  });

  ipcMain.handle("render:retry", (_e, id: string) => {
    const j = jobs.find((x) => x.id === id);
    if (!j || !j.snapshot) throw new Error("This render can't be retried after restarting Before Effects. Export it again from the show.");
    const copy: RenderJob = { ...j, id: `job${Date.now().toString(36)}${++counter}`, state: "queued", createdAt: new Date().toISOString(), done: 0, phase: "Waiting", error: undefined, verify: undefined, finishedAt: undefined, startedAt: undefined };
    jobs.push(copy);
    broadcast();
    pump();
    return copy.id;
  });

  ipcMain.handle("render:clearFinished", () => {
    for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i]!.state !== "queued" && jobs[i]!.state !== "rendering") jobs.splice(i, 1);
    save();
    broadcast();
  });

  // ---- worker side ----
  ipcMain.on("render:ready", () => {
    workerReady = true;
    pump();
  });
  ipcMain.on("render:progress", (_e, id: string, p: Partial<RenderJob>) => update(id, p));
  ipcMain.on("render:finished", (_e, id: string, p: Partial<RenderJob>) => {
    update(id, { ...p, finishedAt: new Date().toISOString() });
    log(`render job ${id} ${p.state}${p.error ? `: ${p.error}` : ""}`);
    current = null;
    pump();
    // Asked to go to Drive: copy it now the export is finished (a failure shows on the job, to retry).
    if (p.state === "done" && jobs.find((x) => x.id === id)?.sendToDrive) void deliver(id).catch(() => undefined);
  });

  // ---- delivery ----
  ipcMain.handle("deliver:driveFolder", () => myDrive());
  // Test hook (journey tests only): point Drive at a chosen folder to exercise failure and retry.
  ipcMain.handle("deliver:testFolder", (_e, p: string | null) => {
    if (modeArg === "uitest") setTestMyDrive(p);
  });
  ipcMain.handle("deliver:copyToDrive", (_e, id: string, folder?: string) => deliver(id, folder));
};

export const shutdownRenders = () => {
  worker?.destroy();
  worker = null;
};

