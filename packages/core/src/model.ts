/**
 * The project model: plain, JSON-serialisable, immutable data with every entity normalised by id.
 *
 * The same data serves both ways of working. Guided recipes, the detailed timeline, scripts and the
 * AI assistant all read and write it through operations (ops.ts), so there are no parallel
 * "simple" and "pro" copies of the project.
 *
 * Conventions (see docs/01-architecture.md):
 *   - Time: integer flicks (time.ts).
 *   - Colors: user-facing sRGB-encoded floats [r, g, b, a] with straight alpha. The engine converts
 *     to scene-linear premultiplied for compositing.
 *   - 2D composition space: pixels, origin at the top-left, +y down (the After Effects convention).
 *   - Venue canvas space: pixels of the venue's reference canvas (for a flat venue, the traced photo).
 *   - Physical installation (venues) is never moved by creative edits. Shows reference venue regions
 *     by *role* through bindings, so one show can be rebound to another venue.
 */
import type { AnimProp } from "./anim.ts";
import { staticProp } from "./anim.ts";
import type { SimSettings } from "./simulation.ts";
import { type Flicks, type Rational, RATES, secondsToTime } from "./time.ts";

export type Id = string;
export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
export type RGBA = readonly [number, number, number, number];

export const PROJECT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Paths (shared by masks, shapes, regions, edge traces)

/** A Bezier vertex with tangents relative to the point, as in After Effects. */
export interface Vertex {
  readonly p: Vec2;
  readonly in?: Vec2;
  readonly out?: Vec2;
}

export interface PathData {
  readonly closed: boolean;
  readonly vertices: readonly Vertex[];
}

/** Where a path comes from: drawn by hand, or derived from venue regions (resolved through bindings). */
export type PathSource =
  | { readonly kind: "path"; readonly path: AnimProp<PathValue> }
  /** `outline`: only the areas' outer outlines (holes and cut-outs not taken out), e.g. to clip to a whole facade. */
  | { readonly kind: "region"; readonly ref: RegionRef; readonly outline?: boolean };

/** Animatable path values are stored as flat number arrays: [closed, n, x0,y0,inx,iny,outx,outy, ...]. */
export type PathValue = readonly number[];

/** A reference to physical regions through a role, e.g. { role: "windows", index: 3 }. */
export interface RegionRef {
  readonly role: string;
  /** Pick one member of the resolved list; omit to use all members. */
  readonly index?: number;
  /** Specific building areas. Shared across scenes; takes precedence over the role. */
  readonly regionIds?: readonly Id[];
  /** A named group of areas: follows the group's current members. Takes precedence over regionIds. */
  readonly groupId?: Id;
}

// ---------------------------------------------------------------------------------------------
// Assets

export type AssetKind = "image" | "video" | "audio" | "model" | "font" | "lut";

export interface AssetMeta {
  readonly width?: number;
  readonly height?: number;
  readonly duration?: Flicks;
  readonly frameRate?: Rational;
  readonly frameCount?: number;
  readonly hasAlpha?: boolean;
  readonly alphaMode?: "straight" | "premultiplied" | "ignore";
  readonly colorSpace?: string;
  readonly codec?: string;
  readonly audioChannels?: number;
  readonly sampleRate?: number;
  /** 3D models: measured when imported (metres, in the model's own frame). */
  readonly model?: ModelInfo;
}

/** A 3D model's extent and collision hull, measured from its file when it's imported. */
export interface ModelInfo {
  /** min x, y, z, max x, y, z. */
  readonly bounds: readonly [number, number, number, number, number, number];
  /** Points of its convex hull (x, y, z, …): its collider when it's given physics. */
  readonly hull: readonly number[];
  readonly meshes: number;
  readonly triangles: number;
  readonly animations: number;
  readonly lights: number;
  /**
   * Cameras in the file (e.g. a Blender scene's camera), where they are in the model's own frame:
   * `matrix` (4×4, column-major) places the camera (it looks along its own −z, up +y); `fovY` degrees;
   * `aspect` width / height when the file says.
   */
  readonly cameras?: ReadonlyArray<{ readonly name: string; readonly matrix: readonly number[]; readonly fovY: number; readonly aspect?: number; readonly near: number; readonly far: number }>;
  /** Named parts at the top of the file (what Geometry3D model `nodes` can pick). */
  readonly nodes?: readonly string[];
  /** Objects the file animates (an empty moved by keyframes, a character's root…): motion that can drive a controller. */
  readonly animated?: readonly string[];
}

