/** The bridge between UI windows (renderers) and the desktop process (main). Plain data only. */
import type { HouseDetection } from "@be/core";
import type { EncodeResult, EncodeSpec, Preset, ProbeResult, VerifyExpectation, VerifyReport } from "@be/media";

export interface AppPaths {
  readonly renders: string;
  readonly projects: string;
  readonly autosave: string;
  readonly media: string;
  readonly cache: string;
  readonly logs: string;
}

/** What media import learned about a file (copied into the project's media folder). */
export interface ImportedMedia {
  readonly kind: "image" | "video" | "audio" | "model" | "unknown";
  readonly path: string;
  readonly originalPath: string;
  /** Its place in Google Drive when it came from there (the file at `path` is the local copy). */
  readonly drive?: string | undefined;
  readonly name: string;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly frameRate?: { readonly num: number; readonly den: number } | undefined;
  readonly frameCount?: number | undefined;
  readonly durationSeconds?: number | undefined;
  readonly hasAlpha?: boolean | undefined;
  /** WAV with the file's sound (for videos and compressed audio), used for preview and export mixing. */
  readonly audioPath?: string | undefined;
  readonly sampleRate?: number | undefined;
  readonly audioChannels?: number | undefined;
  readonly codec?: string | undefined;
  /** The file as imported when `path` is a working copy (HEIC/HEIF decoded to PNG). */
  readonly sourceFile?: string | undefined;
  /** What happened while reading it (e.g. HDR tone mapping, fallback decoder). */
  readonly notes?: readonly string[] | undefined;
}

/** An export to render in the background. `snapshot` is the show as it was when queued. */
export interface RenderJobSpec {
  readonly name: string;
  readonly outcome: "share" | "master" | "transparent" | "projector";
  readonly preset: import("@be/media").PresetId;
  readonly compId: string;
  readonly target: { readonly kind: "master"; readonly keepAlpha: boolean } | { readonly kind: "projector"; readonly venueId: string; readonly projectorId: string };
  readonly output: string;
  /** Render size (full composition or projector size). */
  readonly width: number;
  readonly height: number;
  /** Delivered size when the person chose a smaller export (scaled with high quality after rendering). */
  readonly deliverSize?: { readonly width: number; readonly height: number };
  readonly frameRate: { readonly num: number; readonly den: number };
  readonly startFrame: number;
  readonly frames: number;
  readonly alpha: boolean;
  readonly withAudio: boolean;
  readonly estimatedBytes: number;
  readonly snapshot: string;
  /** Copy the finished export into Before Effects' Exports folder in Google Drive. */
  readonly sendToDrive?: boolean;
}

/** Google Drive (through Google Drive for desktop): where it is and Before Effects' folder in it. */
export interface DriveStatus {
  /** Google Drive for desktop: running, installed but not running, or not installed. */
  readonly app: "running" | "installed" | "missing";
  /** My Drive on this computer (null when it isn't there). */
  readonly myDrive: string | null;
  /** Before Effects' folder, relative to My Drive ("Before Effects"). */
  readonly folder: string;
  /** The folder and its Media, Projects and Exports subfolders exist. */
  readonly ready: boolean;
  readonly paths?: { readonly base: string; readonly media: string; readonly projects: string; readonly exports: string };
  /** The same folders as places in My Drive ("Before Effects/Exports"). */
  readonly places?: { readonly base: string; readonly media: string; readonly projects: string; readonly exports: string };
  /** Kinds with a folder of their own (not the subfolder of Before Effects' folder). */
  readonly custom?: { readonly media: boolean; readonly projects: boolean; readonly exports: boolean };
  /** Likely mistakes in the folders (a folder nested in one with the same name). */
  readonly warnings?: readonly string[];
  /** What the last change did, when it wasn't exactly what was asked. */
  readonly notice?: string;
  /** Local caches (never in Drive). */
  readonly cache?: string;
  readonly uploadNote?: string;
  readonly problem?: string;
}

export interface DriveEntry {
  readonly name: string;
  readonly path: string;
  /** Place in My Drive ("Effects library/Ghosts/a.mp4"). */
  readonly rel: string;
  readonly kind: "folder" | "video" | "image" | "audio" | "project" | "package" | "other";
  readonly size?: number;
  readonly modified?: string;
}

