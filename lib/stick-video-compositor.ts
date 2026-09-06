import { formatStickAxisValue } from "./stick-display";
import { clamp, type ConnectionState, type FlightTelemetry, type LinkState } from "./telemetry";
import { videoCropPixelRect, type VideoCropRect } from "./video-workspace";

export interface StickVideoCompositorOptions {
  sourceStream: MediaStream;
  crop?: VideoCropRect;
  frameRate: number;
  drawOverlay?: boolean;
  getTelemetry: () => FlightTelemetry;
  getLinkState?: () => LinkState;
  getConnection?: () => ConnectionState;
  athleteCode: string;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
}

export interface StickVideoCompositor {
  stream: MediaStream;
  width: number;
  height: number;
  dispose(): void;
}

const FULL_FRAME: VideoCropRect = { xPercent: 0, yPercent: 0, widthPercent: 100, heightPercent: 100 };
const START_TIMEOUT_MS = 6_000;
const VIDEO_STALL_TIMEOUT_MS = 5_000;
const DRAW_FAILURE_TIMEOUT_MS = 1_000;

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  demo: "DEMO",
  connecting: "RC CONNECTING",
  live: "RC LIVE",
  stale: "RC STALE",
  error: "RC ERROR",
};

function asError(error: unknown) {
  return error instanceof Error ? error : new Error("视频合成失败");
}

function abortedError() {
  return new DOMException("视频录制已取消", "AbortError");
}