/** Results of analysing an audio asset, saved with the project so preview and export use identical beats. */
export interface AudioAnalysis {
  readonly version: number;
  readonly bpm: number;
  /** Beat times in the asset's own time (flicks), from the start of the file. */
  readonly beats: readonly Flicks[];
  /** Index into `beats` of the first downbeat (bar start), when known. */
  readonly downbeatOffset: number;
  /** Strength of each beat 0..1 (onset strength), parallel to `beats`. */
  readonly strengths: readonly number[];
  /** The loud moments (a thunder clap, a crash), in time order: where each starts and how big it is. */
  readonly hits?: readonly SoundHit[];
}

/** One loud moment in a sound: a sudden rise well above what came before. */
export interface SoundHit {
  /** Where to start playing so the hit lands at once (just before it rises), in the file's own time. */
  readonly at: Flicks;
  /** Its loudest moment. */
  readonly peak: Flicks;
  /** Loudness at the peak (dB below full scale, 50 ms average). */
  readonly level: number;
  /** How long it stays within 20 dB of its peak. */
  readonly length: Flicks;
}

export interface Asset {
  readonly id: Id;
  readonly kind: AssetKind;
  readonly name: string;
  /** Absolute path, or relative to the project file. The original file is never modified. */
  readonly path: string;
  readonly meta: AssetMeta;
  readonly proxyPath?: string;
  readonly missing?: boolean;
  /** Original location before it was copied into the project's media folder. */
  readonly originalPath?: string;
  /** Its place in Google Drive ("Effects library/Ghosts/a.mp4" in My Drive) when it was brought in from there; `path` is the local copy. */
  readonly drive?: string;
  /** The file as imported when `path` is a working copy made from it (e.g. a HEIC photo decoded to PNG). */
  readonly sourceFile?: string;
  /** Made by Before Effects for the venue (the photo placed in the canvas), not content to use. */
  readonly purpose?: "venue-reference";
  /** Decoded sound (WAV) for files with audio, used identically by preview and export. */
  readonly audioPath?: string;
  readonly analysis?: AudioAnalysis;
}

// ---------------------------------------------------------------------------------------------
// Layers

/**
 * Blend modes the compositor draws (all of them). Normal, Add, Screen and Multiply mix light as it
 * is (linear); the others use the usual formulas on the picture as displayed, as After Effects and
 * Photoshop do. Keep in sync with engine/compositor.ts.
 */
export const RENDERED_BLEND_MODES = [
  "normal",
  "add",
  "screen",
  "multiply",
  "overlay",
  "soft-light",
  "hard-light",
  "color-dodge",
  "color-burn",
  "darken",
  "lighten",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
] as const;

export type BlendMode =
  | "normal"
  | "add"
  | "screen"
  | "multiply"
  | "overlay"
  | "soft-light"
  | "hard-light"
  | "color-dodge"
  | "color-burn"
  | "darken"
  | "lighten"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

export interface Transform {
  readonly anchor: AnimProp<Vec3>;
  readonly position: AnimProp<Vec3>;
  readonly scale: AnimProp<Vec3>; // percent, as in AE (100 = 1:1)
  readonly rotation: AnimProp<Vec3>; // degrees around x, y, z
  readonly opacity: AnimProp<number>; // 0..100
}

export interface Mask {
  readonly id: Id;
  readonly name: string;
  readonly source: PathSource;
  readonly mode: "add" | "subtract" | "intersect" | "lighten" | "darken" | "difference" | "none";
  readonly inverted: boolean;
  readonly feather: AnimProp<number>;
  readonly expansion: AnimProp<number>;
  readonly opacity: AnimProp<number>;
}

export interface EffectInstance {
  readonly id: Id;
  /** Effect type id from the engine's effect registry, e.g. "glow", "gaussian-blur". */
  readonly type: string;
  readonly enabled: boolean;
  readonly params: Readonly<Record<string, AnimProp>>;
}

