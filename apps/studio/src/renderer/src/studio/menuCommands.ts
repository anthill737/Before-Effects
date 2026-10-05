/** What the menu bar's items do (main/menu.ts sends their commands to the editor window). */
import { enterFullScreen, togglePlay } from "../preview/PreviewPanel.tsx";
import { startPreparing, stopPreparing } from "../preview/prepare.ts";
import { type ResolutionChoice, usePreview } from "../preview/settings.ts";
import { useAssistant } from "./assistant/state.ts";
import { openPackageFromDrive, plainError, savePackageToDrive } from "./drive.ts";
import { importMediaFiles } from "./media.ts";
import { openProjectFile, saveProject } from "./persistence.ts";
import { type Step, useStudio } from "./store.ts";

const SHORTCUTS = [
  "Space — play / pause",
  "Home — back to start · ← → — a frame (Shift: 10)",
  "I / O — work area start / end · L — loop",
  "Ctrl+S — save · Ctrl+Shift+S — save as · Ctrl+O — open",
  "Ctrl+Z / Ctrl+Y — undo / redo · Ctrl+K — assistant",
  "Ctrl+1–4 — Areas, Content, Effects, Preview · Ctrl+E — export",
  "Ctrl+[ / Ctrl+] — left / right panel · ` — enlarge the preview · F11 — full screen",
];

const fail = (e: unknown) => useStudio.getState().toast({ kind: "error", text: plainError(e) });
const seconds = (f: number) => f / 705_600_000;

export const runMenuCommand = (command: string): void => {
  const s = useStudio.getState();
  const p = usePreview.getState();
  const inShow = s.screen === "studio" && !!s.project;
  const comp = s.project && s.compId ? s.project.compositions[s.compId] : undefined;
  const prepare = (range?: { startSeconds: number; endSeconds: number }) => void startPreparing({ target: "scene", raiseDiskLimit: true, ...(range ? { range } : {}) }).catch(fail);
  if (command.startsWith("step-") && inShow) return s.setStep(command.slice(5) as Step);
  if (command.startsWith("size-")) return p.set({ resolution: command.slice(5) as ResolutionChoice, autoFraction: 1 });
  switch (command) {
    case "new":
      if (s.dirty && !window.confirm("The show has unsaved changes (they're backed up). Start a new show anyway?")) return;
      useStudio.setState({ screen: "welcome" });
      return;
    case "open":
      return void openProjectFile().catch(fail);
    case "open-drive":
      return void openPackageFromDrive().catch(fail);
    case "save":
      return inShow ? void saveProject(false).catch(fail) : undefined;
    case "save-as":
      return inShow ? void saveProject(true).catch(fail) : undefined;
    case "save-package":
      return inShow ? void savePackageToDrive().then((r) => s.toast({ kind: "info", text: `Saved to Google Drive: ${r.folder}` }), fail) : undefined;
    case "import":
      return inShow ? void importMediaFiles().catch(fail) : undefined;
    case "export":
      return inShow ? s.setExportOpen(true) : undefined;
    case "renders":
      return useStudio.setState({ rendersOpen: !s.rendersOpen });
    case "drive":
      return useStudio.setState({ driveOpen: !s.driveOpen });
    case "agents":
      return useStudio.setState({ agentsOpen: !s.agentsOpen });
    case "assistant":
      return useAssistant.setState({ open: true });
    case "undo":
      return s.undo();
    case "redo":
      return s.redo();
    case "toggle-left":
      return p.set({ leftCollapsed: !p.leftCollapsed });
    case "toggle-right":
      return p.set({ rightCollapsed: !p.rightCollapsed });
    case "enlarge":
      return p.set({ maximized: !p.maximized });
    case "fullscreen":
      return enterFullScreen();
    case "play":
      return inShow ? togglePlay() : undefined;
    case "start":
      return s.restart();
    case "range-start":
      return comp ? s.setRange({ start: s.time, end: s.range?.end ?? comp.duration }) : undefined;
    case "range-end":
      return s.setRange({ start: s.range?.start ?? 0, end: s.time });
    case "range-clear":
      return s.setRange(null);
    case "loop":
      return s.setLoop(!s.loop);
    case "cache-before":
      p.set({ playbackMode: p.playbackMode === "cache" ? "realtime" : "cache" });
      return s.toast({ kind: "info", text: `Cache before playback: ${usePreview.getState().playbackMode === "cache" ? "on" : "off"}` });
    case "idle-cache":
      p.set({ idleCache: !p.idleCache });
      return s.toast({ kind: "info", text: `Cache frames when idle: ${usePreview.getState().idleCache ? "on" : "off"}` });
    case "prepare-workarea":
      if (!s.range) return s.toast({ kind: "info", text: "Set a work area first (I and O, or Range start / end)." });
      return prepare({ startSeconds: seconds(s.range.start), endSeconds: seconds(s.range.end) });
    case "prepare-around":
      return comp ? prepare({ startSeconds: Math.max(0, seconds(s.time) - p.aroundBefore), endSeconds: Math.min(seconds(comp.duration), seconds(s.time) + p.aroundAfter) }) : undefined;
    case "prepare-scene":
      return comp ? prepare() : undefined;
    case "prepare-show":
      return void startPreparing({ target: "show", raiseDiskLimit: true }).catch(fail);
    case "prepare-stop":
      return stopPreparing();
    case "shortcuts":
      return s.toast({ kind: "info", text: SHORTCUTS.join("\n") });
  }
};
