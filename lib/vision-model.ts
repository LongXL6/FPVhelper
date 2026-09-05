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

export type VisionModelManifest = typeof VISION_MODEL_MANIFEST;

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
  | { requestId: number; type: "load" }
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
