import { AutoModel, Tensor, env, type PreTrainedModel } from "@huggingface/transformers";
import { VISION_MODEL_MANIFEST, type VisionModelContext, type VisionModelManifest, type VisionModelRequest, type VisionModelResponse } from "../lib/vision-model";
import { loadVisionModel } from "../lib/vision-model-loader";
import { createVisionPatchGrid, createVisionReference, matchVisionModel, visionLetterbox, type VisionReferenceFeatures } from "../lib/vision-model-matching";

const scope = self as unknown as { onmessage: ((event: MessageEvent<VisionModelRequest>) => void) | null; postMessage(message: VisionModelResponse): void };
let model: PreTrainedModel | null = null;
let reference: VisionReferenceFeatures | null = null;
let busy = false;
let context: VisionModelContext | null = null;
let manifest: VisionModelManifest | null = null;
let loadedPreference: "auto" | "wasm" | null = null;

async function extractFeatures(image: ImageBitmap) {
  if (!model) throw new Error("请先加载本地模型");
  if (image.width < 1 || image.height < 1) throw new Error("图像为空或已释放");
  const started = performance.now();
  const size = VISION_MODEL_MANIFEST.inputSize;
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("浏览器无法创建本地图像画布");
  const box = visionLetterbox(image.width, image.height);
  context.fillStyle = "rgb(124,116,104)";
  context.fillRect(0, 0, size, size);
  context.drawImage(image, box.x * size, box.y * size, box.width * size, box.height * size);
  const rgba = context.getImageData(0, 0, size, size).data;
  const values = new Float32Array(3 * size * size);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let pixel = 0; pixel < size * size; pixel += 1) for (let channel = 0; channel < 3; channel += 1) {
    values[channel * size * size + pixel] = (rgba[pixel * 4 + channel] / 255 - mean[channel]) / std[channel];
  }
  const input = new Tensor("float32", values, [1, 3, size, size]);
  const preprocessedAt = performance.now();
  let output: Record<string, unknown> | null = null;
  try {
    output = await model({ pixel_values: input });
    const inferredAt = performance.now();
    if (!output) throw new Error("模型没有返回结果");
    const hidden = output.last_hidden_state;
    if (!(hidden instanceof Tensor) || hidden.type !== "float32" || hidden.dims[1] !== (size / VISION_MODEL_MANIFEST.patchSize) ** 2 + 1 || hidden.dims[2] !== VISION_MODEL_MANIFEST.featureDimensions) throw new Error("模型未返回所需局部特征");
    return { grid: createVisionPatchGrid(hidden.data as Float32Array, hidden.dims, image.width, image.height), preprocessMs: preprocessedAt - started, modelMs: inferredAt - preprocessedAt };
  } finally {
    input.dispose();
    if (output) for (const value of Object.values(output)) if (value instanceof Tensor) value.dispose();
  }
}

scope.onmessage = (event) => {
  const request = event.data;
  if (busy) {
    if ("image" in request) request.image.close();
    scope.postMessage({ type: "error", requestId: request.requestId, context: request.context, message: "本地模型忙碌，未接收积压帧" });
    return;
  }
  busy = true;
  void (async () => {
    try {
      if (!request.context?.runId.trim() || !Number.isInteger(request.context.generation) || request.context.generation < 0) throw new Error("模型分析任务标识无效");
      if (context && (context.runId !== request.context.runId || context.generation !== request.context.generation)) throw new Error("已拒绝其他任务或过期任务的图像");
      context ??= { ...request.context };
      if (request.type === "load") {
        const preference = request.options?.devicePreference ?? "wasm";
        if (model && loadedPreference !== preference) throw new Error("本次模型运行方式已固定，请重新开始分析以切换");
        if (!model) {
          env.allowLocalModels = false;
          env.allowRemoteModels = true;
          env.useBrowserCache = true;
          env.backends.onnx.wasm!.numThreads = 1;
          env.backends.onnx.wasm!.proxy = false;
          env.backends.onnx.wasm!.wasmPaths = VISION_MODEL_MANIFEST.runtimeAssetBase;
          const loaded = await loadVisionModel(request.options, {
            probeWebGpu: async () => {
              const adapter = await navigator.gpu?.requestAdapter();
              return { available: !!adapter, fp16: adapter?.features.has("shader-f16") ?? false };
            },
            loadModel: (selected) => AutoModel.from_pretrained(selected.id, {
              revision: selected.revision,
              device: selected.device,
              dtype: selected.dtype,
              progress_callback: (progress) => scope.postMessage({ type: "progress", requestId: request.requestId, context: request.context, progress }),
            }),
          });
          model = loaded.model;
          manifest = loaded.manifest;
          loadedPreference = preference;
        }
        if (!manifest) throw new Error("本地模型运行来源信息缺失");
        scope.postMessage({ type: "ready", requestId: request.requestId, context: request.context, manifest });
      } else if (request.type === "reference") {
        const features = await extractFeatures(request.image);
        reference = createVisionReference(features.grid);
        scope.postMessage({ type: "reference", requestId: request.requestId, context: request.context, width: request.image.width, height: request.image.height });
      } else {
        if (!reference) throw new Error("请先设置参考目标照片");
        if (!Number.isFinite(request.frameTimeMs) || request.frameTimeMs < 0) throw new Error("视频帧时间戳无效");
        const started = performance.now();
        const features = await extractFeatures(request.image);
        const matchingAt = performance.now();
        const { candidates, bestMatch } = matchVisionModel(reference, features.grid, request.threshold);
        const finishedAt = performance.now();
        scope.postMessage({
          type: "result", requestId: request.requestId, context: request.context,
          result: { frameTimeMs: request.frameTimeMs, candidates, inferenceMs: finishedAt - started, modelId: VISION_MODEL_MANIFEST.id, modelRevision: VISION_MODEL_MANIFEST.revision,
            diagnostics: { preprocessMs: features.preprocessMs, modelMs: features.modelMs, matchingMs: finishedAt - matchingAt, bestMatch } },
        });
      }
    } catch (error) {
      scope.postMessage({ type: "error", requestId: request.requestId, context: request.context, message: error instanceof Error ? error.message : "本地模型执行失败" });
    } finally {
      if ("image" in request) request.image.close();
      busy = false;
    }
  })();
};