export function drawStickVideoOverlay(
  context: CanvasRenderingContext2D,
  {
    width,
    height,
    telemetry,
    linkState = "unknown",
    connection,
    athleteCode,
  }: {
    width: number;
    height: number;
    telemetry: FlightTelemetry;
    linkState?: LinkState;
    connection?: ConnectionState;
    athleteCode: string;
  },
) {
  const scale = Math.min(1, width / 400, height / 240);
  const margin = Math.max(8 * scale, Math.min(width, height) * 0.025);
  const side = Math.min(240, width * 0.2, height * 0.28);
  const fontSize = Math.max(9 * scale, side * 0.095);
  const labelGap = fontSize * 3.65;
  const panelWidth = labelGap + side + fontSize;
  const panelHeight = side + fontSize * 4.4;
  const panelTop = height - margin - panelHeight;
  const hasSample = telemetry.sequence > 0;
  const status = hasSample ? (connection ? CONNECTION_LABEL[connection] : "RC DATA") : "NO RC SAMPLE";
  const linkLabel = linkState === "ok" ? "LINK OK" : linkState === "lost" ? "LINK LOST" : "LINK UNKNOWN";

  context.save();
  context.textBaseline = "middle";
  context.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  context.fillStyle = "rgba(7, 14, 16, 0.78)";
  context.fillRect(margin, margin, width - margin * 2, fontSize * 2.8);
  context.fillStyle = "#f0f4f4";
  context.textAlign = "left";
  context.fillText(athleteCode || "PILOT", margin + fontSize, margin + fontSize * 0.85, width * 0.45);
  context.fillStyle = connection === "stale" || connection === "error" || linkState === "lost" ? "#ffb796" : "#c0d4d6";
  context.fillText(`${status} / ${linkLabel}`, margin + fontSize, margin + fontSize * 2, width - margin * 2 - fontSize * 2);
  context.textAlign = "right";
  context.fillStyle = "#f0f4f4";
  context.fillText(`THR ${hasSample ? Math.round(clamp(telemetry.throttleStickPercent, 0, 100)) : "—"}%`, width - margin - fontSize, margin + fontSize * 0.85);

  const drawStick = (panelLeft: number, xLabel: string, yLabel: string, x: number, y: number, color: string) => {
    const gridX = panelLeft + labelGap;
    const gridY = panelTop + fontSize * 1.6;
    const centerX = gridX + side / 2;
    const centerY = gridY + side / 2;
    context.fillStyle = "rgba(7, 14, 16, 0.78)";
    context.fillRect(panelLeft, panelTop, panelWidth, panelHeight);
    context.strokeStyle = "rgba(232, 241, 242, 0.65)";
    context.lineWidth = Math.max(1, scale);
    context.strokeRect(gridX, gridY, side, side);
    context.beginPath();
    context.moveTo(centerX, gridY);
    context.lineTo(centerX, gridY + side);
    context.moveTo(gridX, centerY);
    context.lineTo(gridX + side, centerY);
    context.stroke();
    context.fillStyle = "#dbe5e6";
    context.textAlign = "right";
    context.fillText("+1000", gridX - fontSize * 0.35, gridY);
    context.fillText("0", gridX - fontSize * 0.35, centerY);
    context.fillText("−1000", gridX - fontSize * 0.35, gridY + side);
    const tickY = gridY + side + fontSize * 1.05;
    context.textAlign = "left";
    context.fillText("−1000", gridX, tickY);
    context.textAlign = "center";
    context.fillText("0", centerX, tickY);
    context.textAlign = "right";
    context.fillText("+1000", gridX + side, tickY);
    context.textAlign = "center";
    context.fillStyle = color;
    context.fillText(`${yLabel} ${hasSample ? formatStickAxisValue(y) : "—"}`, centerX, panelTop + fontSize * 0.65);
    context.fillText(`${xLabel} ${hasSample ? formatStickAxisValue(x) : "—"}`, centerX, gridY + side + fontSize * 2.15);
    if (hasSample) {
      context.beginPath();
      context.arc(gridX + (clamp(x, -100, 100) + 100) / 200 * side, gridY + (100 - clamp(y, -100, 100)) / 200 * side, Math.max(3 * scale, side * 0.04), 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = "#ffffff";
      context.stroke();
    }
  };

  drawStick(margin, "YAW", "THR", telemetry.yawStickPercent, telemetry.throttleStickPercent * 2 - 100, "#f3b08c");
  drawStick(width - margin - panelWidth, "ROLL", "PITCH", telemetry.rollStickPercent, telemetry.pitchStickPercent, "#b5d7e3");
  context.restore();
}

export async function startStickVideoCompositor({
  sourceStream,
  crop = FULL_FRAME,
  frameRate,
  drawOverlay = true,
  getTelemetry,
  getLinkState,
  getConnection,
  athleteCode,
  onError,
  signal,
}: StickVideoCompositorOptions): Promise<StickVideoCompositor> {
  if (signal?.aborted) throw abortedError();
  if (!Number.isFinite(frameRate) || frameRate < 1 || frameRate > 120) {
    throw new Error("录像帧率必须在 1–120 fps 之间");
  }
  const sourceTracks = sourceStream.getVideoTracks().filter((track) => track.readyState === "live");
  if (sourceTracks.length === 0) throw new Error("没有可用的视频输入，无法录制视频");
  const video = document.createElement("video");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });
  if (!context || typeof canvas.captureStream !== "function") throw new Error("此浏览器不支持视频合成录制");
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;

  let disposed = false;
  let running = false;
  let outputStream: MediaStream | undefined;
  let videoFrame: number | undefined;
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let checkReady: (() => void) | undefined;
  let terminalError: Error | undefined;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (frameTimer !== undefined) clearTimeout(frameTimer);
    if (readyTimer !== undefined) clearTimeout(readyTimer);
    if (videoFrame !== undefined && typeof video.cancelVideoFrameCallback === "function") video.cancelVideoFrameCallback(videoFrame);
    sourceTracks.forEach((track) => track.removeEventListener("ended", handleSourceEnded));
    video.removeEventListener("error", handleVideoError);
    if (checkReady) {
      video.removeEventListener("loadeddata", checkReady);
      video.removeEventListener("canplay", checkReady);
    }
    signal?.removeEventListener("abort", handleAbort);
    video.pause();
    video.srcObject = null;
    outputStream?.getTracks().forEach((track) => track.stop());
    canvas.width = 0;
    canvas.height = 0;
  };

  const fail = (error: Error) => {
    if (disposed) return;
    terminalError = error;
    dispose();
    rejectReady?.(error);
    if (running) onError?.(error);
  };
  function handleSourceEnded() { fail(new Error("视频输入已断开，录像中止")); }
  function handleVideoError() { fail(new Error(video.error?.message || "视频输入解码失败，录像中止")); }
  function handleAbort() { fail(abortedError()); }

  sourceTracks.forEach((track) => track.addEventListener("ended", handleSourceEnded));
  video.addEventListener("error", handleVideoError);
  signal?.addEventListener("abort", handleAbort, { once: true });

  try {
    await new Promise<void>((resolve, reject) => {
      rejectReady = reject;
      let playing = false;
      checkReady = () => {
        if (playing && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) resolve();
      };
      video.addEventListener("loadeddata", checkReady);
      video.addEventListener("canplay", checkReady);
      readyTimer = setTimeout(() => fail(new Error("视频输入尚未产生可录制画面，请检查采集卡后重试")), START_TIMEOUT_MS);
      video.srcObject = sourceStream;
      void video.play().then(() => {
        playing = true;
        checkReady?.();
      }, (error: unknown) => fail(asError(error)));
      if (signal?.aborted) handleAbort();
      else if (sourceTracks.some((track) => track.readyState === "ended")) handleSourceEnded();
    });
    if (terminalError) throw terminalError;
    if (readyTimer !== undefined) clearTimeout(readyTimer);
    readyTimer = undefined;
    rejectReady = undefined;
    if (checkReady) {
      video.removeEventListener("loadeddata", checkReady);
      video.removeEventListener("canplay", checkReady);
    }
    const sourceRect = videoCropPixelRect(crop, video.videoWidth, video.videoHeight);
    const width = canvas.width = sourceRect.width;
    const height = canvas.height = sourceRect.height;
    const frameInterval = 1_000 / frameRate;
    let lastDrawMs = -Infinity;
    let lastVideoTime = video.currentTime;
    let lastVideoProgressMs = performance.now();
    let drawFailureSinceMs: number | undefined;

    const draw = () => {
      const rect = videoCropPixelRect(crop, video.videoWidth, video.videoHeight);
      const fit = Math.min(width / rect.width, height / rect.height);
      const drawWidth = rect.width * fit;
      const drawHeight = rect.height * fit;
      context.fillStyle = "#000000";
      context.fillRect(0, 0, width, height);
      context.drawImage(video, rect.x, rect.y, rect.width, rect.height, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
      if (drawOverlay) {
        drawStickVideoOverlay(context, { width, height, telemetry: getTelemetry(), linkState: getLinkState?.(), connection: getConnection?.(), athleteCode });
      }
    };
    draw();
    outputStream = canvas.captureStream(frameRate);
    if (!outputStream.getVideoTracks().some((track) => track.readyState === "live")) throw new Error("浏览器未能创建录制视频流");
    // Paint after captureStream as well, so the first encoded frame is initialized.
    draw();

    const render = (nowMs: number) => {
      if (disposed) return;
      if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        lastVideoProgressMs = nowMs;
      }
      if (nowMs - lastVideoProgressMs >= VIDEO_STALL_TIMEOUT_MS) {
        fail(new Error("视频输入连续 5 秒未更新，录像中止"));
        return;
      }
      if (nowMs - lastDrawMs < frameInterval - 0.5) return;
      lastDrawMs = nowMs;
      try {
        if (video.readyState < 2 || video.videoWidth < 1 || video.videoHeight < 1) return;
        draw();
        drawFailureSinceMs = undefined;
      } catch (error) {
        drawFailureSinceMs ??= nowMs;
        if (nowMs - drawFailureSinceMs >= DRAW_FAILURE_TIMEOUT_MS) fail(asError(error));
      }
    };
    const scheduleVideoFrame = () => {
      if (disposed || typeof video.requestVideoFrameCallback !== "function") return;
      videoFrame = video.requestVideoFrameCallback((nowMs) => {
        videoFrame = undefined;
        lastVideoProgressMs = nowMs;
        render(nowMs);
        scheduleVideoFrame();
      });
    };
    const scheduleTimer = () => {
      if (disposed) return;
      frameTimer = setTimeout(() => {
        frameTimer = undefined;
        render(performance.now());
        scheduleTimer();
      }, frameInterval);
    };
    scheduleVideoFrame();
    // A detached or hidden video can lose compositor callbacks. This bounded fallback is independent of page layout.
    scheduleTimer();
    running = true;
    return { stream: outputStream, width, height, dispose };
  } catch (error) {
    dispose();
    throw asError(error);
  }
}
