"use client";

import { useCallback, useEffect, useRef } from "react";
import { usePilotTelemetryController, type PilotTelemetryWorkspaceStore } from "@/hooks/use-pilot-telemetry-workspace";
import type { VideoWorkspaceElementRegistrar } from "@/hooks/use-video-workspace-capture";
import { clamp } from "@/lib/telemetry";
import { videoCropPixelRect, type VideoCropRect } from "@/lib/video-workspace";
import { StickAxes } from "@/components/stick-axes";

const statusCopy = {
  demo: "演示数据",
  connecting: "正在连接",
  live: "数据桥在线",
  stale: "数据已停滞",
  error: "需要检查",
} as const;

function MiniStickIndicator({
  xLabel,
  yLabel,
  x,
  y,
  tone,
}: {
  xLabel: string;
  yLabel: string;
  x: number;
  y: number;
  tone: "orange" | "blue";
}) {
  return (
    <span className={`pilot-mini-stick pilot-mini-stick--${tone}`}>
      <i
        style={{
          left: `${clamp((x + 100) / 2, 0, 100)}%`,
          top: `${clamp((100 - y) / 2, 0, 100)}%`,
        }}
      />
      <StickAxes xLabel={xLabel} yLabel={yLabel} />
    </span>
  );
}

export function PilotViewportTelemetry({
  pilotChannelId,
  label,
  active,
  controlsLocked,
  store,
  onActivate,
  onBeginSerialConnect,
  onDemoReturnIntentional,
}: {
  pilotChannelId: string;
  label: string;
  active: boolean;
  controlsLocked: boolean;
  store: PilotTelemetryWorkspaceStore;
  onActivate: () => void;
  onBeginSerialConnect: (pilotChannelId: string) => void;
  onDemoReturnIntentional: () => void;
}) {
  const controller = usePilotTelemetryController(store, pilotChannelId);
  const isSerial = controller.source === "serial";
  const isConnecting = controller.connection === "connecting";
  const buttonLabel = isConnecting
    ? `取消 ${label} 飞控连接`
    : isSerial
      ? `断开 ${label} 桥接飞控`
      : `连接 ${label} 桥接飞控`;

  return (
    <>
      <div
        className={`pilot-viewport-telemetry pilot-viewport-telemetry--${controller.connection}`}
        data-telemetry-source={controller.source}
        data-telemetry-connection={controller.connection}
        title={controller.error ?? undefined}
      >
        <span><i /><b>{isSerial ? "GROUND_RC" : "DEMO"}</b><small>{statusCopy[controller.connection]}</small></span>
        <button
          type="button"
          aria-label={buttonLabel}
          disabled={controlsLocked || (!controller.serialSupported && !isConnecting && !isSerial)}
          onClick={() => {
            if (isConnecting || isSerial) {
              if (active) onDemoReturnIntentional();
              void controller.useDemo();
              return;
            }
            onActivate();
            onBeginSerialConnect(pilotChannelId);
            void controller.connectSerial();
          }}
        >{isConnecting ? "取消" : isSerial ? "断开" : "连接飞控"}</button>
      </div>
      {!active ? (
        <div className="pilot-mini-telemetry" aria-label={`${label} 实时打杆`}>
          <MiniStickIndicator
            xLabel="YAW" yLabel="THR"
            x={controller.telemetry.yawStickPercent}
            y={controller.telemetry.throttleStickPercent * 2 - 100}
            tone="orange"
          />
          <MiniStickIndicator
            xLabel="ROLL" yLabel="PITCH"
            x={controller.telemetry.rollStickPercent}
            y={controller.telemetry.pitchStickPercent}
            tone="blue"
          />
          <strong>THR {Math.round(controller.telemetry.throttleStickPercent)}%</strong>
        </div>
      ) : null}
    </>
  );
}

export function WorkspaceVideoElement({
  sourceId,
  pilotChannelId,
  cropped,
  keepFramesActive,
  crop,
  registerVideoElement,
  registerOutputCanvas,
}: {
  sourceId: string;
  pilotChannelId: string;
  cropped: boolean;
  keepFramesActive: boolean;
  crop: VideoCropRect;
  registerVideoElement: VideoWorkspaceElementRegistrar;
  registerOutputCanvas: (pilotChannelId: string, element: HTMLCanvasElement | null) => (() => void) | undefined;
}) {
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { xPercent, yPercent, widthPercent, heightPercent } = crop;
  const videoRef = useCallback((element: HTMLVideoElement | null) => {
    videoElementRef.current = element;
    const unregister = registerVideoElement(sourceId, element);
    return () => {
      if (videoElementRef.current === element) videoElementRef.current = null;
      unregister?.();
    };
  }, [registerVideoElement, sourceId]);
  const outputCanvasRef = useCallback((element: HTMLCanvasElement | null) => {
    canvasRef.current = element;
    const unregister = registerOutputCanvas(pilotChannelId, element);
    return () => {
      if (canvasRef.current === element) canvasRef.current = null;
      unregister?.();
    };
  }, [pilotChannelId, registerOutputCanvas]);

  useEffect(() => {
    if (!cropped) return;
    const video = videoElementRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: false });
    if (!video || !canvas || !context) return;

    let stopped = false;
    let animationFrame: number | null = null;
    let videoFrame: number | null = null;
    const scheduleNextFrame = () => {
      if (stopped) return;
      // A hidden video may stop compositor callbacks. Keep the recorded canvas moving across workspace views.
      if (!keepFramesActive && typeof video.requestVideoFrameCallback === "function") {
        videoFrame = video.requestVideoFrameCallback(drawFrame);
      } else {
        animationFrame = window.requestAnimationFrame(drawFrame);
      }
    };
    const drawFrame = () => {
      if (stopped) return;
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
        const sourceRect = videoCropPixelRect(
          { xPercent, yPercent, widthPercent, heightPercent },
          video.videoWidth,
          video.videoHeight,
        );
        if (canvas.width !== sourceRect.width) canvas.width = sourceRect.width;
        if (canvas.height !== sourceRect.height) canvas.height = sourceRect.height;
        try {
          context.drawImage(
            video,
            sourceRect.x,
            sourceRect.y,
            sourceRect.width,
            sourceRect.height,
            0,
            0,
            sourceRect.width,
            sourceRect.height,
          );
        } catch {
          // The next decoded video frame retries transient source changes.
        }
      }
      scheduleNextFrame();
    };
    scheduleNextFrame();

    return () => {
      stopped = true;
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      if (videoFrame !== null && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(videoFrame);
      }
    };
  }, [cropped, keepFramesActive, heightPercent, widthPercent, xPercent, yPercent]);

  return (
    <>
      <video
        ref={videoRef}
        className={cropped ? "video-feed-source" : undefined}
        muted
        playsInline
      />
      {cropped ? <canvas ref={outputCanvasRef} className="video-feed--cropped" aria-hidden="true" /> : null}
    </>
  );
}
