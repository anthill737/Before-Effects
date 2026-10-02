import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { AssistantToolCall, BeApi, WindowKind } from "../shared/api.ts";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const kind = (arg("be-kind") ?? "editor") as WindowKind;
const mode = (arg("be-mode") ?? "studio") as BeApi["app"]["mode"];

const on = <T>(channel: string, cb: (v: T) => void): (() => void) => {
  const h = (_e: IpcRendererEvent, v: T) => cb(v);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

const api: BeApi = {
  encode: {
    start: (spec) => ipcRenderer.invoke("encode:start", spec),
    frame: (id, data) => ipcRenderer.invoke("encode:frame", id, data),
    finish: (id) => ipcRenderer.invoke("encode:finish", id),
    cancel: (id) => ipcRenderer.invoke("encode:cancel", id),
  },
  media: {
    presets: () => ipcRenderer.invoke("media:presets"),
    probe: (path) => ipcRenderer.invoke("media:probe", path),
    verify: (path, expect) => ipcRenderer.invoke("media:verify", path, expect),
    import: (src, projectId) => ipcRenderer.invoke("media:import", src, projectId),
    measureAv: (path) => ipcRenderer.invoke("media:measureAv", path),
    decodeFrame: (path, frame, fps, width, srcW, srcH) => ipcRenderer.invoke("media:decodeFrame", path, frame, fps, width, srcW, srcH),
  },
  files: {
    saveProject: (json, path) => ipcRenderer.invoke("files:saveProject", json, path),
    openProject: (path) => ipcRenderer.invoke("files:openProject", path),
    autosave: (json) => ipcRenderer.invoke("files:autosave", json),
    recoverAutosave: () => ipcRenderer.invoke("files:recoverAutosave"),
    clearAutosave: () => ipcRenderer.invoke("files:clearAutosave"),
    showInFolder: (path) => ipcRenderer.invoke("files:showInFolder", path),
    openPath: (path) => ipcRenderer.invoke("files:openPath", path),
    chooseImage: () => ipcRenderer.invoke("files:chooseImage"),
    chooseFiles: (k) => ipcRenderer.invoke("files:chooseFiles", k),
    importAsset: (src, projectId) => ipcRenderer.invoke("files:importAsset", src, projectId),
    readFile: (path) => ipcRenderer.invoke("files:readFile", path),
    writeText: (path, text) => ipcRenderer.invoke("files:writeText", path, text),
    writeBinary: (path, data) => ipcRenderer.invoke("files:writeBinary", path, data),
    exists: (path) => ipcRenderer.invoke("files:exists", path),
    chooseFolder: (t) => ipcRenderer.invoke("files:chooseFolder", t),
    findByName: (f, n) => ipcRenderer.invoke("files:findByName", f, n),
  },
  app: {
    paths: () => ipcRenderer.invoke("app:paths"),
    kind,
    mode,
    health: () => ipcRenderer.invoke("app:health"),
    metrics: () => ipcRenderer.invoke("app:metrics"),
    reportSpike: (result) => ipcRenderer.invoke("app:reportSpike", result),
    log: (message) => ipcRenderer.send("app:log", message),
  },
  displays: {
    list: () => ipcRenderer.invoke("displays:list"),
    identify: () => ipcRenderer.invoke("displays:identify"),
  },
  windows: {
    openPreview: (displayId) => ipcRenderer.invoke("windows:openPreview", displayId),
    closePreview: () => ipcRenderer.invoke("windows:closePreview"),
    setPreviewView: (view) => ipcRenderer.send("windows:previewView", view),
    openOutput: (config) => ipcRenderer.invoke("windows:openOutput", config),
    closeOutput: (projectorId) => ipcRenderer.invoke("windows:closeOutput", projectorId),
    setOutputPattern: (projectorId, pattern) => ipcRenderer.invoke("windows:setOutputPattern", projectorId, pattern),
    outputs: () => ipcRenderer.invoke("windows:outputs"),
    onWindowsChanged: (cb) => on("windows:changed", cb),
  },
  assistant: {
    status: (refresh) => ipcRenderer.invoke("assistant:status", refresh),
    run: (spec) => ipcRenderer.invoke("assistant:run", spec),
    stop: (id) => ipcRenderer.invoke("assistant:stop", id),
    testSimulateMissing: (on) => ipcRenderer.invoke("assistant:testSimulateMissing", on),
    onEvent: (cb) => on("assistant:event", cb),
    onToolCall: (handler) =>
      on("assistant:tool", (call: AssistantToolCall) => {
        void handler(call).then(
          (r) => ipcRenderer.send("assistant:toolResult", call.callId, r),
          (e: unknown) => ipcRenderer.send("assistant:toolResult", call.callId, { text: String((e as Error)?.message ?? e), isError: true }),
        );
      }),
  },
  render: {
    enqueue: (spec) => ipcRenderer.invoke("render:enqueue", spec),
    list: () => ipcRenderer.invoke("render:list"),
    cancel: (id) => ipcRenderer.invoke("render:cancel", id),
    retry: (id) => ipcRenderer.invoke("render:retry", id),
    clearFinished: () => ipcRenderer.invoke("render:clearFinished"),
    onUpdate: (cb) => on("render:update", cb),
    onJob: (cb) => on("render:job", cb),
    onCancel: (cb) => on("render:cancel", cb),
    ready: () => ipcRenderer.send("render:ready"),
    progress: (id, p) => ipcRenderer.send("render:progress", id, p),
    finished: (id, p) => ipcRenderer.send("render:finished", id, p),
  },
  deliver: {
    driveFolder: () => ipcRenderer.invoke("deliver:driveFolder"),
    copyToDrive: (id, sub) => ipcRenderer.invoke("deliver:copyToDrive", id, sub),
    testFolder: (p) => ipcRenderer.invoke("deliver:testFolder", p),
  },
  sync: {
    publishProject: (project) => ipcRenderer.send("sync:project", project),
    publishTransport: (t) => ipcRenderer.send("sync:transport", t),
    hello: () => ipcRenderer.invoke("sync:hello"),
    onProject: (cb) => on("sync:project", cb),
    onTransport: (cb) => on("sync:transport", cb),
    onOutputConfig: (cb) => on("sync:outputConfig", cb),
    onPreviewView: (cb) => on("sync:previewView", cb),
  },
};

contextBridge.exposeInMainWorld("be", api);
// Display number for identification overlays.
contextBridge.exposeInMainWorld("beDisplayNumber", Number(arg("be-display") ?? 0));
