import { afterEach, describe, expect, it, vi } from "vitest";
import { createVisionModelClient } from "./vision-model-client";
import { VISION_MODEL_MANIFEST, type VisionModelRequest, type VisionModelResponse } from "./vision-model";

class ModelWorker extends EventTarget {
  messages: VisionModelRequest[] = [];
  terminate = vi.fn();
  postMessage = vi.fn((message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) => {
    void transfer;
    this.messages.push(message as VisionModelRequest);
  });
  respond(message: Omit<Extract<VisionModelResponse, { type: "ready" }>, "requestId" | "context"> | Omit<Extract<VisionModelResponse, { type: "error" }>, "requestId" | "context">, context = this.messages.at(-1)!.context) {
    this.dispatchEvent(new MessageEvent("message", { data: { ...message, requestId: this.messages.at(-1)!.requestId, context } }));
  }
}

function bitmap() { return { width: 300, height: 200, close: vi.fn() } as unknown as ImageBitmap; }
const context = { runId: "vision-run-1", generation: 2 };

afterEach(() => vi.useRealTimers());

describe("local vision model worker client", () => {
  it("does not load resources until explicitly requested and rejects stale run replies", async () => {
    const worker = new ModelWorker();
    const client = createVisionModelClient({ context, workerFactory: () => worker });
    expect(worker.messages).toHaveLength(0);
    let completed = false;
    const pending = client.load().then((value) => { completed = true; return value; });
    expect(worker.messages[0]).toMatchObject({ type: "load", context });
    worker.respond({ type: "ready", manifest: VISION_MODEL_MANIFEST }, { ...context, generation: 1 });
    worker.respond({ type: "ready", manifest: VISION_MODEL_MANIFEST }, { ...context, runId: "previous-run" });
    await Promise.resolve();
    expect(completed).toBe(false);
    worker.respond({ type: "ready", manifest: VISION_MODEL_MANIFEST });
    await expect(pending).resolves.toMatchObject({ id: "Xenova/dinov2-small", backend: "wasm" });
    client.dispose();
  });

  it("limits analysis to one in-flight frame and closes rejected image bitmaps", async () => {
    const worker = new ModelWorker();
    const client = createVisionModelClient({ context, workerFactory: () => worker });
    const first = bitmap();
    const pending = client.analyze(first, 1234);
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "analyze", frameTimeMs: 1234, context }), [first]);
    const rejected = bitmap();
    await expect(client.analyze(rejected, 1235)).rejects.toThrow("上一帧");
    expect(rejected.close).toHaveBeenCalledOnce();
    expect(worker.messages).toHaveLength(1);
    worker.respond({ type: "error", message: "请先设置参考目标照片" });
    await expect(pending).rejects.toThrow("参考目标");
    client.dispose();
  });

  it("terminates the worker and rejects pending work on cancellation", async () => {
    const worker = new ModelWorker();
    const client = createVisionModelClient({ context, workerFactory: () => worker });
    const pending = client.load();
    client.dispose();
    client.dispose();
    await expect(pending).rejects.toThrow("已释放");
    expect(worker.terminate).toHaveBeenCalledOnce();
    const image = bitmap();
    await expect(client.setReference(image)).rejects.toThrow("已释放");
    expect(image.close).toHaveBeenCalledOnce();
  });

  it("bounds a stuck model load and allows callers to create a fresh worker", async () => {
    vi.useFakeTimers();
    const worker = new ModelWorker();
    const client = createVisionModelClient({ context, workerFactory: () => worker });
    const rejection = expect(client.load()).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(180_000);
    await rejection;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("surfaces worker crashes rather than leaving a pending promise forever", async () => {
    const worker = new ModelWorker();
    const client = createVisionModelClient({ context, workerFactory: () => worker });
    const pending = client.load();
    worker.dispatchEvent(new Event("error"));
    await expect(pending).rejects.toThrow("线程已中断");
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