export interface TrackMatte {
  readonly layerId: Id;
  readonly mode: "alpha" | "alpha-inverted" | "luma" | "luma-inverted";
}

/** Shape layer contents (a deliberately small first set; operators grow in milestone C). */
export interface ShapeContents {
  readonly path: PathSource;
  readonly fill?: { readonly color: AnimProp<RGBA>; readonly opacity: AnimProp<number> };
  readonly stroke?: {
    readonly color: AnimProp<RGBA>;
    readonly width: AnimProp<number>;
    readonly opacity: AnimProp<number>;
    readonly cap: "butt" | "round" | "square";
    readonly join: "miter" | "round" | "bevel";
  };
  /** Trim paths: start/end in percent, offset in degrees (AE semantics). */
  readonly trim?: {
    readonly start: AnimProp<number>;
    readonly end: AnimProp<number>;
    readonly offset: AnimProp<number>;
  };
}

/** A block of text. Layout is centred on the layer origin; per-character animators arrive with milestone C. */
export interface TextDocument {
  readonly text: string;
  readonly font: string;
  readonly weight: number;
  readonly size: AnimProp<number>;
  readonly color: AnimProp<RGBA>;
  readonly align: "left" | "center" | "right";
  /** Line height as a multiple of the font size. */
  readonly lineHeight: number;
  /** Extra letter spacing in pixels. */
  readonly tracking: number;
  /** Optional stroke around the letters. */
  readonly stroke?: { readonly color: AnimProp<RGBA>; readonly width: AnimProp<number> };
}

export type LayerSource =
  | { readonly kind: "solid"; readonly color: AnimProp<RGBA>; readonly width: number; readonly height: number }
  | { readonly kind: "text"; readonly doc: TextDocument }
  | { readonly kind: "shape"; readonly contents: readonly ShapeContents[] }
  | { readonly kind: "footage"; readonly assetId: Id; readonly loop?: boolean }
  | { readonly kind: "comp"; readonly compId: Id }
  | { readonly kind: "null" }
  | { readonly kind: "adjustment" }
  | { readonly kind: "scene3d"; readonly sceneId: Id }
  | { readonly kind: "audio"; readonly assetId: Id }
  /** A smoke or water simulation; frames are prepared (simulated and stored) before showing. */
  | { readonly kind: "simulation"; readonly sim: SimSettings }
  /** A 3D camera (imported from After Effects). Kept with its animation; 3D rendering comes later. */
  | { readonly kind: "camera"; readonly zoom: AnimProp<number> }
  /** A 3D light (imported from After Effects). Kept with its animation; 3D rendering comes later. */
  | {
      readonly kind: "light";
      readonly lightType: "parallel" | "spot" | "point" | "ambient" | "environment";
      readonly color: AnimProp<RGBA>;
      readonly intensity: AnimProp<number>;
    };

export interface GeneratedBy {
  readonly recipeInstanceId: Id;
  /** Stable key within the recipe's output, e.g. "trace", "window-3". */
  readonly role: string;
}

export interface Layer {
  readonly id: Id;
  readonly name: string;
  readonly source: LayerSource;
  /** Composition time when the layer's own time 0 occurs. */
  readonly startTime: Flicks;
  readonly inPoint: Flicks;
  readonly outPoint: Flicks;
  /** Playback speed multiplier (1 = normal, -1 = reversed). */
  readonly stretch: number;
  readonly enabled: boolean;
  readonly solo: boolean;
  readonly locked: boolean;
  readonly audioEnabled: boolean;
  readonly is3D: boolean;
  readonly parentId?: Id;
  readonly blendMode: BlendMode;
  readonly transform: Transform;
  readonly masks: readonly Mask[];
  readonly effects: readonly EffectInstance[];
  readonly trackMatte?: TrackMatte;
  readonly label?: string;
  /** Present when a recipe created this layer; edits are tracked as overrides, never lost. */
  readonly generatedBy?: GeneratedBy;
  /** Sound settings for layers that carry audio (audio files, videos with sound). */
  readonly audio?: AudioSettings;
}

