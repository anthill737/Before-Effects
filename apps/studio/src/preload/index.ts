import { contextBridge, ipcRenderer, type IpcRendererEvent, webUtils } from "electron";
import type { AgentCall, AssistantToolCall, BeApi, WindowKind } from "../shared/api.ts";

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
    pathForFile: (file) => webUtils.getPathForFile(file),
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
    onMenu: (fn) => {
      const h = (_e: unknown, command: string) => fn(command);
      ipcRenderer.on("menu:command", h);
      return () => ipcRenderer.removeListener("menu:command", h);
    },
  },
  cache: {
    machine: () => ipcRenderer.invoke("cache:machine"),
    configure: (config) => ipcRenderer.invoke("cache:configure", config),
    status: () => ipcRenderer.invoke("cache:status"),
    space: () => ipcRenderer.invoke("cache:space"),
    build: () => ipcRenderer.invoke("cache:build"),
    previous: (scope) => ipcRenderer.invoke("cache:previous", scope),
    keys: (scope) => ipcRenderer.invoke("cache:keys", scope),
    adopt: (scope, renames) => ipcRenderer.invoke("cache:adopt", scope, renames),
    put: (scope, key, data) => ipcRenderer.invoke("cache:put", scope, key, data),
    get: (scope, key) => ipcRenderer.invoke("cache:get", scope, key),
    clear: () => ipcRenderer.invoke("cache:clear"),
  },
  agent: {
    status: () => ipcRenderer.invoke("agent:status"),
    setEnabled: (on) => ipcRenderer.invoke("agent:setEnabled", on),
    setPort: (port) => ipcRenderer.invoke("agent:setPort", port),
    newToken: () => ipcRenderer.invoke("agent:newToken"),
    onCall: (handler) =>
      on("agent:call", (call: AgentCall) => {
        void handler(call).then(
          (r) => ipcRenderer.send("agent:result", call.callId, r),
          (e: unknown) => ipcRenderer.send("agent:result", call.callId, { ok: false, error: { code: "internal", message: String((e as Error)?.message ?? e) } }),
        );
      }),
    event: (type, data) => ipcRenderer.send("agent:event", type, data),
  },
  detect: {
    status: () => ipcRenderer.invoke("detect:status"),
    run: (requestId, image, opts) => ipcRenderer.invoke("detect:run", requestId, image, opts),
    cancel: (requestId) => ipcRenderer.invoke("detect:cancel", requestId),
    onProgress: (handler) => on("detect:progress", handler),
  },
  blender: {
    status: (refresh) => ipcRenderer.invoke("blender:status", refresh),
    choose: () => ipcRenderer.invoke("blender:choose"),
    run: (jobId, spec) => ipcRenderer.invoke("blender:run", jobId, spec),
    cancel: (jobId) => ipcRenderer.invoke("blender:cancel", jobId),
    exportModel: (jobId, spec) => ipcRenderer.invoke("blender:exportModel", jobId, spec),
    open: (blend) => ipcRenderer.invoke("blender:open", blend),
    mtime: (file) => ipcRenderer.invoke("blender:mtime", file),
    chooseBlend: () => ipcRenderer.invoke("blender:chooseBlend"),
    onProgress: (handler) => on("blender:progress", handler),
  },
  phone: {
    start: () => ipcRenderer.invoke("phone:start"),
    stop: () => ipcRenderer.invoke("phone:stop"),
    status: () => ipcRenderer.invoke("phone:status"),
    capture: (o) => ipcRenderer.invoke("phone:capture", o),
    lock: (on) => ipcRenderer.invoke("phone:lock", on),
    onStatus: (cb) => on("phone:status", cb),
    onPreview: (cb) => on("phone:preview", cb),
  },
  displays: {
    list: () => ipcRenderer.invoke("displays:list"),
    identify: () => ipcRenderer.invoke("displays:identify"),
  },
  windows: {
    openPreview: (displayId, onProjector) => ipcRenderer.invoke("windows:openPreview", displayId, onProjector),
    closePreview: () => ipcRenderer.invoke("windows:closePreview"),
    setPreviewView: (view) => ipcRenderer.send("windows:previewView", view),
    openOutput: (config) => ipcRenderer.invoke("windows:openOutput", config),
    closeOutput: (projectorId) => ipcRenderer.invoke("windows:closeOutput", projectorId),
    setOutputPattern: (projectorId, pattern) => ipcRenderer.invoke("windows:setOutputPattern", projectorId, pattern),
    reportOutputFrame: (info) => ipcRenderer.send("output:frame", info),
    reportOutputPattern: (pattern) => ipcRenderer.send("output:pattern", pattern),
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
  drive: {
    status: () => ipcRenderer.invoke("drive:status"),
    setFolder: (f, kind) => ipcRenderer.invoke("drive:setFolder", f, kind),
    chooseFolder: (kind) => ipcRenderer.invoke("drive:chooseFolder", kind),
    setMyDrive: (p) => ipcRenderer.invoke("drive:setMyDrive", p),
    list: (where, opts) => ipcRenderer.invoke("drive:list", where, opts),
    copyInto: (src, to, name, folder) => ipcRenderer.invoke("drive:copyInto", src, to, name, folder),
    fetch: (p) => ipcRenderer.invoke("drive:fetch", p),
    packageSave: (json, name) => ipcRenderer.invoke("drive:packageSave", json, name),
    packageOpen: (where) => ipcRenderer.invoke("drive:packageOpen", where),
    chooseFiles: (kind) => ipcRenderer.invoke("drive:chooseFiles", kind),
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
// The preview full-screen on a projector: the picture only, no controls.
contextBridge.exposeInMainWorld("beClean", arg("be-clean") === "1");
