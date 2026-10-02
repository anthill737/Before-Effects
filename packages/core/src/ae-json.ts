/**
 * After Effects project data in the shape of After Effects' own scripting object model
 * (ExtendScript): items, compositions, layers and property trees addressed by match name.
 *
 * Two routes produce it, and one importer (ae-import.ts) reads it:
 *   - With After Effects installed: tools/ae-exporter/BeforeEffectsExport.jsx runs inside After
 *     Effects and writes this JSON (highest fidelity: AE itself resolves every value).
 *   - Without After Effects: @be/aep reads the .aep file's binary (RIFX) structure directly.
 *
 * Field names follow ExtendScript so data exported by other ExtendScript tools also loads. Times
 * are in seconds (composition time), colours are 0..1, enums are AE's numeric values. Everything
 * is optional unless the importer cannot work without it, because each route knows different
 * things; whatever is missing is reported, never guessed silently.
 */

export interface AeJsonProject {
  readonly projectName?: string;
  readonly bitsPerChannel?: number;
  readonly items: readonly AeJsonItem[];
  /** Who wrote this file, e.g. { name: "Before Effects exporter", version: "1", aeVersion: "25.0" }. */
  readonly exporter?: { readonly name: string; readonly version?: string; readonly aeVersion?: string };
  /** Things the producing route could not read, already in plain words (merged into the report). */
  readonly notes?: readonly string[];
}

export type AeJsonItem = AeJsonFolder | AeJsonFootage | AeJsonComp;

interface AeJsonItemBase {
  readonly id: number;
  readonly name: string;
  readonly parentFolderId?: number;
  readonly comment?: string;
  readonly label?: number;
}

export interface AeJsonFolder extends AeJsonItemBase {
  readonly itemType: "FolderItem";
}

export interface AeJsonFootage extends AeJsonItemBase {
  readonly itemType: "FootageItem";
  readonly width?: number;
  readonly height?: number;
  readonly duration?: number;
  readonly frameRate?: number;
  readonly pixelAspect?: number;
  readonly hasAudio?: boolean;
  readonly hasVideo?: boolean;
  readonly footageMissing?: boolean;
  readonly mainSource?: {
    readonly sourceType?: "SolidSource" | "FileSource" | "PlaceholderSource" | string;
    /** Solid colour (0..1 RGB). */
    readonly color?: readonly number[];
    /** Absolute path of the media file as saved in the project. */
    readonly file?: string | null;
    readonly isStill?: boolean;
    readonly hasAlpha?: boolean;
    readonly loop?: number;
  };
}

export interface AeJsonComp extends AeJsonItemBase {
  readonly itemType: "CompItem";
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly frameDuration?: number;
  readonly duration: number;
  readonly pixelAspect?: number;
  readonly bgColor?: readonly number[];
  readonly workAreaStart?: number;
  readonly workAreaDuration?: number;
  readonly displayStartTime?: number;
  readonly motionBlur?: boolean;
  readonly frameBlending?: boolean;
  readonly renderer?: string;
  readonly layers: readonly AeJsonLayer[];
  readonly markers?: readonly AeJsonMarker[];
}

export interface AeJsonMarker {
  readonly time: number;
  readonly duration?: number;
  readonly comment?: string;
  readonly label?: number;
}

export interface AeJsonLayer {
  /** 1-based, 1 = top of the layer stack (as in After Effects). */
  readonly index: number;
  readonly name: string;
  /** "AVLayer" | "CameraLayer" | "LightLayer" | "TextLayer" | "ShapeLayer" | "Layer" … */
  readonly layerType?: string;
  /** "ADBE AV Layer" | "ADBE Text Layer" | "ADBE Vector Layer" | "ADBE Camera Layer" | "ADBE Light Layer" | "ADBE 3D Model Layer" … */
  readonly matchName?: string;
  /** Item id of the layer's source (footage, solid or composition). */
  readonly sourceId?: number | null;
  readonly startTime?: number;
  readonly inPoint: number;
  readonly outPoint: number;
  /** Percent; 100 = normal speed, negative = reversed. */
  readonly stretch?: number;
  readonly enabled?: boolean;
  readonly solo?: boolean;
  readonly locked?: boolean;
  readonly shy?: boolean;
  readonly audioEnabled?: boolean;
  /** AE BlendingMode enum value. */
  readonly blendingMode?: number;
  readonly threeDLayer?: boolean;
  readonly adjustmentLayer?: boolean;
  readonly nullLayer?: boolean;
  readonly guideLayer?: boolean;
  /** Index of the parent layer in the same composition. */
  readonly parentIndex?: number | null;
  /** AE TrackMatteType enum value (5012 = none). */
  readonly trackMatteType?: number;
  /** Index of the matte layer (AE 2023+ can use any layer; earlier versions use the layer above). */
  readonly trackMatteLayerIndex?: number | null;
  readonly timeRemapEnabled?: boolean;
  readonly motionBlur?: boolean;
  readonly collapseTransformation?: boolean;
  readonly frameBlending?: boolean;
  readonly label?: number;
  readonly comment?: string;
  readonly lightType?: number;
  readonly properties?: readonly AeJsonProperty[];
  readonly markers?: readonly AeJsonMarker[];
}