/** Stereo sound for a layer. The mixer is a bus model, so multichannel routing can be added later. */
export interface AudioSettings {
  /** Level in decibels (0 = unchanged, -60 = practically silent). */
  readonly volume: AnimProp<number>;
  /** -1 (left) … 0 (centre) … 1 (right). */
  readonly pan: AnimProp<number>;
  /** Fade-in and fade-out lengths in seconds, applied at the layer's in and out points. */
  readonly fadeIn: number;
  readonly fadeOut: number;
  readonly muted: boolean;
}

// ---------------------------------------------------------------------------------------------
// Compositions

export interface Marker {
  readonly id: Id;
  readonly t: Flicks;
  readonly duration: Flicks;
  readonly label: string;
  readonly kind: "note" | "beat" | "cue" | "section";
}

export interface Composition {
  readonly id: Id;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly frameRate: Rational;
  readonly duration: Flicks;
  readonly background: RGBA;
  /** Top-most layer first, matching how timelines are displayed. */
  readonly layerOrder: readonly Id[];
  readonly layers: Readonly<Record<Id, Layer>>;
  readonly markers: readonly Marker[];
  readonly workArea?: { readonly start: Flicks; readonly end: Flicks };
  /** When set, this composition is the content for a venue (its canvas maps 1:1 to the venue canvas). */
  readonly venueId?: Id;
  /** Set on the show: the scenes it plays, in order (its layers are built from this plan). */
  readonly show?: import("./scenes.ts").ShowPlan;
}

// ---------------------------------------------------------------------------------------------
// Physical installation (venue) — never moved by creative edits

export type RegionKind = "window" | "door" | "garage" | "wall" | "roof" | "roofline" | "column" | "vent" | "light" | "edge" | "exclusion" | "custom";

export interface Region {
  readonly id: Id;
  readonly name: string;
  readonly kind: RegionKind;
  /** Outline in venue canvas pixels. Edge-type regions (rooflines) may be open paths. */
  readonly path: PathData;
  readonly tags: readonly string[];
  /** Cut-outs inside the outline (e.g. a window inside a wall area). */
  readonly holes?: readonly PathData[];
  /** Default softness of the edge in px when content is clipped to this area (scenes can add more). */
  readonly feather?: number;
  /** Default growth (+) or shrink (−) of the edge in px when content is clipped to this area. */
  readonly expansion?: number;
  /** Areas cut out of this one (a facade's windows and doors); the cut follows them when they're reshaped. */
  readonly cutouts?: readonly Id[];
  /**
   * How the area sits in 3D, in metres: how far its front stands out from the surface it's on (+, a
   * column from the wall, a lantern from its column) or is set back into it (−, a window in its wall),
   * and how thick it is. Every 3D scene that makes it a solid uses this, so they agree. Absent: the
   * usual depth for its kind (custom areas aren't solids until given a depth).
   */
  readonly depth?: { readonly standOut?: number; readonly thickness?: number };
  /** Set while the area is an automatic proposal nobody has reviewed yet. */
  readonly proposal?: RegionProposal;
}

/** How an automatically found area came about, kept until it's accepted. */
export interface RegionProposal {
  /** The detection run that proposed it. */
  readonly batch: Id;
  readonly score: number;
  /** Why it may be wrong; absent when the detection was confident. */
  readonly uncertain?: string;
  /** The detector's box, traced from the photo, or four corners fitted to the traced shape. */
  readonly outline: "box" | "traced" | "corners";
}

export interface RegionGroup {
  readonly id: Id;
  readonly name: string;
  readonly regionIds: readonly Id[];
  /** True when the app proposed the group (e.g. "12 similar windows") and the user accepted it. */
  readonly suggested?: boolean;
}

/** A content-space → output-space correspondence used for calibration. */
export interface CalibrationPoint {
  readonly id: Id;
  readonly label: string;
  /** Point in venue canvas pixels (what the content says should be there). */
  readonly content: Vec2;
  /** Where that point must land in the projector's output pixels (what the physical surface needs). */
  readonly output: Vec2;
}

