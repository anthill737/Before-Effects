/**
 * Desktop process: windows, files, background processes and the FFmpeg sidecar. All rendering
 * happens in renderer windows (WebGPU); this process moves finished pixels into encoders and
 * files onto disk.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { setProcessTracker } from "@be/media";
import "./profile.ts";
import { registerAvCheckIpc } from "./avcheck.ts";
import { registerDecodeIpc, stopAllDecoders } from "./decode.ts";
import { cancelAllEncodes, health, paths, registerFileIpc } from "./files.ts";
import { registerMediaImportIpc } from "./mediaImport.ts";
import { registerPreviewCacheIpc } from "./previewCache.ts";
import { registerAgentApi, shutdownAgentApi } from "./agentApi.ts";
import { registerHouseDetect, shutdownHouseDetect } from "./houseDetect.ts";
import { registerBlender, shutdownBlender } from "./blender.ts";
import { registerAssistantIpc, shutdownAssistant } from "./assistant.ts";
import { registerRenderQueue, shutdownRenders } from "./renderQueue.ts";
import { initLog, log } from "./log.ts";
import { stopAll, track } from "./processes.ts";
import { runUiTest } from "./uitest.ts";
import { closeSecondary, createEditor, editorWindow, registerWindowIpc } from "./windows.ts";

app.setName("Before Effects");
// Hybrid laptops: prefer the discrete GPU (here the RTX 5070 Ti) for rendering.
app.commandLine.appendSwitch("force_high_performance_gpu");

const mode: "studio" | "spike" | "uitest" = process.argv.includes("--spike") || process.env.BE_SPIKE === "1" ? "spike" : process.argv.includes("--ui-test") ? "uitest" : "studio";

initLog();

// Test hook: lets the launcher's failure handling be verified without breaking a real install.
if (process.env.BE_SIMULATE_STARTUP_FAILURE === "1") {
  log("FATAL simulated startup failure (BE_SIMULATE_STARTUP_FAILURE=1)");
  app.exit(3);
}

// Packaged builds carry their own FFmpeg in resources/bin.
const bundledFfmpeg = join(process.resourcesPath ?? "", "bin");
if (app.isPackaged && existsSync(join(bundledFfmpeg, "ffmpeg.exe"))) process.env.BE_FFMPEG_DIR = bundledFfmpeg;
setProcessTracker((name, proc) => track(name, proc));

// One studio at a time: a second launch brings the running window forward and exits quietly.
if (mode === "studio" && !app.requestSingleInstanceLock()) {
  log("another instance is running; handing over and exiting");
  app.exit(0);
}

app.on("second-instance", () => {
  const w = editorWindow();
  if (w) {
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }
});

let lastDialog = 0;
const fatal = (title: string, err: unknown) => {
  // A closed console (the terminal that started the app went away) isn't a problem for the app.
  if ((err as NodeJS.ErrnoException)?.code === "EPIPE") return;
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  log(`FATAL ${title}: ${msg}`);
  if (mode === "studio" && Date.now() - lastDialog > 10_000) {
    lastDialog = Date.now();
    dialog.showErrorBox(`Before Effects — ${title}`, `${msg.split("\n")[0]}\n\nDetails were written to:\n${join(app.getPath("userData"), "logs", "main.log")}`);
  }
};
process.on("uncaughtException", (e) => fatal("unexpected problem", e));
process.on("unhandledRejection", (e) => log(`unhandled rejection: ${String((e as Error)?.stack ?? e)}`));

registerFileIpc();
registerDecodeIpc();
registerMediaImportIpc();
registerPreviewCacheIpc();
registerAvCheckIpc();
registerWindowIpc(mode);
registerRenderQueue(mode);
registerAssistantIpc(mode);

ipcMain.handle("app:paths", () => paths());
ipcMain.handle("app:health", () => health());
// Measurements: the machine and each process's memory (working set, MB).
ipcMain.handle("app:metrics", () => ({
  cpu: cpus()[0]?.model.trim() ?? "unknown",
  threads: cpus().length,
  ramGB: Math.round(totalmem() / 1024 ** 3),
  processes: app.getAppMetrics().map((m) => ({ type: m.type, name: m.name ?? "", mb: Math.round(m.memory.workingSetSize / 1024), privateMb: Math.round((m.memory.privateBytes ?? 0) / 1024) })),
}));
ipcMain.on("app:log", (e, msg: string) => log(`[renderer ${e.sender.id}] ${msg}`));

ipcMain.handle("app:reportSpike", (_e, result: unknown) => {
  const out = join(paths().renders, "milestone-a", "spike-report.json");
  mkdirSync(join(out, ".."), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2));
  process.stdout.write(`\nSPIKE_REPORT ${JSON.stringify(result)}\n`);
  const ok = (result as { ok?: boolean }).ok === true;
  setTimeout(() => app.exit(ok ? 0 : 1), 100);
});

const shutdown = () => {
  cancelAllEncodes();
  stopAllDecoders();
  shutdownRenders();
  shutdownAssistant();
  shutdownAgentApi();
  shutdownHouseDetect();
  shutdownBlender();
  closeSecondary();
  stopAll();
};

app.whenReady().then(() => {
  log(`ready (mode ${mode}, packaged ${app.isPackaged}, ffmpeg ${health().ffmpeg.ok ? "ok" : "MISSING"})`);
  registerHouseDetect();
  registerBlender();
  const win = createEditor(mode);
  // The external-agent API starts with the app when it's enabled (Settings → Agent access).
  if (mode === "studio" || mode === "uitest") void registerAgentApi(mode);
  if (mode === "uitest") win.webContents.once("did-finish-load", () => void runUiTest(win, paths().renders));
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createEditor(mode);
  });
});

app.on("before-quit", shutdown);
app.on("window-all-closed", () => {
  shutdown();
  log("all windows closed; quitting");
  app.quit();
});
