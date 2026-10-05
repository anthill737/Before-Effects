/**
 * Windows: the editor, the pop-out preview, full-screen projector outputs, display identification
 * overlays, and hidden render workers. The editor is the source of truth: it publishes the project
 * and a shared playback clock, and this module relays them to every other window.
 */
import { join } from "node:path";
import { app, BrowserWindow, type Display, ipcMain, screen } from "electron";
import type { DisplayInfo, OutputConfig, OutputShowing, OutputStatus, SyncHello, TestPattern, TransportState, WindowKind } from "../shared/api.ts";
import { log } from "./log.ts";

let editor: BrowserWindow | null = null;
let preview: BrowserWindow | null = null;
/** The preview is full-screen on a projector (not a window of its own on the desktop). */
let previewOnProjector = false;
const outputs = new Map<string, { win: BrowserWindow; config: OutputConfig; showing?: { frame: number; fps: number; at: number }; patternShown?: { pattern: TestPattern; at: number } }>();
/** Outputs whose display was disconnected, by projector: reopened when a matching display returns. */
const waiting = new Map<string, { config: OutputConfig; label: string; size: { width: number; height: number } }>();
let latestProject: unknown = null;
let latestTransport: TransportState | null = null;
let previewView: string | null = null;

const preload = () => join(import.meta.dirname, "../preload/index.cjs");

const load = (win: BrowserWindow, kind: WindowKind, mode: string) => {
  const url = process.env.ELECTRON_RENDERER_URL;
  const hash = `${kind}`;
  if (url) void win.loadURL(`${url}#${hash}`);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"), { hash });
  win.webContents.on("console-message", (d) => {
    if (d.level === "error" || mode !== "studio") log(`[${kind}:${d.level}] ${d.message}`);
  });
  win.webContents.on("render-process-gone", (_e, d) => log(`[${kind}] renderer gone: ${d.reason} (exit ${d.exitCode})`));
  win.webContents.on("did-fail-load", (_e, code, desc) => log(`[${kind}] failed to load: ${code} ${desc}`));
};

export const webPrefs = (kind: WindowKind, mode: string, extra: Record<string, unknown> = {}) => ({
  preload: preload(),
  contextIsolation: true,
  sandbox: false,
  backgroundThrottling: kind === "render" || kind === "output" ? false : undefined,
  additionalArguments: [`--be-kind=${kind}`, `--be-mode=${mode}`],
  ...extra,
});

export const displayInfo = (): DisplayInfo[] => {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d: Display, i) => ({
    id: d.id,
    label: `${i + 1}: ${d.label || (d.internal ? "Built-in display" : "Display")} — ${Math.round(d.bounds.width * d.scaleFactor)}×${Math.round(d.bounds.height * d.scaleFactor)}`,
    primary: d.id === primary,
    internal: d.internal,
    pixels: { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) },
    scaleFactor: d.scaleFactor,
    refreshRate: d.displayFrequency,
    bounds: d.bounds,
  }));
};

const findDisplay = (id: number): Display => screen.getAllDisplays().find((d) => d.id === id) ?? screen.getPrimaryDisplay();

export const createEditor = (mode: "studio" | "spike" | "uitest"): BrowserWindow => {
  const kind: WindowKind = mode === "studio" ? "editor" : mode;
  const win = new BrowserWindow({
    width: 1680,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: "#0e1014",
    title: "Before Effects",
    // The menu bar (File, Edit, View, …) is always shown.
    autoHideMenuBar: false,
    webPreferences: webPrefs(kind, mode),
  });
  if (mode !== "spike") win.once("ready-to-show", () => win.show());
  // A file dropped outside a drop zone must never replace the editor with that file.
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("http://localhost") && !url.includes("index.html")) e.preventDefault();
  });
  load(win, kind, mode);
  win.on("closed", () => {
    editor = null;
    // Secondary windows belong to the editor; close them with it.
    preview?.close();
    for (const o of outputs.values()) o.win.close();
  });
  editor = win;
  return win;
};

export const editorWindow = () => editor;

const broadcastWindows = () => {
  editor?.webContents.send("windows:changed", { preview: !!preview, previewOnProjector: !!preview && previewOnProjector, outputs: outputStatus() });
};

const outputStatus = (): OutputStatus[] => [
  ...[...outputs.entries()].map(([projectorId, o]) => {
    const d = displayInfo().find((x) => x.id === o.config.displayId);
    return { projectorId, displayId: o.config.displayId, displayLabel: d?.label ?? "Display", displayPixels: d?.pixels ?? { width: 0, height: 0 }, open: !o.win.isDestroyed(), ...(o.showing ? { showing: o.showing } : {}), ...(o.patternShown ? { patternShown: o.patternShown } : {}) };
  }),
  ...[...waiting.entries()].filter(([id]) => !outputs.has(id)).map(([projectorId, w]) => ({ projectorId, displayId: w.config.displayId, displayLabel: w.label, displayPixels: w.size, open: false, waiting: true })),
];