export interface Calibration {
  readonly version: number;
  readonly locked: boolean;
  /** corner-pin: projective (homography) from >= 4 points; mesh adds a residual grid warp. */
  readonly mode: "corner-pin" | "mesh";
  readonly points: readonly CalibrationPoint[];
  /**
   * Residual grid over the projector's picture: offsets in content pixels at cols × rows points. With
   * `labels` (per point: 0 = main wall, k = the house area surfaces[k − 1]), corrections stay on their own
   * surface across depth edges (camera-measured alignment, core autoAlign.ts).
   */
  readonly mesh?: { readonly cols: number; readonly rows: number; readonly offsets: readonly Vec2[]; readonly labels?: readonly number[]; readonly surfaces?: readonly Id[]; readonly base?: readonly Vec2[] };
  readonly savedAt?: string;
  readonly note?: string;
}

export interface Projector {
  readonly id: Id;
  readonly name: string;
  readonly output: { readonly width: number; readonly height: number; readonly displayId?: string };
  readonly calibration: Calibration;
  /** Earlier saved calibrations for restore; newest last. */
  readonly calibrationHistory: readonly Calibration[];
  /** Physical output masks in projector output pixels; separate from creative masks. */
  readonly outputMasks: readonly PathData[];
  /** Output correction for this projector only (never part of the show's artistic grade). */
  readonly outputColor: { readonly gamma: number; readonly gain: RGBA; readonly blackLevel: number };
}

export interface Venue {
  readonly id: Id;
  readonly name: string;
  /** flat: a single planar surface traced over a reference; model: imported/measured 3D geometry. */
  readonly kind: "flat" | "model";
  readonly canvas: { readonly width: number; readonly height: number };
  /**
   * The reference image as seen on the canvas (canvas-sized): what tracing, the venue preview and
   * photo-textured 3D parts use. For a photo it's made from `photo` with `placement`.
   */
  readonly referenceAssetId?: Id;
  /** The original photo of the building (kept as imported) and how it sits in the canvas. */
  readonly photo?: { readonly assetId: Id; readonly placement: PhotoPlacement };
  /**
   * Where the audience stands: the show camera is this many building-widths in front of the building
   * (default 1.6). Every 3D scene uses it unless it has its own, so depth illusions line up.
   */
  readonly cameraDistance?: number;
  readonly regionOrder: readonly Id[];
  readonly regions: Readonly<Record<Id, Region>>;
  readonly groups: Readonly<Record<Id, RegionGroup>>;
  readonly projectorOrder: readonly Id[];
  readonly projectors: Readonly<Record<Id, Projector>>;
  /** Edge blending where projectors overlap (see projection.ts); absent = on, smooth. */
  readonly blend?: import("./projection.ts").VenueBlend;
}

/**
 * How a photo sits in the venue canvas, without stretching: "fit" shows all of it (bars where the
 * shapes differ), "fill" covers the canvas (edges cropped). `scale` is relative to that (100 = as
 * fitted), offsets are canvas pixels, crop trims each edge of the photo (fraction 0..0.45).
 */
export interface PhotoPlacement {
  readonly fit: "fit" | "fill";
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly crop: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };
}

export const DEFAULT_PLACEMENT: PhotoPlacement = { fit: "fit", scale: 100, offsetX: 0, offsetY: 0, crop: { left: 0, right: 0, top: 0, bottom: 0 } };

/** Where the photo (after cropping) lands on the canvas, in canvas pixels; and the crop in photo pixels. */
export const placePhoto = (photo: { width: number; height: number }, canvas: { width: number; height: number }, p: PhotoPlacement) => {
  const sx = photo.width * p.crop.left, sy = photo.height * p.crop.top;
  const sw = Math.max(1, photo.width * (1 - p.crop.left - p.crop.right)), sh = Math.max(1, photo.height * (1 - p.crop.top - p.crop.bottom));
  const k = (p.fit === "fit" ? Math.min(canvas.width / sw, canvas.height / sh) : Math.max(canvas.width / sw, canvas.height / sh)) * (p.scale / 100);
  const w = sw * k, h = sh * k;
  return { source: { x: sx, y: sy, w: sw, h: sh }, dest: { x: (canvas.width - w) / 2 + p.offsetX, y: (canvas.height - h) / 2 + p.offsetY, w, h }, pxPerPhotoPx: k };
};

