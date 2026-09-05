import { describe, expect, it, vi } from "vitest";
import { loadVisionModel } from "./vision-model-loader";
import { isVisionModelManifest, VISION_MODEL_MANIFEST, VISION_WEBGPU_MODEL_MANIFEST } from "./vision-model";

describe("vision model startup backend selection", () => {
  it("keeps offline/default loads on q8 without probing or downloading GPU weights", async () => {
    const model = { loaded: true };
    const probeWebGpu = vi.fn();
    const loadModel = vi.fn().mockResolvedValue(model);
    for (const options of [undefined, { devicePreference: "wasm" as const }]) {
      const result = await loadVisionModel(options, { probeWebGpu, loadModel });
      expect(result).toEqual({ model, manifest: VISION_MODEL_MANIFEST });
    }
    expect(probeWebGpu).not.toHaveBeenCalled();
    expect(loadModel).toHaveBeenCalledTimes(2);
    expect(loadModel).toHaveBeenLastCalledWith(VISION_MODEL_MANIFEST);
  });

  it("returns the actual FP16 resource receipt when WebGPU loading succeeds", async () => {
    const loadModel = vi.fn().mockResolvedValue({ backend: "gpu" });
    const result = await loadVisionModel({ devicePreference: "auto" }, { probeWebGpu: async () => ({ available: true, fp16: true }), loadModel });
    expect(loadModel).toHaveBeenCalledExactlyOnceWith(VISION_WEBGPU_MODEL_MANIFEST);
    expect(result.manifest).toMatchObject({ backend: "webgpu", device: "webgpu", dtype: "fp16", weightPath: "onnx/model_fp16.onnx", weightBytes: 44_427_534, weightsSha256: "4e9ea6fe106e2225e28ee3c1c3d53b5b92aa4af62142f6ed6b66b6a92213cf04" });
    expect(result.manifest.fallbackReason).toBeUndefined();
    expect(Object.isFrozen(result.manifest)).toBe(true);
  });

  it.each([
    [{ available: false, fp16: false }, "未提供"],
    [{ available: true, fp16: false }, "半精度"],
  ])("uses only q8 when GPU capabilities are insufficient (%j)", async (capabilities, reason) => {
    const loadModel = vi.fn().mockResolvedValue({});
    const result = await loadVisionModel({ devicePreference: "auto" }, { probeWebGpu: async () => capabilities, loadModel });
    expect(loadModel).toHaveBeenCalledTimes(1);
    expect(result.manifest).toMatchObject({ backend: "wasm", dtype: "q8", weightsSha256: VISION_MODEL_MANIFEST.weightsSha256, fallbackReason: expect.stringContaining(reason) });
    expect(Object.isFrozen(result.manifest)).toBe(true);
  });

  it("records fallback after a GPU initialization failure without retaining its provenance", async () => {
    const loadModel = vi.fn().mockRejectedValueOnce(new Error("GPU init failed")).mockResolvedValueOnce({ backend: "cpu" });
    const result = await loadVisionModel({ devicePreference: "auto" }, { probeWebGpu: async () => ({ available: true, fp16: true }), loadModel });
    expect(loadModel.mock.calls.map(([manifest]) => manifest.backend)).toEqual(["webgpu", "wasm"]);
    expect(result.manifest).toMatchObject({ ...VISION_MODEL_MANIFEST, fallbackReason: expect.stringContaining("GPU 模型加载失败") });
  });

  it("bounds fallback to one CPU attempt and surfaces a failed fallback", async () => {
    const loadModel = vi.fn().mockRejectedValueOnce(new Error("gpu failed")).mockRejectedValueOnce(new Error("cpu failed"));
    await expect(loadVisionModel({ devicePreference: "auto" }, { probeWebGpu: async () => ({ available: true, fp16: true }), loadModel })).rejects.toThrow("cpu failed");
    expect(loadModel).toHaveBeenCalledTimes(2);
  });

  it("handles capability probe rejection without misreporting a GPU load", async () => {
    const loadModel = vi.fn().mockResolvedValue({});
    const result = await loadVisionModel({ devicePreference: "auto" }, { probeWebGpu: async () => { throw new Error("probe blocked"); }, loadModel });
    expect(loadModel).toHaveBeenCalledTimes(1);
    expect(result.manifest.fallbackReason).toContain("无法检查");
    expect(result.manifest.backend).toBe("wasm");
  });

  it("rejects mismatched backend, dtype and weight identity while accepting both real manifests", () => {
    expect(isVisionModelManifest(VISION_MODEL_MANIFEST)).toBe(true);
    expect(isVisionModelManifest(VISION_WEBGPU_MODEL_MANIFEST)).toBe(true);
    expect(isVisionModelManifest({ ...VISION_MODEL_MANIFEST, backend: "webgpu" })).toBe(false);
    expect(isVisionModelManifest({ ...VISION_WEBGPU_MODEL_MANIFEST, weightsSha256: VISION_MODEL_MANIFEST.weightsSha256 })).toBe(false);
    expect(isVisionModelManifest({ ...VISION_MODEL_MANIFEST, fallbackReason: "" })).toBe(false);
  });
});
