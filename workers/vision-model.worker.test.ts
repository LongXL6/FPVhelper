import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VISION_MODEL_MANIFEST, VISION_WEBGPU_MODEL_MANIFEST, type VisionModelResponse } from "../lib/vision-model";

const mocks = vi.hoisted(() => {
  class Tensor {
    dispose = vi.fn();
    constructor(public type: string, public data: Float32Array, public dims: number[]) {}
  }
  return { Tensor, load: vi.fn(), infer: vi.fn(), dispose: vi.fn() };
});
vi.mock("@huggingface/transformers", () => ({
  Tensor: mocks.Tensor,
  AutoModel: { from_pretrained: mocks.load },
  env: { backends: { onnx: { wasm: {} } } },
}));

const context = { runId: "worker-test", generation: 1 };
let requestId = 0;
let scope: { postMessage: ReturnType<typeof vi.fn>; onmessage: ((event: { data: unknown }) => void) | null };

function features(dimension: number) {
  const data = new Float32Array(257 * 384);
  for (let patch = 1; patch < 257; patch++) data[patch * 384 + dimension] = 1;
  return { last_hidden_state: new mocks.Tensor("float32", data, [1, 257, 384]) };
}

function bitmap() { return { width: 640, height: 360, close: vi.fn() }; }

async function send(request: Record<string, unknown>) {
  const id = ++requestId;
  scope.onmessage!({ data: { ...request, requestId: id, context } });
  let response: VisionModelResponse | undefined;
  await vi.waitFor(() => {
    response = scope.postMessage.mock.calls.map(([message]) => message as VisionModelResponse).find(message => message.requestId === id && message.type !== "progress");
    expect(response).toBeDefined();
  });
  return response!;
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  requestId = 0;
  scope = { postMessage: vi.fn(), onmessage: null };
  vi.stubGlobal("self", scope);
  vi.stubGlobal("navigator", { gpu: { requestAdapter: vi.fn().mockResolvedValue({ features: new Set(["shader-f16"]) }) } });
  vi.stubGlobal("OffscreenCanvas", class {
    getContext() { return { fillStyle: "", fillRect() {}, drawImage() {}, getImageData() { return { data: new Uint8ClampedArray(224 * 224 * 4) }; } }; }
  });
  mocks.infer.mockReset().mockImplementation(async () => features(0));
  mocks.load.mockReset().mockResolvedValue(Object.assign(mocks.infer, { dispose: mocks.dispose }));
  await import("./vision-model.worker");
});
afterEach(() => vi.unstubAllGlobals());

describe("vision model Worker execution provenance", () => {
  it("loads only on request and refuses to change a loaded backend preference", async () => {
    expect(mocks.load).not.toHaveBeenCalled();
    expect(await send({ type: "load", options: { devicePreference: "auto" } })).toMatchObject({ type: "ready", manifest: VISION_WEBGPU_MODEL_MANIFEST });
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(VISION_MODEL_MANIFEST.id, expect.objectContaining({ device: "webgpu", dtype: "fp16", revision: VISION_MODEL_MANIFEST.revision }));
    expect(await send({ type: "load", options: { devicePreference: "wasm" } })).toMatchObject({ type: "error", message: expect.stringContaining("已固定") });
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });

  it("reports q8 and its actual resource after a failed GPU startup", async () => {
    mocks.load.mockRejectedValueOnce(new Error("GPU initialization failed"));
    expect(await send({ type: "load", options: { devicePreference: "auto" } })).toMatchObject({ type: "ready", manifest: { ...VISION_MODEL_MANIFEST, fallbackReason: expect.stringContaining("GPU 模型加载失败") } });
    expect(mocks.load.mock.calls.map(([, options]) => options.device)).toEqual(["webgpu", "wasm"]);
  });

  it("returns timings and a below-threshold best window while keeping accepted candidates empty", async () => {
    await send({ type: "load" });
    const reference = bitmap();
    await send({ type: "reference", image: reference });
    mocks.infer.mockResolvedValueOnce(features(1));
    const frame = bitmap();
    const response = await send({ type: "analyze", image: frame, frameTimeMs: 1234, threshold: .65 });
    expect(response.type).toBe("result");
    if (response.type !== "result") throw new Error("Expected model result");
    expect(response.result.candidates).toEqual([]);
    expect(response.result.frameTimeMs).toBe(1234);
    expect(response.result.diagnostics!.bestMatch?.similarity).toBe(0);
    for (const key of ["preprocessMs", "modelMs", "matchingMs"] as const) {
      expect(response.result.diagnostics![key]).toBeGreaterThanOrEqual(0);
      expect(response.result.diagnostics![key]).toBeLessThanOrEqual(response.result.inferenceMs);
    }
    const box = response.result.diagnostics!.bestMatch!.box;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1);
    expect(box.y + box.height).toBeLessThanOrEqual(1);
    expect(reference.close).toHaveBeenCalledOnce();
    expect(frame.close).toHaveBeenCalledOnce();
  });

  it("surfaces an inference failure without silently loading another backend", async () => {
    await send({ type: "load", options: { devicePreference: "auto" } });
    await send({ type: "reference", image: bitmap() });
    mocks.infer.mockRejectedValueOnce(new Error("GPU device lost during inference"));
    const frame = bitmap();
    expect(await send({ type: "analyze", image: frame, frameTimeMs: 100, threshold: .65 })).toMatchObject({ type: "error", message: "GPU device lost during inference" });
    expect(frame.close).toHaveBeenCalledOnce();
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(await send({ type: "load", options: { devicePreference: "auto" } })).toMatchObject({ type: "ready", manifest: VISION_WEBGPU_MODEL_MANIFEST });
  });
});