/** Show-to-venue binding: role name → ordered region ids in that venue. */
export interface Binding {
  readonly venueId: Id;
  readonly roles: Readonly<Record<string, readonly Id[]>>;
}

// ---------------------------------------------------------------------------------------------
// Recipes (guided, editable outcomes)

export interface RecipeInstance {
  readonly id: Id;
  readonly recipeId: string;
  readonly compId: Id;
  readonly label: string;
  /** Targets by role so the recipe survives rebinding to another venue. */
  readonly targets: readonly RegionRef[];
  /** Creative parameters as shown in the simple controls. */
  readonly params: Readonly<Record<string, unknown>>;
  /** role → layer id of each generated layer. */
  readonly generated: Readonly<Record<string, Id>>;
  /** layer id → property paths the user customised by hand; regeneration preserves them. */
  readonly overrides: Readonly<Record<Id, readonly string[]>>;
  /** Comp time the recipe's animation starts at. */
  readonly startTime: Flicks;
}

// ---------------------------------------------------------------------------------------------

export interface ProjectSettings {
  readonly workingSpace: "linear-srgb" | "acescg";
  readonly displaySpace: "srgb";
  readonly defaultFrameRate: Rational;
  /** Where renders and caches go by default (D: on this machine has the space). */
  readonly renderDirectory?: string;
}

export interface Project {
  readonly schemaVersion: number;
  readonly id: Id;
  readonly name: string;
  readonly settings: ProjectSettings;
  readonly assets: Readonly<Record<Id, Asset>>;
  readonly compositions: Readonly<Record<Id, Composition>>;
  readonly compositionOrder: readonly Id[];
  readonly mainCompId?: Id;
  readonly venues: Readonly<Record<Id, Venue>>;
  readonly activeVenueId?: Id;
  readonly bindings: Readonly<Record<Id, Binding>>;
  readonly recipes: Readonly<Record<Id, RecipeInstance>>;
  /** Editable 3D scenes shown by 3D layers (creative geometry, separate from the venue). */
  readonly scenes3d?: Readonly<Record<Id, import("./world3d.ts").Scene3D>>;
  /** Jobs done in Blender: simulated effects and linked .blend files. */
  readonly blenderLinks?: Readonly<Record<Id, import("./blender.ts").BlenderLink>>;
}

// ---------------------------------------------------------------------------------------------
// Factories with sensible defaults