/** A copy into the Drive folder. `confirmed` stays false: Drive for desktop uploads it in its own time. */
export interface DriveCopy {
  readonly target: string;
  readonly rel: string;
  readonly size: number;
  readonly copiedAt: string;
  readonly confirmed: false;
  readonly note: string;
}

export interface RenderJob extends RenderJobSpec {
  readonly id: string;
  state: "queued" | "rendering" | "done" | "failed" | "cancelled";
  phase: string;
  done: number;
  fps?: number | undefined;
  etaSeconds?: number | undefined;
  createdAt: string;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  result?: string | undefined;
  sizeBytes?: number | undefined;
  verify?: import("@be/media").VerifyReport | undefined;
  error?: string | undefined;
  /** Google Drive: "copied" means the file is complete in the Drive folder, not that Google has it yet (`note`). */
  delivery?: { state: "copying" | "copied" | "failed"; target: string; at?: string; error?: string; confirmed?: false; note?: string } | undefined;
}

/** External-agent API status for the settings panel. */
export interface AgentStatus {
  readonly enabled: boolean;
  readonly listening: boolean;
  readonly port: number;
  readonly url: string;
  readonly error: string;
  readonly configFile: string;
  readonly requests: number;
  readonly lastRequestAt: string;
  readonly lastMethod: string;
  readonly clients: ReadonlyArray<{ name: string; at: string }>;
  readonly streams: number;
  readonly setup: { claude: string; codex: string; mcpJson: string; cli: string; cliScript: string; exe: string };
}

/** A call from an external agent, executed in the editor. */
export interface AgentCall {
  readonly callId: string;
  readonly method: string;
  readonly params: unknown;
  readonly requestId: string;
}
export interface AgentCallResult {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string; readonly details?: unknown };
  readonly revision?: number;
}

export interface ImportedAsset {
  /** The working file (for HEIC: the decoded PNG). */
  readonly path: string;
  /** The file as imported, when a working copy was made from it (e.g. the original HEIC). */
  readonly sourceFile?: string;
  readonly width?: number;
  readonly height?: number;
  readonly hasAlpha?: boolean;
  readonly decoder?: "libheif" | "ffmpeg";
  readonly notes?: readonly string[];
}

export interface SavedFile {
  readonly path: string;
  readonly savedAt: string;
}

/** The computer's memory and its graphics card's own memory (when Windows reports it), in bytes. */
export interface MachineMemory {
  readonly ramBytes: number;
  readonly gpu: { readonly name: string; readonly bytes: number } | null;
  readonly cpuCores?: number;
}

/** The drive preview frames go on (for recommendations; read even while the disk cache is off). */
export interface CacheSpace {
  /** The drive ("D:\\") and the frames' folder on it. */
  readonly drive: string;
  readonly root: string;
  readonly freeBytes: number;
  readonly totalBytes: number;
  /** Space preview frames already use there (0 until the folder has been read). */
  readonly usedBytes: number;
  readonly files: number;
}

/** Preview frames on disk: one folder and size limit for all windows. */
export interface DiskCacheConfig {
  /** A folder the person picked (frames go in a folder of their own inside it), or null for the data folder's Cache\preview. */
  readonly folder: string | null;
  readonly limitBytes: number;
}

export interface DiskCacheUsage {
  readonly bytes: number;
  readonly files: number;
  readonly limitBytes: number;
  /** From saving a frame: frames the size limit removed to make room (folder scope and key). */
  readonly evicted?: ReadonlyArray<{ readonly scope: string; readonly key: string }>;
}

export interface DiskCacheStatus extends DiskCacheUsage {
  /** Where the frames are. */
  readonly root: string;
  /** Free space on that drive (null when unknown). */
  readonly freeBytes: number | null;
  /** Still finding out what's already saved there. */
  readonly scanning: boolean;
  readonly problem?: string;
}

/** Whose frames: a show (project id) and one of its compositions. */
export interface DiskCacheScope {
  readonly project: string;
  readonly comp: string;
}

export type WindowKind = "editor" | "preview" | "output" | "render" | "identify" | "spike" | "uitest";

export interface HealthReport {
  readonly version: string;
  readonly packaged: boolean;
  readonly ffmpeg: { readonly ok: boolean; readonly path?: string; readonly fix?: string };
  readonly logDir: string;
  /** Background processes Before Effects is running (FFmpeg, assistant…), for diagnostics. */
  readonly children: readonly string[];
}

