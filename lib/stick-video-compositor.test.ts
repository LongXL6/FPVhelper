import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drawStickVideoOverlay, startStickVideoCompositor } from "./stick-video-compositor";
import type { FlightTelemetry } from "./telemetry";

class FakeTrack extends EventTarget {
  readyState: MediaStreamTrackState = "live";
  stop = vi.fn(() => { this.readyState = "ended"; });
  end() { this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
}

class FakeVideo extends EventTarget {
  videoWidth = 1280;
  videoHeight = 720;
  readyState = 2;
  currentTime = 0;
  muted = false;
  playsInline = false;
  autoplay = false;
  srcObject: MediaStream | null = null;
  error: { message: string } | null = null;
  play = vi.fn(async () => undefined);
  pause = vi.fn();
  callbacks = new Map<number, VideoFrameRequestCallback>();
  nextId = 1;
  requestVideoFrameCallback = vi.fn((callback: VideoFrameRequestCallback) => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  });
  cancelVideoFrameCallback = vi.fn((id: number) => this.callbacks.delete(id));
  emitFrame() {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach((callback) => callback(performance.now(), {} as VideoFrameCallbackMetadata));
  }
}

function makeContext() {
  return {
    save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(),
    drawImage: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
    lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(),
    fillStyle: "", strokeStyle: "", font: "", lineWidth: 1, textBaseline: "middle", textAlign: "left",
  };
}

function makeTelemetry(patch: Partial<FlightTelemetry> = {}): FlightTelemetry {
  return {
    timestamp: 1_700_000_000_000, monotonicTimestampMs: 0, sequence: 1,
    rollStickPercent: 0, pitchStickPercent: 0, yawStickPercent: 0, throttleStickPercent: 50,
    rcThrottleUs: 1500, rcChannelsUs: [1500, 1500, 1500, 1500],
    groundMspRssiPercent: null, groundBridgeVoltage: null, ...patch,
  };
}