let idCounter = 0;
/** Collision-resistant ids that sort roughly by creation time. Deterministic generation is done by callers when needed. */
export const newId = (prefix = "id"): Id => {
  idCounter = (idCounter + 1) % 0x10000;
  const rand = Math.floor(Math.random() * 0x100000000)
    .toString(36)
    .padStart(7, "0");
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36).padStart(3, "0")}${rand}`;
};

export const emptyProject = (name = "Untitled show"): Project => ({
  schemaVersion: PROJECT_SCHEMA_VERSION,
  id: newId("prj"),
  name,
  settings: { workingSpace: "linear-srgb", displaySpace: "srgb", defaultFrameRate: RATES.fps30 },
  assets: {},
  compositions: {},
  compositionOrder: [],
  venues: {},
  bindings: {},
  recipes: {},
});

export const defaultTransform = (x = 0, y = 0): Transform => ({
  anchor: staticProp<Vec3>([0, 0, 0]),
  position: staticProp<Vec3>([x, y, 0], true),
  scale: staticProp<Vec3>([100, 100, 100]),
  rotation: staticProp<Vec3>([0, 0, 0]),
  opacity: staticProp(100),
});

export interface NewCompOptions {
  readonly id?: Id;
  readonly name?: string;
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: Rational;
  readonly durationSeconds?: number;
  readonly background?: RGBA;
  readonly venueId?: Id;
}

export const newComposition = (o: NewCompOptions = {}): Composition => ({
  id: o.id ?? newId("comp"),
  name: o.name ?? "Main",
  width: o.width ?? 1920,
  height: o.height ?? 1080,
  frameRate: o.frameRate ?? RATES.fps30,
  duration: secondsToTime(o.durationSeconds ?? 20),
  background: o.background ?? [0, 0, 0, 1],
  layerOrder: [],
  layers: {},
  markers: [],
  ...(o.venueId ? { venueId: o.venueId } : {}),
});

export interface NewLayerOptions {
  readonly id?: Id;
  readonly name?: string;
  readonly source: LayerSource;
  readonly start?: Flicks;
  readonly duration: Flicks;
  readonly position?: Vec2;
  readonly blendMode?: BlendMode;
  readonly generatedBy?: GeneratedBy;
}

export const newLayer = (o: NewLayerOptions): Layer => ({
  id: o.id ?? newId("layer"),
  name: o.name ?? defaultLayerName(o.source),
  source: o.source,
  startTime: o.start ?? 0,
  inPoint: o.start ?? 0,
  outPoint: (o.start ?? 0) + o.duration,
  stretch: 1,
  enabled: true,
  solo: false,
  locked: false,
  audioEnabled: true,
  is3D: false,
  blendMode: o.blendMode ?? "normal",
  transform: defaultTransform(o.position?.[0] ?? 0, o.position?.[1] ?? 0),
  masks: [],
  effects: [],
  ...(o.generatedBy ? { generatedBy: o.generatedBy } : {}),
});

const defaultLayerName = (s: LayerSource): string =>
  ({
    solid: "Color",
    shape: "Shape",
    footage: "Media",
    comp: "Nested scene",
    null: "Controller",
    simulation: "Simulation",
    camera: "Camera",
    light: "Light",
    adjustment: "Adjustment",
    scene3d: "3D scene",
    audio: "Audio",
    text: "Text",
  })[s.kind];

export const defaultAudio = (): AudioSettings => ({
  volume: staticProp(0),
  pan: staticProp(0),
  fadeIn: 0,
  fadeOut: 0,
  muted: false,
});

export const defaultCalibration = (canvasW: number, canvasH: number, outW: number, outH: number): Calibration => {
  // Start with the content canvas fitted (letterboxed) inside the projector output.
  const s = Math.min(outW / canvasW, outH / canvasH);
  const ox = (outW - canvasW * s) / 2;
  const oy = (outH - canvasH * s) / 2;
  const pt = (id: string, label: string, cx: number, cy: number): CalibrationPoint => ({
    id,
    label,
    content: [cx, cy],
    output: [ox + cx * s, oy + cy * s],
  });
  return {
    version: 1,
    locked: false,
    mode: "corner-pin",
    points: [
      pt("c1", "1", 0, 0),
      pt("c2", "2", canvasW, 0),
      pt("c3", "3", canvasW, canvasH),
      pt("c4", "4", 0, canvasH),
    ],
  };
};

export const newProjector = (venue: Pick<Venue, "canvas">, o: { id?: Id; name?: string; width?: number; height?: number } = {}): Projector => {
  const w = o.width ?? 1920;
  const h = o.height ?? 1080;
  return {
    id: o.id ?? newId("proj"),
    name: o.name ?? "Projector 1",
    output: { width: w, height: h },
    calibration: defaultCalibration(venue.canvas.width, venue.canvas.height, w, h),
    calibrationHistory: [],
    outputMasks: [],
    outputColor: { gamma: 1, gain: [1, 1, 1, 1], blackLevel: 0 },
  };
};

// ---------------------------------------------------------------------------------------------
// Path value packing

export const packPath = (path: PathData): PathValue => {
  const out: number[] = [path.closed ? 1 : 0, path.vertices.length];
  for (const v of path.vertices) {
    out.push(v.p[0], v.p[1], v.in?.[0] ?? 0, v.in?.[1] ?? 0, v.out?.[0] ?? 0, v.out?.[1] ?? 0);
  }
  return out;
};

export const unpackPath = (v: PathValue): PathData => {
  const n = v[1] ?? 0;
  const vertices: Vertex[] = [];
  for (let i = 0; i < n; i++) {
    const o = 2 + i * 6;
    vertices.push({ p: [v[o]!, v[o + 1]!], in: [v[o + 2]!, v[o + 3]!], out: [v[o + 4]!, v[o + 5]!] });
  }
  return { closed: (v[0] ?? 0) !== 0, vertices };
};

export const polygonPath = (points: readonly Vec2[], closed = true): PathData => ({
  closed,
  vertices: points.map((p) => ({ p })),
});
