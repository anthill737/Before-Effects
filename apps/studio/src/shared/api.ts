/** The bridge between UI windows (renderers) and the desktop process (main). Plain data only. */
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
  readonly kind: "image" | "video" | "audio" | "unknown";
  readonly path: string;
  readonly originalPath: string;
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
  delivery?: { state: "copying" | "copied" | "failed"; target: string; at?: string; error?: string } | undefined;
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
  readonly time: number;
  readonly at: number;
  readonly loop: boolean;
  readonly range: { readonly start: number; readonly end: number } | null;
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
    chooseFiles(kind: "media" | "image" | "audio" | "aep"): Promise<string[]>;
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
  readonly displays: {
    list(): Promise<DisplayInfo[]>;
    identify(): Promise<void>;
  };
  readonly windows: {
    openPreview(displayId?: number): Promise<void>;
    closePreview(): Promise<void>;
    setPreviewView(view: string): void;
    openOutput(config: OutputConfig): Promise<OutputStatus>;
    closeOutput(projectorId: string): Promise<void>;
    setOutputPattern(projectorId: string, pattern: TestPattern): Promise<void>;
    outputs(): Promise<OutputStatus[]>;
    onWindowsChanged(cb: (s: { preview: boolean; outputs: OutputStatus[] }) => void): () => void;
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
    copyToDrive(jobId: string, subfolder?: string): Promise<string>;
    /** Journey tests only. */
    testFolder(path: string | null): Promise<void>;
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