export interface AeJsonProperty {
  readonly matchName: string;
  readonly name?: string;
  /** "Property", or a group: "IndexedGroup" | "NamedGroup" (some exporters write "PropertyGroup"). */
  readonly propertyType?: string;
  /** AE PropertyValueType enum value (6417 = 1D, 6416 = 2D, 6413 = 3D spatial, 6418 = colour, 6423 = shape, 6424 = text document…). */
  readonly propertyValueType?: number;
  /** Static value. Shapes and text documents use the objects below. */
  readonly value?: number | readonly number[] | AeJsonShape | AeJsonTextDocument | string | boolean | null;
  readonly keyframes?: readonly AeJsonKeyframe[];
  readonly expression?: string;
  readonly expressionEnabled?: boolean;
  readonly enabled?: boolean;
  readonly dimensionsSeparated?: boolean;
  readonly isSeparationFollower?: boolean;
  readonly properties?: readonly AeJsonProperty[];
  /** Mask atoms only. */
  readonly maskMode?: number;
  readonly inverted?: boolean;
}

export interface AeJsonKeyframe {
  readonly time: number;
  readonly value: number | readonly number[] | AeJsonShape | AeJsonTextDocument | null;
  /** AE KeyframeInterpolationType: 6612 linear, 6613 bezier, 6614 hold. */
  readonly inInterpolationType?: number;
  readonly outInterpolationType?: number;
  readonly inTemporalEase?: readonly { readonly speed: number; readonly influence: number }[];
  readonly outTemporalEase?: readonly { readonly speed: number; readonly influence: number }[];
  readonly inSpatialTangent?: readonly number[];
  readonly outSpatialTangent?: readonly number[];
  readonly spatialAutoBezier?: boolean;
  readonly spatialContinuous?: boolean;
  readonly temporalAutoBezier?: boolean;
  readonly temporalContinuous?: boolean;
  readonly roving?: boolean;
}

/** A Bezier path (masks and shape-layer paths). Tangents are relative to their vertex. */
export interface AeJsonShape {
  readonly closed: boolean;
  readonly vertices: readonly (readonly number[])[];
  readonly inTangents: readonly (readonly number[])[];
  readonly outTangents: readonly (readonly number[])[];
}

export interface AeJsonTextDocument {
  readonly text: string;
  readonly font?: string;
  readonly fontFamily?: string;
  readonly fontStyle?: string;
  readonly fontSize?: number;
  readonly applyFill?: boolean;
  readonly fillColor?: readonly number[];
  readonly applyStroke?: boolean;
  readonly strokeColor?: readonly number[];
  readonly strokeWidth?: number;
  /** AE ParagraphJustification enum value (7413 left, 7414 right, 7415 center …). */
  readonly justification?: number;
  readonly tracking?: number;
  readonly leading?: number;
  readonly fauxBold?: boolean;
  readonly fauxItalic?: boolean;
  readonly allCaps?: boolean;
  readonly boxText?: boolean;
  readonly boxTextSize?: readonly number[];
}

/** AE enum values used by the importer (from the ExtendScript reference). */
export const AE = {
  interp: { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 },
  valueType: { NO_VALUE: 6412, ThreeD_SPATIAL: 6413, ThreeD: 6414, TwoD_SPATIAL: 6415, TwoD: 6416, OneD: 6417, COLOR: 6418, CUSTOM_VALUE: 6419, MARKER: 6420, LAYER_INDEX: 6421, MASK_INDEX: 6422, SHAPE: 6423, TEXT_DOCUMENT: 6424 },
  trackMatte: { NO_TRACK_MATTE: 5012, ALPHA: 5013, ALPHA_INVERTED: 5014, LUMA: 5015, LUMA_INVERTED: 5016 },
  maskMode: { NONE: 6812, ADD: 6813, SUBTRACT: 6814, INTERSECT: 6815, LIGHTEN: 6816, DARKEN: 6817, DIFFERENCE: 6818 },
  blendingMode: {
    NORMAL: 5212, DISSOLVE: 5213, DANCING_DISSOLVE: 5214, DARKEN: 5215, MULTIPLY: 5216, LINEAR_BURN: 5217, COLOR_BURN: 5218, CLASSIC_COLOR_BURN: 5219, ADD: 5220, LIGHTEN: 5221, SCREEN: 5222,
    LINEAR_DODGE: 5223, COLOR_DODGE: 5224, CLASSIC_COLOR_DODGE: 5225, OVERLAY: 5226, SOFT_LIGHT: 5227, HARD_LIGHT: 5228, LINEAR_LIGHT: 5229, VIVID_LIGHT: 5230, PIN_LIGHT: 5231, HARD_MIX: 5232,
    DIFFERENCE: 5233, CLASSIC_DIFFERENCE: 5234, EXCLUSION: 5235, HUE: 5236, SATURATION: 5237, COLOR: 5238, LUMINOSITY: 5239, STENCIL_ALPHA: 5240, STENCIL_LUMA: 5241, SILHOUETE_ALPHA: 5242,
    SILHOUETTE_LUMA: 5243, ALPHA_ADD: 5244, LUMINESCENT_PREMUL: 5245, LIGHTER_COLOR: 5246,
  },
  lightType: { PARALLEL: 4412, SPOT: 4413, POINT: 4414, AMBIENT: 4415, ENVIRONMENT: 4416 },
  justification: { LEFT_JUSTIFY: 7413, RIGHT_JUSTIFY: 7414, CENTER_JUSTIFY: 7415, FULL_JUSTIFY_LASTLINE_LEFT: 7416, FULL_JUSTIFY_LASTLINE_RIGHT: 7417, FULL_JUSTIFY_LASTLINE_CENTER: 7418, FULL_JUSTIFY_LASTLINE_FULL: 7419 },
} as const;
