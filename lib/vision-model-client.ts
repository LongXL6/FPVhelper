import { isVisionModelManifest, type VisionModelContext, type VisionModelFrameResult, type VisionModelLoadOptions, type VisionModelManifest, type VisionModelProgress, type VisionModelRequest, type VisionModelResponse } from "./vision-model";

type ModelWorker = Pick<Worker, "addEventListener" | "removeEventListener" | "postMessage" | "terminate">;
type ResponsePayload = VisionModelManifest | { width: number; height: number } | VisionModelFrameResult;

export function createVisionModelClient({ context, onProgress, workerFactory }: {
  context: VisionModelContext;
  onProgress?: (progress: VisionModelProgress) => void;
  workerFactory?: () => ModelWorker;
}) {
  if (!context.runId.trim() || !Number.isInteger(context.generation) || context.generation < 0) throw new Error("模型分析任务标识无效");
  const requestContext = { ...context };
  const worker = workerFactory ? workerFactory() : new Worker(new URL("../workers/vision-model.worker.ts", import.meta.url), { type: "module" });
  let disposed = false;
  let nextRequestId = 0;
  let pending: { requestId: number; type: VisionModelRequest["type"]; resolve: (value: ResponsePayload) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> } | null = null;

  function disposeWithError(error: Error) {
    if (disposed) return;
    disposed = true;
    worker.removeEventListener("message", handleMessage);
    worker.removeEventListener("error", handleError);
    worker.terminate();
    if (pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      pending = null;
    }
  }

  function handleError() { disposeWithError(new Error("本地模型工作线程已中断，请重新加载模型")); }

  function handleMessage(event: Event) {
    const response = (event as MessageEvent<VisionModelResponse>).data;
    const current = pending;
    if (disposed || !current || response.requestId !== current.requestId || response.context?.runId !== requestContext.runId || response.context?.generation !== requestContext.generation) return;
    if (response.type === "progress") {
      onProgress?.(response.progress);
      return;
    }
    clearTimeout(current.timeout);
    pending = null;
    if (response.type === "error") current.reject(new Error(response.message));
    else if (response.type === "ready" && current.type === "load") {
      if (!isVisionModelManifest(response.manifest)) current.reject(new Error("本地模型返回了无效的运行来源信息"));
      else current.resolve(Object.freeze({ ...response.manifest }));
    }
    else if (response.type === "reference" && current.type === "reference") current.resolve({ width: response.width, height: response.height });
    else if (response.type === "result" && current.type === "analyze") current.resolve(response.result);
    else current.reject(new Error("本地模型返回了不匹配的结果"));
  }

  worker.addEventListener("message", handleMessage);
  worker.addEventListener("error", handleError);

  function request<T extends ResponsePayload>(message: Omit<Extract<VisionModelRequest, { type: "load" }>, "requestId" | "context"> | Omit<Extract<VisionModelRequest, { type: "reference" }>, "requestId" | "context"> | Omit<Extract<VisionModelRequest, { type: "analyze" }>, "requestId" | "context">): Promise<T> {
    if (disposed || pending) {
      if ("image" in message) message.image.close();
      return Promise.reject(new Error(disposed ? "本地模型已释放" : "上一帧仍在分析，请等待完成"));
    }
    const requestId = ++nextRequestId;
    return new Promise<T>((resolve, reject) => {
      pending = {
        requestId, type: message.type, resolve: (value) => resolve(value as T), reject,
        timeout: setTimeout(() => disposeWithError(new Error(message.type === "load" ? "模型下载或初始化超时，请检查模型资源连接后重试" : "本地模型分析超时，请重新加载模型")), message.type === "load" ? 180_000 : 60_000),
      };
      try {
        worker.postMessage({ ...message, requestId, context: requestContext } satisfies VisionModelRequest, "image" in message ? [message.image] : []);
      } catch (error) {
        if ("image" in message) message.image.close();
        if (pending) clearTimeout(pending.timeout);
        pending = null;
        reject(error instanceof Error ? error : new Error("图像无法传递到本地模型"));
      }
    });
  }

  return {
    load: (options?: VisionModelLoadOptions) => request<VisionModelManifest>({ type: "load", ...(options ? { options } : {}) }),
    /** The client owns and closes the supplied bitmap, including rejected requests. */
    setReference: (image: ImageBitmap) => request<{ width: number; height: number }>({ type: "reference", image }),
    analyze: (image: ImageBitmap, frameTimeMs: number, threshold = 0.55) => request<VisionModelFrameResult>({ type: "analyze", image, frameTimeMs, threshold }),
    dispose: () => disposeWithError(new Error("本地模型已释放")),
  };
}