export interface DisplayInfo {
  readonly id: number;
  readonly label: string;
  readonly primary: boolean;
  readonly internal: boolean;
  /** Physical pixels (bounds × scale factor). */
  readonly pixels: { readonly width: number; readonly height: number };
  readonly scaleFactor: number;
  readonly refreshRate: number;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

/** Shared playback clock: `time` (flicks) was current at wall-clock `at` (ms since epoch). */
export interface TransportState {
  readonly playing: boolean;
  /** The editor's time (flicks) at `at` (ms epoch): while playing, its sound clock's. */
  readonly time: number;
  readonly at: number;
  readonly loop: boolean;
  readonly range: { readonly start: number; readonly end: number } | null;
  /** Playing, but held: the editor is reading frames ahead, or its sound is starting (followers hold too). */
  readonly held?: boolean;
}

/** What a projector output reports a few times a second. */
export interface OutputShowing {
  /** The frame on its screen. */
  readonly frame: number;
  /** Draws in the last second (redraws of the same frame included). */
  readonly fps: number;
  /** Different frames shown in the last second. */
  readonly unique?: number;
  /** Frames passed over without being shown, since playback started. */
  readonly skipped?: number;
  /** Why frames went unshown (since it opened): due but not yet read from disk, and passed over by the clock between two turns to draw. */
  readonly causes?: { readonly lateReads: number; readonly lateTurns: number; readonly slowTurns?: number; readonly longestTurnMs?: number };
  /** Times its picture went back to an earlier frame while playing (shows frames again), since playback started. */
  readonly stepsBack?: number;
  /** Its clock against the editor's next report (ms): largest in the last two seconds and since playback started. */
  readonly clockErrMs?: number;
  readonly clockErrMaxMs?: number;
  /** Its picture against the editor's clock (the sound): recent average and largest since playback started (ms; positive = ahead). */
  readonly syncMs?: number | null;
  readonly syncMaxMs?: number | null;
  /** Reading a prepared frame back from disk (ms, recent average); 0 when it renders every frame. */
  readonly diskReadMs?: number;
  /** Prepared frames it can read from disk for the scene it shows. */
  readonly framesOnDisk?: number;
  /** Frames ready in its graphics memory from the one it shows on (the editor waits for a second of them before playing). */
  readonly ahead?: number;
  readonly playing?: boolean;
  /** Graphics memory this output holds, by owner (MB): finished frames, pictures and video, texture pool (lent out / kept), 3D (render targets and built scenes). */
  readonly memoryMB?: { readonly frameCache: number; readonly media: number; readonly poolInUse: number; readonly poolFree: number; readonly scene3d: number };
  /** When the editor received the report (ms epoch). */
  readonly at: number;
}

export type TestPattern = "none" | "identify" | "grid" | "checker" | "white" | "black" | "colors";

export interface OutputConfig {
  readonly venueId: string;
  readonly projectorId: string;
  readonly displayId: number;
  readonly pattern: TestPattern;
}

export interface OutputStatus {
  readonly projectorId: string;
  readonly displayId: number;
  readonly displayLabel: string;
  readonly displayPixels: { readonly width: number; readonly height: number };
  readonly open: boolean;
  /** Its display was disconnected: it reopens when the display comes back. */
  readonly waiting?: boolean;
  /** What the output last showed (it reports a few times a second). */
  readonly showing?: OutputShowing;
}

export interface SyncHello {
  readonly project: unknown | null;
  readonly transport: TransportState | null;
  readonly output: OutputConfig | null;
  readonly previewView: string | null;
}

export interface AssistantProviderStatus {
  readonly id: "claude" | "codex";
  /** "Claude" / "ChatGPT" */
  readonly name: string;
  /** The official tool used: "Claude Code" / "Codex". */
  readonly via: string;
  readonly installed: boolean;
  readonly signedIn: boolean;
  /** Installed, signed in, and on a subscription (never an API key). */
  readonly ready: boolean;
  readonly billing: "subscription" | "api" | "unknown";
  readonly plan?: string;
  /** Plain status, or exactly what to do to make it ready. */
  readonly message: string;
}

export interface AssistantUsage {
  /** Share of the plan's 5-hour / weekly allowance used (0–1), when the tool reports it. */
  readonly fiveHour?: number;
  readonly sevenDay?: number;
  readonly resetsAt?: number;
  readonly usingExtra?: boolean;
}

export interface AssistantRunSpec {
  readonly requestId: string;
  readonly provider: "claude" | "codex" | "test";
  readonly prompt: string;
  /** Continue an earlier conversation (follow-ups like "slower"). */
  readonly sessionId?: string;
  /** Allow Claude's paid extra usage once the plan's included usage is used up. Off by default. */
  readonly allowExtraUsage?: boolean;
  /** Journey tests only: scripted tool calls for the "test" provider. */
  readonly script?: ReadonlyArray<{ call?: string; args?: Record<string, unknown>; say?: string; wait?: number }>;
}

export type AssistantEvent =
  | { readonly requestId: string; readonly kind: "started"; readonly sessionId?: string; readonly model?: string }
  | { readonly requestId: string; readonly kind: "tool"; readonly tool: string; readonly text: string }
  | { readonly requestId: string; readonly kind: "text"; readonly text: string }
  | { readonly requestId: string; readonly kind: "usage"; readonly usage: AssistantUsage }
  | { readonly requestId: string; readonly kind: "done"; readonly reply: string; readonly sessionId?: string }
  | { readonly requestId: string; readonly kind: "failed"; readonly message: string; readonly detail?: string; readonly sessionId?: string };

export interface AssistantToolCall {
  readonly callId: string;
  readonly requestId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface BeApi {
  readonly encode: {
    start(spec: EncodeSpec): Promise<{ id: string; bytesPerFrame: number }>;
    frame(id: string, data: Uint8Array): Promise<void>;
    finish(id: string): Promise<EncodeResult>;
    cancel(id: string): Promise<void>;
  };
  readonly media: {
    presets(): Promise<Preset[]>;
    probe(path: string): Promise<ProbeResult>;
    verify(path: string, expect: VerifyExpectation): Promise<VerifyReport>;
    import(src: string, projectId: string): Promise<ImportedMedia>;
    /** Per-frame picture brightness and sound loudness of a finished file (timing checks). */
    measureAv(path: string): Promise<{ fps: number; brightness: number[]; loudness: number[] }>;
    decodeFrame(path: string, frame: number, fps: number, width: number, srcW: number, srcH: number): Promise<{ data: Uint8Array; width: number; height: number } | null>;
  };
  readonly files: {
    saveProject(json: string, path?: string): Promise<SavedFile | null>;
    openProject(path?: string): Promise<{ path: string; json: string } | null>;
    autosave(json: string): Promise<SavedFile>;
    recoverAutosave(): Promise<{ json: string; savedAt: string } | null>;
    clearAutosave(): Promise<void>;
    showInFolder(path: string): Promise<void>;
    openPath(path: string): Promise<void>;
    chooseImage(): Promise<{ path: string; dataUrl: string } | null>;
    chooseFiles(kind: "media" | "image" | "audio" | "aep" | "model"): Promise<string[]>;
    /** Copy a file into the show's media folder (original untouched). HEIC/HEIF photos are decoded to a PNG working copy. */
    importAsset(src: string, projectId: string): Promise<ImportedAsset>;
    /** The file path of a file dropped from Explorer. */
    pathForFile(file: File): string;
    readFile(path: string): Promise<Uint8Array>;
    writeText(path: string, text: string): Promise<void>;
    writeBinary(path: string, data: Uint8Array): Promise<void>;
    exists(path: string): Promise<boolean>;
    chooseFolder(title?: string): Promise<string | null>;
    /** Find files by name (any case) in a folder and its subfolders: name → full path. */
    findByName(folder: string, names: string[]): Promise<Record<string, string>>;
  };
  readonly app: {
    paths(): Promise<AppPaths>;
    readonly kind: WindowKind;
    readonly mode: "studio" | "spike" | "uitest";
    health(): Promise<HealthReport>;
    /** The machine (CPU, threads, RAM) and each app process's memory in MB. */
    metrics(): Promise<{ cpu: string; threads: number; ramGB: number; processes: Array<{ type: string; name: string; mb: number; privateMb: number }> }>;
    reportSpike(result: unknown): Promise<void>;
    log(message: string): void;
    /** Commands from the menu bar (File, Edit, View, …). Returns a function that stops listening. */
    onMenu(fn: (command: string) => void): () => void;
  };
  /** Preview frames kept on disk (see main/previewCache.ts), and how much memory there is for caches. */
  readonly cache: {
    machine(): Promise<MachineMemory>;
    /** Folder and size limit (shared by every window; a smaller limit deletes the least recently used frames). */
    configure(config: DiskCacheConfig): Promise<DiskCacheStatus>;
    status(): Promise<DiskCacheStatus>;
    /** The drive the frames go on: free and total space, and what frames use there now. */
    space(): Promise<CacheSpace | null>;
    /** This app's build and the tag its frames carry on disk. */
    build(): Promise<{ build: string; tag: string }>;
    /** Keys of a composition's frames on disk (every version of the show, every build), changing nothing. */
    keys(scope: DiskCacheScope): Promise<string[]>;
    /** A composition's frames saved before signatures: the show fingerprint and app build they were made from, and this app's build; null when none. */
    previous(scope: DiskCacheScope): Promise<{ fingerprint: string; build: string; current: string } | null>;
    /** Rename frames on disk in place ([from key, to key]): frames saved before signatures, or another build's this one draws the same. Returns the keys. */
    adopt(scope: DiskCacheScope, renames: Array<[string, string]>): Promise<string[]>;
    /** Save a frame (a compact image). Null when it wasn't kept (drive nearly full, or the show changed meanwhile). */
    put(scope: DiskCacheScope, key: string, data: Uint8Array): Promise<DiskCacheUsage | null>;
    get(scope: DiskCacheScope, key: string): Promise<Uint8Array | null>;
    clear(): Promise<DiskCacheStatus>;
  };
  readonly agent: {
    status(): Promise<AgentStatus>;
    setEnabled(on: boolean): Promise<AgentStatus>;
    setPort(port: number): Promise<AgentStatus>;
    newToken(): Promise<AgentStatus>;
    /** Editor: execute calls from external agents. */
    onCall(handler: (call: AgentCall) => Promise<AgentCallResult>): () => void;
    /** Editor: publish an event to connected agents (revision, selection, preparation…). */
    event(type: string, data: unknown): void;
  };
  /** Automatic house setup: finding the parts of the house in the photo (models run on this computer). */
  readonly detect: {
    status(): Promise<DetectStatus>;
    /** Run on a canvas-sized image. Fails with code "needs-download" when models are missing and downloading wasn't allowed. */
    run(requestId: string, image: string, opts: { allowDownload: boolean; device?: "gpu" | "cpu" }): Promise<{ ok: true; detection: HouseDetection } | { ok: false; code: string; message: string }>;
    cancel(requestId: string): Promise<boolean>;
    onProgress(handler: (p: DetectProgress) => void): () => void;
  };
  /** Blender: simulated effects and linked .blend files, rendered in the background. */
  readonly blender: {
    status(refresh?: boolean): Promise<{ found: boolean; path: string | null; version: string | null; running: string[] }>;
    choose(): Promise<{ path: string; version: string } | null>;
    run(jobId: string, spec: BlenderRunSpec): Promise<{ ok: true; video: string; blendMtime: number } | { ok: false; code: string; message: string }>;
    /** Bring a .blend in as editable data: a GLB plus a per-object compatibility report. */
    exportModel(jobId: string, spec: { blend: string; fps: number; frames: number; dir: string }): Promise<{ ok: true; model: string; report: BlenderModelReport } | { ok: false; code: string; message: string }>;
    cancel(jobId: string): Promise<boolean>;
    open(blend: string): Promise<{ ok: boolean; message?: string }>;
    mtime(file: string): Promise<number | null>;
    chooseBlend(): Promise<string | null>;
    onProgress(handler: (p: { jobId: string; stage: string; done: number; total: number }) => void): () => void;
  };
  readonly displays: {
    list(): Promise<DisplayInfo[]>;
    identify(): Promise<void>;
  };
  readonly windows: {
    /** `onProjector`: full-screen on that display with only the picture (editing stays in the editor). */
    openPreview(displayId?: number, onProjector?: boolean): Promise<void>;
    closePreview(): Promise<void>;
    setPreviewView(view: string): void;
    openOutput(config: OutputConfig): Promise<OutputStatus>;
    closeOutput(projectorId: string): Promise<void>;
    setOutputPattern(projectorId: string, pattern: TestPattern): Promise<void>;
    /** Output windows: report the frame now showing (for sync and health checks). */
    reportOutputFrame(info: Omit<OutputShowing, "at">): void;
    outputs(): Promise<OutputStatus[]>;
    onWindowsChanged(cb: (s: { preview: boolean; previewOnProjector?: boolean; outputs: OutputStatus[] }) => void): () => void;
  };
  readonly assistant: {
    status(refresh?: boolean): Promise<AssistantProviderStatus[]>;
    run(spec: AssistantRunSpec): Promise<void>;
    stop(requestId: string): Promise<void>;
    onEvent(cb: (e: AssistantEvent) => void): () => void;
    /** The editor executes the assistant's tool calls and returns a JSON text result. */
    onToolCall(handler: (call: AssistantToolCall) => Promise<{ text: string; isError?: boolean }>): () => void;
    /** Journey tests only. */
    testSimulateMissing(on: boolean): Promise<void>;
  };
  readonly render: {
    enqueue(spec: RenderJobSpec): Promise<string>;
    list(): Promise<RenderJob[]>;
    cancel(id: string): Promise<void>;
    retry(id: string): Promise<string>;
    clearFinished(): Promise<void>;
    onUpdate(cb: (jobs: RenderJob[]) => void): () => void;
    /** Worker side. */
    onJob(cb: (job: RenderJob) => void): () => void;
    onCancel(cb: (id: string) => void): () => void;
    ready(): void;
    progress(id: string, p: Partial<RenderJob>): void;
    finished(id: string, p: Partial<RenderJob>): void;
  };
  readonly deliver: {
    driveFolder(): Promise<string | null>;
    /** Into Before Effects' Exports folder in Drive (or `folder`, a place in My Drive). */
    copyToDrive(jobId: string, folder?: string): Promise<string>;
    /** Journey tests only. */
    testFolder(path: string | null): Promise<void>;
  };
  readonly drive: {
    status(): Promise<DriveStatus>;
    /** Before Effects' folder ("folder") or one kind's own folder, in My Drive (relative or a full path inside it); null: the default. */
    setFolder(folder: string | null, kind?: "folder" | "media" | "projects" | "exports"): Promise<DriveStatus>;
    /** Pick that folder in a folder chooser that starts in Drive (null if cancelled). */
    chooseFolder(kind?: "folder" | "media" | "projects" | "exports"): Promise<DriveStatus | null>;
    /** Where My Drive is when it isn't found by itself (null: find it). */
    setMyDrive(path: string | null): Promise<DriveStatus>;
    list(where?: string, opts?: { recursive?: boolean; max?: number }): Promise<{ folder: string; entries: DriveEntry[]; more: boolean }>;
    /** Into Before Effects' subfolder `to`, or `folder` (a place in My Drive). */
    copyInto(src: string, to: "media" | "projects" | "exports", name?: string, folder?: string): Promise<DriveCopy>;
    /** A file from anywhere in Drive, copied to the local cache. */
    fetch(path: string): Promise<{ local: string; rel: string; size: number }>;
    packageSave(projectJson: string, name: string): Promise<{ folder: string; rel: string; files: number; bytes: number; note: string }>;
    packageOpen(where: string): Promise<{ project: string; files: number; bytes: number }>;
    /** File picker that starts in Drive. */
    chooseFiles(kind: "media" | "package"): Promise<string[]>;
  };
  readonly sync: {
    publishProject(project: unknown): void;
    publishTransport(t: TransportState): void;
    hello(): Promise<SyncHello>;
    onProject(cb: (project: unknown) => void): () => void;
    onTransport(cb: (t: TransportState) => void): () => void;
    onOutputConfig(cb: (c: OutputConfig) => void): () => void;
    onPreviewView(cb: (v: string) => void): () => void;
  };
}

declare global {
  interface Window {
    be: BeApi;
  }
}

export interface DetectStatus {
  modelsDir: string;
  models: Array<{ id: string; role: string; license: string; sizeMB: number; present: boolean }>;
  /** MB still to download (0 when everything is on this computer). */
  downloadMB: number;
  running: string[];
}

export interface DetectProgress {
  requestId: string;
  stage: string;
  fraction: number;
  text: string;
}

export interface BlenderModelReport {
  readonly objects: ReadonlyArray<{ readonly name: string; readonly type: string; readonly status: "editable" | "approximated" | "video-only" | "skipped"; readonly note: string }>;
  readonly file: { readonly nodes: readonly string[]; readonly meshes: number; readonly materials: number; readonly animations: number; readonly lights: number; readonly bytes: number };
  readonly frames: number;
  readonly fps: number;
  readonly firstFrame: number;
}

export interface BlenderRunSpec {
  mode: "build" | "render";
  exchange: { fps: number; frames: number; output: { blend: string; frames: string; cache: string } } & Record<string, unknown>;
  video: string;
}
