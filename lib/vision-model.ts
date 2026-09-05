export const VISION_MODEL_MANIFEST = Object.freeze({
  id: "Xenova/dinov2-small",
  revision: "c2bb04a51fab207c420665f1946016107bffc701",
  name: "DINOv2-small · 本地参考特征匹配",
  task: "reference_similarity" as const,
  license: "Apache-2.0",
  upstream: "https://github.com/facebookresearch/dinov2",
  modelCard: "https://huggingface.co/Xenova/dinov2-small",
  weightPath: "onnx/model_quantized.onnx",
  weightBytes: 24_451_943,
  // Published LFS digest; this is resource provenance, not a claim of a runtime integrity check.
  weightsSha256: "3afdc8bc63b50558d6e5770f5b799bb82455c2311183a2de43803f343a29d917",
  runtime: "@huggingface/transformers@3.8.1",
  runtimeAssetBase: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/",
  device: "wasm" as const,
  backend: "wasm" as const,
  dtype: "q8" as const,
  inputSize: 224,
  patchSize: 14,
  featureDimensions: 384,
});

export const VISION_WEBGPU_MODEL_MANIFEST = Object.freeze({
  ...VISION_MODEL_MANIFEST,
  weightPath: "onnx/model_fp16.onnx",
  weightBytes: 44_427_534,
  weightsSha256: "4e9ea6fe106e2225e28ee3c1c3d53b5b92aa4af62142f6ed6b66b6a92213cf04",
  device: "webgpu" as const,
  backend: "webgpu" as const,
  dtype: "fp16" as const,
});

export type VisionModelManifest = Readonly<(typeof VISION_MODEL_MANIFEST | typeof VISION_WEBGPU_MODEL_MANIFEST) & { fallbackReason?: string }>;
export interface VisionModelLoadOptions { devicePreference?: "auto" | "wasm" }

export function isVisionModelManifest(value: unknown): value is VisionModelManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Record<string, unknown>;
  const expected = manifest.backend === "webgpu" ? VISION_WEBGPU_MODEL_MANIFEST : VISION_MODEL_MANIFEST;
  return Object.entries(expected).every(([key, expectedValue]) => manifest[key] === expectedValue)
    && (manifest.fallbackReason === undefined || (typeof manifest.fallbackReason === "string" && manifest.fallbackReason.trim().length > 0 && manifest.fallbackReason.length <= 500));
}

export interface VisionModelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisionModelCandidate {
  box: VisionModelBox;
  /** Cosine feature similarity, not a calibrated probability or crossing confidence. */
  similarity: number;
}

export interface VisionModelFrameResult {
  frameTimeMs: number;
  candidates: VisionModelCandidate[];
  inferenceMs: number;
  modelId: string;
  modelRevision: string;
  diagnostics?: {
    preprocessMs: number;
    modelMs: number;
    matchingMs: number;
    /** Best observed window before the cosine threshold; not an accepted crossing. */
    bestMatch: VisionModelCandidate | null;
  };
}

export interface VisionModelProgress {
  status: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

export interface VisionModelContext {
  runId: string;
  generation: number;
}

export type VisionModelRequest = (
  | { requestId: number; type: "load"; options?: VisionModelLoadOptions }
  | { requestId: number; type: "reference"; image: ImageBitmap }
  | { requestId: number; type: "analyze"; image: ImageBitmap; frameTimeMs: number; threshold: number }
) & { context: VisionModelContext };

export type VisionModelResponse = (
  | { requestId: number; type: "progress"; progress: VisionModelProgress }
  | { requestId: number; type: "ready"; manifest: VisionModelManifest }
  | { requestId: number; type: "reference"; width: number; height: number }
  | { requestId: number; type: "result"; result: VisionModelFrameResult }
  | { requestId: number; type: "error"; message: string }
) & { context: VisionModelContext };
