/** The open models house detection uses, and whether they're on this computer yet. */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export interface DetectModel {
  readonly id: string;
  readonly role: string;
  readonly license: string;
  readonly dtype: "q8" | "fp32";
  readonly files: readonly string[];
  /** Approximate download size in MB. */
  readonly sizeMB: number;
}

export const DETECT_MODELS: readonly DetectModel[] = [
  {
    id: "onnx-community/grounding-dino-tiny-ONNX",
    role: "Finds windows, doors, garage doors, roofs and other parts from their names (Grounding DINO, quantized)",
    license: "Apache-2.0",
    dtype: "q8",
    files: ["config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"],
    sizeMB: 196,
  },
  {
    id: "Xenova/slimsam-77-uniform",
    role: "Traces the outline of each part and of the whole house (SlimSAM, a compact Segment Anything)",
    license: "Apache-2.0",
    dtype: "fp32",
    files: ["config.json", "preprocessor_config.json", "onnx/vision_encoder.onnx", "onnx/prompt_encoder_mask_decoder.onnx"],
    sizeMB: 39,
  },
];

export const modelsMissing = (cacheDir: string): DetectModel[] => DETECT_MODELS.filter((m) => m.files.some((f) => !existsSync(join(cacheDir, m.id, f)) || statSync(join(cacheDir, m.id, f)).size === 0));
