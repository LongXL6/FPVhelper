import { VISION_MODEL_MANIFEST, VISION_WEBGPU_MODEL_MANIFEST, type VisionModelLoadOptions, type VisionModelManifest } from "./vision-model";

/** Select once at startup. Inference errors must not silently change this provenance. */
export async function loadVisionModel<T>(options: VisionModelLoadOptions | undefined, {
  probeWebGpu,
  loadModel,
}: {
  probeWebGpu: () => Promise<{ available: boolean; fp16: boolean }>;
  loadModel: (manifest: VisionModelManifest) => Promise<T>;
}): Promise<{ model: T; manifest: VisionModelManifest }> {
  const preference = options?.devicePreference ?? "wasm";
  if (preference !== "auto" && preference !== "wasm") throw new Error("本地模型运行方式无效");
  let fallbackReason: string | undefined;
  if (preference === "auto") {
    let capabilities: { available: boolean; fp16: boolean } | null = null;
    try { capabilities = await probeWebGpu(); }
    catch { fallbackReason = "无法检查 GPU 能力，已使用兼容 CPU 模式"; }
    if (capabilities) {
      if (!capabilities.available) fallbackReason = "浏览器未提供可用 WebGPU，已使用兼容 CPU 模式";
      else if (!capabilities.fp16) fallbackReason = "GPU 不支持所需半精度运算，已使用兼容 CPU 模式";
      else {
        try {
          return { model: await loadModel(VISION_WEBGPU_MODEL_MANIFEST), manifest: VISION_WEBGPU_MODEL_MANIFEST };
        } catch { fallbackReason = "GPU 模型加载失败，已使用兼容 CPU 模式"; }
      }
    }
  }
  const manifest = fallbackReason ? Object.freeze({ ...VISION_MODEL_MANIFEST, fallbackReason }) : VISION_MODEL_MANIFEST;
  // A failed CPU fallback is still a failure, never a successful model receipt.
  return { model: await loadModel(manifest), manifest };
}