export const registerWindowIpc = (mode: string) => {
  ipcMain.handle("displays:list", () => displayInfo());

  ipcMain.handle("displays:identify", async () => {
    // A big number on every display so people can tell which output is which.
    const wins = screen.getAllDisplays().map((d, i) => {
      const w = new BrowserWindow({
        x: d.bounds.x,
        y: d.bounds.y,
        width: d.bounds.width,
        height: d.bounds.height,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        focusable: false,
        skipTaskbar: true,
        webPreferences: webPrefs("identify", mode, { additionalArguments: ["--be-kind=identify", `--be-mode=${mode}`, `--be-display=${i + 1}`] }),
      });
      w.setIgnoreMouseEvents(true);
      load(w, "identify", mode);
      return w;
    });
    setTimeout(() => wins.forEach((w) => !w.isDestroyed() && w.close()), 4000);
  });

  ipcMain.handle("windows:openPreview", (_e, displayId?: number, onProjector = false) => {
    if (preview && !preview.isDestroyed()) {
      if (!onProjector && !previewOnProjector) {
        preview.focus();
        return;
      }
      // Moving the preview to (or between, or off) a projector: open it afresh there.
      preview.removeAllListeners("closed");
      preview.close();
      preview = null;
    }
    previewOnProjector = onProjector;
    if (onProjector) {
      // The preview panel itself, full-screen on the projector: just the picture and what you're
      // doing to it (outlines, selection), following the editor. Editing stays on the laptop.
      const d = findDisplay(displayId ?? screen.getPrimaryDisplay().id);
      const win = new BrowserWindow({
        x: d.bounds.x,
        y: d.bounds.y,
        width: d.bounds.width,
        height: d.bounds.height,
        frame: false,
        fullscreen: true,
        backgroundColor: "#000000",
        title: "Before Effects — Preview on the projector",
        webPreferences: webPrefs("preview", mode, { additionalArguments: ["--be-kind=preview", `--be-mode=${mode}`, "--be-clean=1"] }),
      });
      win.removeMenu();
      // Clicking it (pointing at the house) hands the keyboard straight back to the editor when
      // it's on another screen; on the only screen it keeps focus, so Esc closes it.
      win.on("focus", () => {
        const ed = editorWindow();
        if (ed && !ed.isDestroyed() && screen.getDisplayMatching(ed.getBounds()).id !== d.id) ed.focus();
      });
      load(win, "preview", mode);
      preview = win;
      win.on("closed", () => {
        if (preview === win) preview = null;
        broadcastWindows();
      });
      log(`preview opened on the projector: display ${d.id} (${d.bounds.width}×${d.bounds.height})`);
      broadcastWindows();
      return;
    }
    const others = screen.getAllDisplays().filter((d) => d.id !== screen.getDisplayMatching(editor?.getBounds() ?? screen.getPrimaryDisplay().bounds).id);
    const target = displayId !== undefined ? findDisplay(displayId) : others.sort((a, b) => b.size.width * b.size.height - a.size.width * a.size.height)[0];
    const area = (target ?? screen.getPrimaryDisplay()).workArea;
    preview = new BrowserWindow({
      x: area.x + 40,
      y: area.y + 40,
      width: Math.min(1280, area.width - 80),
      height: Math.min(800, area.height - 80),
      backgroundColor: "#08090c",
      title: "Before Effects — Preview",
      autoHideMenuBar: true,
      webPreferences: webPrefs("preview", mode),
    });
    preview.removeMenu();
    load(preview, "preview", mode);
    const win = preview;
    preview.on("closed", () => {
      if (preview === win) preview = null;
      broadcastWindows();
    });
    broadcastWindows();
  });

  ipcMain.handle("windows:closePreview", () => preview?.close());

  ipcMain.on("windows:previewView", (_e, view: string) => {
    previewView = view;
    preview?.webContents.send("sync:previewView", view);
  });

  ipcMain.handle("windows:openOutput", (_e, config: OutputConfig) => openOutput(config));

  ipcMain.on("output:frame", (e, info: Omit<OutputShowing, "at">) => {
    for (const o of outputs.values()) if (!o.win.isDestroyed() && o.win.webContents.id === e.sender.id) o.showing = { ...info, at: Date.now() };
  });
  ipcMain.on("output:pattern", (e, pattern: TestPattern) => {
    for (const o of outputs.values()) if (!o.win.isDestroyed() && o.win.webContents.id === e.sender.id) o.patternShown = { pattern, at: Date.now() };
  });

  // A projector's display unplugged: its output waits and reopens when the display comes back
  // (matched by id, else by name and size, since Windows may renumber it).
  // ("screen" exists only once the app is ready.)
  void app.whenReady().then(() => screen.on("display-removed", (_e, gone: Display) => {
    for (const [projectorId, o] of outputs) {
      if (o.config.displayId !== gone.id) continue;
      waiting.set(projectorId, { config: o.config, label: displayInfo().find((x) => x.id === gone.id)?.label ?? gone.label ?? "Display", size: { width: Math.round(gone.size.width * gone.scaleFactor), height: Math.round(gone.size.height * gone.scaleFactor) } });
      log(`projector output ${projectorId}: display ${gone.id} disconnected; waiting for it`);
      o.win.close();
    }
    broadcastWindows();
  }));
  void app.whenReady().then(() => screen.on("display-added", (_e, added: Display) => {
    for (const [projectorId, w] of waiting) {
      const sameSize = Math.round(added.size.width * added.scaleFactor) === w.size.width && Math.round(added.size.height * added.scaleFactor) === w.size.height;
      if (added.id !== w.config.displayId && !(sameSize && (added.label || "") === (w.label || ""))) continue;
      waiting.delete(projectorId);
      log(`projector output ${projectorId}: display back as ${added.id}; reopening`);
      openOutput({ ...w.config, displayId: added.id });
    }
    broadcastWindows();
  }));

  const openOutput = (config: OutputConfig): OutputStatus | undefined => {
    waiting.delete(config.projectorId);
    const d = findDisplay(config.displayId);
    const existing = outputs.get(config.projectorId);
    // Automated tests: a small window in the corner instead of taking over a screen (the picture
    // is still drawn at the projector's full size).
    const windowed = !!process.env.BE_TEST_OUTPUT_WINDOWED;
    const bounds = windowed ? { x: d.workArea.x + d.workArea.width - 336, y: d.workArea.y + d.workArea.height - 196, width: 320, height: 180 } : d.bounds;
    if (existing && !existing.win.isDestroyed()) {
      existing.config = config;
      existing.win.setBounds(bounds);
      if (!windowed) existing.win.setFullScreen(true);
      existing.win.webContents.send("sync:outputConfig", config);
      broadcastWindows();
      return outputStatus().find((o) => o.projectorId === config.projectorId);
    }
    const win = new BrowserWindow({
      ...bounds,
      frame: false,
      fullscreen: !windowed,
      backgroundColor: "#000000",
      autoHideMenuBar: true,
      title: "Before Effects — Projector output",
      // Keep projector feeds free of editor UI and focus stealing.
      skipTaskbar: false,
      webPreferences: webPrefs("output", mode),
    });
    win.removeMenu();
    // On its own screen, clicking the output (pointing at the house) hands the keyboard straight
    // back to the editor, so Space, undo and the rest keep working. (On the only screen it keeps
    // focus, so Esc closes it.)
    win.on("focus", () => {
      const ed = editorWindow();
      if (ed && !ed.isDestroyed() && screen.getDisplayMatching(ed.getBounds()).id !== d.id) ed.focus();
    });
    load(win, "output", mode);
    outputs.set(config.projectorId, { win, config });
    win.on("closed", () => {
      outputs.delete(config.projectorId);
      broadcastWindows();
    });
    log(`projector output ${config.projectorId} opened on display ${d.id} (${d.bounds.width}×${d.bounds.height} @${d.scaleFactor})`);
    broadcastWindows();
    return outputStatus().find((o) => o.projectorId === config.projectorId);
  };

  ipcMain.handle("windows:closeOutput", (_e, projectorId: string) => {
    // Closing on purpose also stops waiting for a disconnected display.
    waiting.delete(projectorId);
    outputs.get(projectorId)?.win.close();
    broadcastWindows();
  });

  ipcMain.handle("windows:setOutputPattern", (_e, projectorId: string, pattern: TestPattern) => {
    const o = outputs.get(projectorId);
    if (!o) return;
    o.config = { ...o.config, pattern };
    o.win.webContents.send("sync:outputConfig", o.config);
  });

  ipcMain.handle("windows:outputs", () => outputStatus());

  // ---- sync relay -------------------------------------------------------------------------
  ipcMain.on("sync:project", (e, project: unknown) => {
    latestProject = project;
    for (const w of secondary()) if (w.webContents.id !== e.sender.id) w.webContents.send("sync:project", project);
  });
  ipcMain.on("sync:transport", (e, t: TransportState) => {
    latestTransport = t;
    // To every other window: from the editor to its followers, and from a follower's own play/pause or
    // seek (the pop-out's keys) to the editor too, whose clock then leads.
    for (const w of [editor, ...secondary()]) if (w && !w.isDestroyed() && w.webContents.id !== e.sender.id) w.webContents.send("sync:transport", t);
  });
  ipcMain.handle("sync:hello", (e): SyncHello => {
    const out = [...outputs.values()].find((o) => o.win.webContents.id === e.sender.id);
    return { project: latestProject, transport: latestTransport, output: out?.config ?? null, previewView };
  });
};

const secondary = (): BrowserWindow[] => [preview, ...[...outputs.values()].map((o) => o.win)].filter((w): w is BrowserWindow => !!w && !w.isDestroyed());

export const closeSecondary = () => {
  for (const w of secondary()) w.close();
};