function setup() {
  const video = new FakeVideo();
  const sourceTrack = new FakeTrack();
  const outputTrack = new FakeTrack();
  const sourceStream = { getVideoTracks: () => [sourceTrack], getTracks: () => [sourceTrack] } as unknown as MediaStream;
  const outputStream = { getVideoTracks: () => [outputTrack], getTracks: () => [outputTrack] } as unknown as MediaStream;
  const context = makeContext();
  const canvas = {
    width: 0, height: 0,
    getContext: vi.fn(() => context),
    captureStream: vi.fn(() => outputStream),
  };
  const createElement = vi.fn((tag: string) => tag === "video" ? video : canvas);
  vi.stubGlobal("document", { createElement });
  const options = { sourceStream, frameRate: 30, getTelemetry: () => makeTelemetry(), athleteCode: "PILOT-07" };
  return { video, sourceTrack, outputTrack, sourceStream, outputStream, context, canvas, createElement, options };
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("burned-in stick video compositor", () => {
  it("preserves width-relative sizing and dock spacing for a tall coach preview", () => {
    const context = makeContext();
    drawStickVideoOverlay(context as unknown as CanvasRenderingContext2D, {
      width: 1280, height: 720, telemetry: makeTelemetry(), athleteCode: "07",
      appearance: {
        pair: { left: { xPercent: 10, yPercent: 20, size: 72 }, right: { xPercent: 21.25, yPercent: 20, size: 72 }, docked: true, locked: true },
        stageWidth: 640, stageHeight: 800, opacity: 1, mode: "simple",
      },
    });
    expect(context.fillRect).toHaveBeenCalledWith(128, 144, 144, 144);
    expect(context.fillRect).toHaveBeenCalledWith(272, 144, 144, 144);
  });

  it("scales the preview layout into the recording and reads updated size, position and opacity on subsequent frames", async () => {
    const { options, video, context } = setup();
    let appearance = {
      pair: { left: { xPercent: 10, yPercent: 20, size: 72 }, right: { xPercent: 50, yPercent: 20, size: 180 }, docked: false, locked: false },
      stageWidth: 640, stageHeight: 360, opacity: 0.5, mode: "trail" as const,
    };
    const alpha = vi.fn();
    Object.defineProperty(context, "globalAlpha", { set: alpha });
    const result = await startStickVideoCompositor({ ...options, getOverlayAppearance: () => appearance });
    expect(context.fillRect).toHaveBeenCalledWith(128, 144, 144, 144);
    expect(context.fillRect).toHaveBeenCalledWith(640, 144, 360, 360);
    expect(context.strokeRect).toHaveBeenCalledWith(162, 188, 76, 76);
    expect(alpha).toHaveBeenLastCalledWith(0.5);
    appearance = { ...appearance, opacity: 0.3, pair: { ...appearance.pair, left: { xPercent: 5, yPercent: 10, size: 100 } } };
    context.fillRect.mockClear();
    video.currentTime = 0.1;
    await vi.advanceTimersByTimeAsync(100);
    expect(context.fillRect).toHaveBeenCalledWith(64, 72, 200, 200);
    expect(alpha).toHaveBeenLastCalledWith(0.3);
    result.dispose();
  });

  it("records the actual crop with an independent video and canvas without stopping the borrowed camera", async () => {
    const { options, video, context, canvas, sourceStream, sourceTrack, outputTrack, outputStream } = setup();
    const result = await startStickVideoCompositor({ ...options, crop: { xPercent: 50, yPercent: 0, widthPercent: 50, heightPercent: 50 } });
    expect(video.srcObject).toBe(sourceStream);
    expect(video.muted && video.playsInline).toBe(true);
    expect(context.drawImage).toHaveBeenCalledWith(video, 640, 0, 640, 360, 0, 0, 640, 360);
    expect(canvas.captureStream).toHaveBeenCalledWith(30);
    expect(result).toMatchObject({ stream: outputStream, width: 640, height: 360 });
    result.dispose();
    result.dispose();
    expect(video.srcObject).toBeNull();
    expect(video.pause).toHaveBeenCalledOnce();
    expect(outputTrack.stop).toHaveBeenCalledOnce();
    expect(sourceTrack.stop).not.toHaveBeenCalled();
    expect(video.callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads the latest sample and continues drawing when hidden-video frame callbacks stop", async () => {
    const { options, video, context } = setup();
    let telemetry = makeTelemetry();
    const result = await startStickVideoCompositor({ ...options, getTelemetry: () => telemetry, getConnection: () => "live", getLinkState: () => "ok" });
    context.fillText.mockClear();
    context.drawImage.mockClear();
    telemetry = makeTelemetry({ sequence: 25, rollStickPercent: 75, pitchStickPercent: -25, throttleStickPercent: 20 });
    video.currentTime = 0.1;
    await vi.advanceTimersByTimeAsync(100);
    expect(context.drawImage.mock.calls.length).toBeGreaterThan(0);
    expect(context.drawImage.mock.calls.length).toBeLessThanOrEqual(3);
    const texts = context.fillText.mock.calls.map(([text]) => text);
    expect(texts).toContain("ROLL +750");
    expect(texts).toContain("PITCH -250");
    expect(texts).toContain("THR -600");
    expect(texts).toContain("THR 20%");
    expect(texts).toContain("RC LIVE / LINK OK");
    result.dispose();
  });

  it("bounds rendering when both frame callbacks and fallback timers fire", async () => {
    const { options, video, context } = setup();
    const result = await startStickVideoCompositor(options);
    context.drawImage.mockClear();
    for (let index = 0; index < 100; index += 1) {
      video.currentTime += 0.01;
      video.emitFrame();
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(context.drawImage.mock.calls.length).toBeGreaterThanOrEqual(25);
    expect(context.drawImage.mock.calls.length).toBeLessThanOrEqual(31);
    result.dispose();
  });

  it.each([[1920, 1080], [640, 480], [320, 240]])("keeps all four axes square with endpoint and zero ticks at %s×%s", (width, height) => {
    const context = makeContext();
    drawStickVideoOverlay(context as unknown as CanvasRenderingContext2D, {
      width, height, athleteCode: "07", telemetry: makeTelemetry({ yawStickPercent: -100, throttleStickPercent: 0, rollStickPercent: 100, pitchStickPercent: -100 }),
    });
    const grids = context.strokeRect.mock.calls as number[][];
    expect(grids).toHaveLength(2);
    for (const [x, y, gridWidth, gridHeight] of grids) {
      expect(gridWidth).toBe(gridHeight);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + gridWidth).toBeLessThanOrEqual(width);
      expect(y + gridHeight).toBeLessThanOrEqual(height);
    }
    const ticks = context.fillText.mock.calls.map(([text]) => text);
    expect(ticks.filter((text) => text === "+1000")).toHaveLength(4);
    expect(ticks.filter((text) => text === "−1000")).toHaveLength(4);
    expect(ticks.filter((text) => text === "0")).toHaveLength(4);
    expect(context.arc.mock.calls[0].slice(0, 2)).toEqual([grids[0][0], grids[0][1] + grids[0][3]]);
    expect(context.arc.mock.calls[1].slice(0, 2)).toEqual([grids[1][0] + grids[1][2], grids[1][1] + grids[1][3]]);
  });

  it("labels missing and stale telemetry instead of presenting it as a fresh live sample", () => {
    const context = makeContext();
    drawStickVideoOverlay(context as unknown as CanvasRenderingContext2D, { width: 640, height: 480, athleteCode: "07", telemetry: makeTelemetry({ sequence: 0 }) });
    expect(context.fillText.mock.calls.map(([text]) => text)).toContain("NO RC SAMPLE / LINK UNKNOWN");
    expect(context.arc).not.toHaveBeenCalled();
    drawStickVideoOverlay(context as unknown as CanvasRenderingContext2D, { width: 640, height: 480, athleteCode: "07", telemetry: makeTelemetry(), connection: "stale", linkState: "lost" });
    expect(context.fillText.mock.calls.map(([text]) => text)).toContain("RC STALE / LINK LOST");
  });

  it("preserves source aspect ratio if the input changes resolution during recording", async () => {
    const { options, video, context } = setup();
    const result = await startStickVideoCompositor(options);
    video.videoWidth = 640;
    video.videoHeight = 480;
    video.currentTime = 0.05;
    await vi.advanceTimersByTimeAsync(40);
    expect(result).toMatchObject({ width: 1280, height: 720 });
    expect(context.drawImage).toHaveBeenLastCalledWith(video, 0, 0, 640, 480, 160, 0, 960, 720);
    result.dispose();
  });

  it("rejects an absent or ended source instead of creating a fake recording", async () => {
    const { options, sourceTrack, createElement } = setup();
    sourceTrack.readyState = "ended";
    await expect(startStickVideoCompositor(options)).rejects.toThrow("没有可用的视频输入");
    expect(createElement).not.toHaveBeenCalled();
  });

  it("cleans up a failed play request without touching the camera", async () => {
    const { options, video, sourceTrack } = setup();
    video.play.mockRejectedValue(new Error("autoplay denied"));
    await expect(startStickVideoCompositor(options)).rejects.toThrow("autoplay denied");
    expect(video.srcObject).toBeNull();
    expect(sourceTrack.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects startup when no decoded frame arrives within the timeout", async () => {
    const { options, video } = setup();
    video.readyState = 0;
    const start = startStickVideoCompositor(options);
    const rejected = expect(start).rejects.toThrow("尚未产生可录制画面");
    await vi.advanceTimersByTimeAsync(6_000);
    await rejected;
    expect(video.srcObject).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a pending start and cannot be revived by a later video frame", async () => {
    const { options, video, canvas, sourceTrack } = setup();
    video.readyState = 0;
    const controller = new AbortController();
    const start = startStickVideoCompositor({ ...options, signal: controller.signal });
    controller.abort();
    await expect(start).rejects.toMatchObject({ name: "AbortError" });
    video.readyState = 2;
    video.dispatchEvent(new Event("loadeddata"));
    expect(canvas.captureStream).not.toHaveBeenCalled();
    expect(sourceTrack.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails startup if the source disconnects while waiting for its first frame", async () => {
    const { options, video, sourceTrack, canvas } = setup();
    video.readyState = 0;
    const start = startStickVideoCompositor(options);
    sourceTrack.end();
    await expect(start).rejects.toThrow("视频输入已断开");
    expect(canvas.captureStream).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a source disconnect exactly once and releases its output", async () => {
    const { options, sourceTrack, outputTrack } = setup();
    const onError = vi.fn();
    await startStickVideoCompositor({ ...options, onError });
    sourceTrack.end();
    sourceTrack.end();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toContain("视频输入已断开");
    expect(outputTrack.stop).toHaveBeenCalledOnce();
    expect(sourceTrack.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops a frozen video instead of silently recording its last frame indefinitely", async () => {
    const { options, outputTrack } = setup();
    const onError = vi.fn();
    await startStickVideoCompositor({ ...options, onError });
    await vi.advanceTimersByTimeAsync(5_100);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toContain("连续 5 秒未更新");
    expect(outputTrack.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries transient drawing failures but terminates sustained failures", async () => {
    const { options, context, outputTrack } = setup();
    const onError = vi.fn();
    const result = await startStickVideoCompositor({ ...options, onError });
    context.drawImage.mockImplementationOnce(() => { throw new Error("transient decode"); });
    await vi.advanceTimersByTimeAsync(100);
    expect(onError).not.toHaveBeenCalled();
    context.drawImage.mockImplementation(() => { throw new Error("GPU unavailable"); });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toBe("GPU unavailable");
    expect(outputTrack.stop).toHaveBeenCalledOnce();
    result.dispose();
  });

  it("releases a canvas stream if first-frame overlay painting fails after capture starts", async () => {
    const { options, canvas, outputTrack, sourceTrack } = setup();
    const getTelemetry = vi.fn().mockReturnValueOnce(makeTelemetry()).mockImplementation(() => { throw new Error("sample unavailable"); });
    await expect(startStickVideoCompositor({ ...options, getTelemetry })).rejects.toThrow("sample unavailable");
    expect(canvas.captureStream).toHaveBeenCalledOnce();
    expect(outputTrack.stop).toHaveBeenCalledOnce();
    expect(sourceTrack.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
