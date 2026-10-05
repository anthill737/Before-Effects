/**
 * The editor's menu bar: File, Edit, View, Playback, Tools, Help — where saving, opening, importing,
 * exporting and the panels live, as in other apps of this kind. Each item sends a command to the
 * editor window (renderer/src/studio/menuCommands.ts). Shortcuts the editor already handles itself
 * are shown here but not registered twice.
 */
import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions, shell } from "electron";
import { logDir } from "./log.ts";
import { editorWindow } from "./windows.ts";

const send = (command: string) => {
  const win = editorWindow() ?? BrowserWindow.getFocusedWindow();
  win?.webContents.send("menu:command", command);
};

/** A command; `shown`: a shortcut the editor handles itself (listed, not registered again). */
const cmd = (label: string, command: string, shortcut?: string, shown = false): MenuItemConstructorOptions => ({
  label,
  ...(shortcut ? { accelerator: shortcut, registerAccelerator: !shown } : {}),
  click: () => send(command),
});
const sep: MenuItemConstructorOptions = { type: "separator" };

export const setAppMenu = () => {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "&File",
      submenu: [
        cmd("New show from a photo…", "new"),
        cmd("Open…", "open", "Ctrl+O", true),
        cmd("Open from Google Drive…", "open-drive"),
        sep,
        cmd("Save", "save", "Ctrl+S", true),
        cmd("Save As…", "save-as", "Ctrl+Shift+S", true),
        cmd("Save a package to Google Drive (show and its media)", "save-package"),
        sep,
        cmd("Import media…", "import", "Ctrl+I"),
        cmd("Export…", "export", "Ctrl+E"),
        cmd("Renders (exports in the background)", "renders"),
        sep,
        cmd("Google Drive…", "drive"),
        sep,
        { label: "Exit", role: "quit" },
      ],
    },
    {
      label: "&Edit",
      submenu: [
        cmd("Undo", "undo", "Ctrl+Z", true),
        cmd("Redo", "redo", "Ctrl+Y", true),
        sep,
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "&View",
      submenu: [
        cmd("Areas", "step-space", "Ctrl+1"),
        cmd("Content", "step-content", "Ctrl+2"),
        cmd("Effects", "step-animate", "Ctrl+3"),
        cmd("Preview", "step-preview", "Ctrl+4"),
        sep,
        cmd("Show or hide the left panel", "toggle-left", "Ctrl+["),
        cmd("Show or hide the right panel", "toggle-right", "Ctrl+]"),
        cmd("Enlarge the preview", "enlarge", "`", true),
        cmd("Preview full screen", "fullscreen", "F11"),
        sep,
        {
          label: "Preview size",
          submenu: [cmd("Auto", "size-auto"), cmd("Full", "size-full"), cmd("Half", "size-half"), cmd("Quarter", "size-quarter"), cmd("Eighth", "size-eighth")],
        },
        sep,
        { label: "Bigger text and buttons", role: "zoomIn" },
        { label: "Smaller text and buttons", role: "zoomOut" },
        { label: "Normal size", role: "resetZoom" },
      ],
    },
    {
      label: "&Playback",
      submenu: [
        cmd("Play / Pause", "play", "Space", true),
        cmd("Back to start", "start", "Home", true),
        sep,
        cmd("Work area start here", "range-start", "I", true),
        cmd("Work area end here", "range-end", "O", true),
        cmd("Whole scene (no work area)", "range-clear"),
        cmd("Loop", "loop", "L", true),
        sep,
        cmd("Cache before playback (on / off)", "cache-before"),
        cmd("Cache frames when idle (on / off)", "idle-cache"),
        sep,
        cmd("Prepare the work area", "prepare-workarea"),
        cmd("Prepare around the playhead", "prepare-around"),
        cmd("Prepare this scene", "prepare-scene"),
        cmd("Prepare the whole show", "prepare-show"),
        cmd("Stop preparing", "prepare-stop"),
      ],
    },
    {
      label: "&Tools",
      submenu: [cmd("Assistant", "assistant", "Ctrl+K", true), cmd("Agent access…", "agents")],
    },
    {
      label: "&Help",
      submenu: [
        cmd("Keyboard shortcuts", "shortcuts"),
        { label: "Open the logs folder", click: () => void shell.openPath(logDir()) },
        sep,
        {
          label: "About Before Effects",
          click: () => {
            const win = editorWindow() ?? BrowserWindow.getFocusedWindow();
            const text = `Before Effects ${app.getVersion()}\nElectron ${process.versions.electron}`;
            if (win) void dialog.showMessageBox(win, { type: "info", title: "About Before Effects", message: "Before Effects", detail: text });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};
