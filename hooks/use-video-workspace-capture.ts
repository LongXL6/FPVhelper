"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  classifyVideoCaptureError,
  videoIssue,
  videoPreflightIssue,
  type VideoCaptureErrorCode,
  type VideoCaptureIssue,
} from "../lib/hardware-errors";
import { localVideoCaptureSettings, type LocalVideoCaptureSettings } from "../lib/video-capture";
import type { VideoSourceConfig } from "../lib/video-workspace";

export type VideoSourceState = "idle" | "connecting" | "live" | "error";

export interface VideoSourceRuntime {
  state: VideoSourceState;
  error: string | null;
  errorCode: VideoCaptureErrorCode | null;
  captureSettings: LocalVideoCaptureSettings | null;
}

export type VideoWorkspaceElementRegistrar = (
  sourceId: string,
  element: HTMLVideoElement | null,
) => (() => void) | undefined;

const IDLE_RUNTIME: VideoSourceRuntime = {
  state: "idle",
  error: null,
  errorCode: null,
  captureSettings: null,
};

function stopStream(stream: MediaStream | undefined) {
  stream?.getTracks().forEach((track) => track.stop());
}

export function videoSourceRuntime(
  runtimes: Readonly<Record<string, VideoSourceRuntime>>,
  sourceId: string | undefined,
) {
  return sourceId ? runtimes[sourceId] ?? IDLE_RUNTIME : IDLE_RUNTIME;
}

export function useVideoWorkspaceCapture(sources: readonly VideoSourceConfig[]) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [runtimes, setRuntimes] = useState<Record<string, VideoSourceRuntime>>({});
  const streamsRef = useRef(new Map<string, MediaStream>());
  const activeDeviceIdsRef = useRef(new Map<string, string>());
  const videoElementsRef = useRef(new Map<string, Set<HTMLVideoElement>>());
  const trackCleanupRef = useRef(new Map<string, () => void>());
  const connectionAttemptsRef = useRef(new Map<string, number>());
  const intentionalStopsRef = useRef(new Set<string>());

  const updateRuntime = useCallback((sourceId: string, update: Partial<VideoSourceRuntime>) => {
    setRuntimes((current) => ({
      ...current,
      [sourceId]: { ...(current[sourceId] ?? IDLE_RUNTIME), ...update },
    }));
  }, []);

  const detachVideoElements = useCallback((sourceId: string) => {
    videoElementsRef.current.get(sourceId)?.forEach((element) => {
      element.srcObject = null;
    });
  }, []);

  const releaseSource = useCallback((sourceId: string) => {
    intentionalStopsRef.current.add(sourceId);
    trackCleanupRef.current.get(sourceId)?.();
    trackCleanupRef.current.delete(sourceId);
    const stream = streamsRef.current.get(sourceId);
    streamsRef.current.delete(sourceId);
    activeDeviceIdsRef.current.delete(sourceId);
    stopStream(stream);
    detachVideoElements(sourceId);
    intentionalStopsRef.current.delete(sourceId);
  }, [detachVideoElements]);

  const setIssue = useCallback((sourceId: string, issue: VideoCaptureIssue) => {
    updateRuntime(sourceId, {
      state: "error",
      error: issue.message,
      errorCode: issue.code,
      captureSettings: null,
    });
  }, [updateRuntime]);

  const disconnectSource = useCallback((sourceId: string) => {
    connectionAttemptsRef.current.set(sourceId, (connectionAttemptsRef.current.get(sourceId) ?? 0) + 1);
    releaseSource(sourceId);
    updateRuntime(sourceId, { ...IDLE_RUNTIME });
  }, [releaseSource, updateRuntime]);

  const registerVideoElement = useCallback((sourceId: string, element: HTMLVideoElement | null) => {
    let elements = videoElementsRef.current.get(sourceId);
    if (!elements) {
      elements = new Set<HTMLVideoElement>();
      videoElementsRef.current.set(sourceId, elements);
    }
    if (!element) return;
    elements.add(element);
    const stream = streamsRef.current.get(sourceId);
    if (stream) {
      element.srcObject = stream;
      void element.play().catch(() => undefined);
    }
    return () => {
      element.srcObject = null;
      elements?.delete(element);
      if (elements?.size === 0) videoElementsRef.current.delete(sourceId);
    };
  }, []);

  const getSourceStream = useCallback((sourceId: string) => streamsRef.current.get(sourceId) ?? null, []);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return null;
    try {
      const available = (await navigator.mediaDevices.enumerateDevices()).filter(
        (device) => device.kind === "videoinput",
      );
      setDevices(available);
      return available;
    } catch {
      return null;
    }
  }, []);

  const connectSource = useCallback(async (sourceId: string) => {
    const source = sources.find((candidate) => candidate.id === sourceId);
    if (!source) return;
    const preflightIssue = videoPreflightIssue({
      secureContext: typeof window !== "undefined" && window.isSecureContext,
      mediaSupported: Boolean(navigator.mediaDevices?.getUserMedia),
    });
    if (preflightIssue) {
      releaseSource(sourceId);
      setIssue(sourceId, preflightIssue);
      return;
    }

    const attempt = (connectionAttemptsRef.current.get(sourceId) ?? 0) + 1;
    connectionAttemptsRef.current.set(sourceId, attempt);
    releaseSource(sourceId);
    updateRuntime(sourceId, { state: "connecting", error: null, errorCode: null, captureSettings: null });

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: source.deviceId
          ? {
              deviceId: { exact: source.deviceId },
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            }
          : { width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
    } catch (captureError) {
      if (connectionAttemptsRef.current.get(sourceId) !== attempt) return;
      setIssue(sourceId, classifyVideoCaptureError(captureError));
      return;
    }

    if (connectionAttemptsRef.current.get(sourceId) !== attempt) {
      stopStream(stream);
      return;
    }

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      stopStream(stream);
      setIssue(sourceId, videoIssue("video_device_not_found"));
      return;
    }

    streamsRef.current.set(sourceId, stream);
    const settings = videoTrack.getSettings();
    activeDeviceIdsRef.current.set(sourceId, settings.deviceId || source.deviceId);
    const handleTrackEnded = () => {
      if (
        intentionalStopsRef.current.has(sourceId)
        || connectionAttemptsRef.current.get(sourceId) !== attempt
        || streamsRef.current.get(sourceId) !== stream
      ) {
        return;
      }
      connectionAttemptsRef.current.set(sourceId, attempt + 1);
      releaseSource(sourceId);
      setIssue(sourceId, videoIssue("video_device_disconnected"));
    };
    videoTrack.addEventListener("ended", handleTrackEnded);
    trackCleanupRef.current.set(sourceId, () => videoTrack.removeEventListener("ended", handleTrackEnded));

    const elements = [...(videoElementsRef.current.get(sourceId) ?? [])];
    try {
      await Promise.all(elements.map(async (element) => {
        element.srcObject = stream;
        await element.play();
      }));
    } catch {
      if (connectionAttemptsRef.current.get(sourceId) !== attempt) return;
      releaseSource(sourceId);
      setIssue(sourceId, videoIssue("video_playback_failed"));
      return;
    }

    if (connectionAttemptsRef.current.get(sourceId) !== attempt) {
      if (streamsRef.current.get(sourceId) === stream) releaseSource(sourceId);
      else stopStream(stream);
      return;
    }

    await refreshDevices();
    if (connectionAttemptsRef.current.get(sourceId) !== attempt) return;
    updateRuntime(sourceId, {
      state: "live",
      error: null,
      errorCode: null,
      captureSettings: localVideoCaptureSettings(settings),
    });
  }, [refreshDevices, releaseSource, setIssue, sources, updateRuntime]);

  const connectAll = useCallback(async () => {
    await Promise.all(sources
      .filter((source) => (runtimes[source.id]?.state ?? "idle") !== "live")
      .map((source) => connectSource(source.id)));
  }, [connectSource, runtimes, sources]);

  const disconnectAll = useCallback(() => {
    sources.forEach((source) => disconnectSource(source.id));
  }, [disconnectSource, sources]);

  useEffect(() => {
    const streams = streamsRef.current;
    const initialRefresh = window.setTimeout(() => void refreshDevices(), 0);
    const mediaDevices = navigator.mediaDevices;
    const handleDeviceChange = () => {
      void refreshDevices().then((available) => {
        if (!available) return;
        const availableDeviceIds = new Set(available.map((device) => device.deviceId));
        for (const [sourceId, deviceId] of activeDeviceIdsRef.current) {
          if (!deviceId || availableDeviceIds.has(deviceId)) continue;
          connectionAttemptsRef.current.set(sourceId, (connectionAttemptsRef.current.get(sourceId) ?? 0) + 1);
          releaseSource(sourceId);
          setIssue(sourceId, videoIssue("video_device_disconnected"));
        }
      });
    };
    mediaDevices?.addEventListener("devicechange", handleDeviceChange);
    return () => {
      window.clearTimeout(initialRefresh);
      mediaDevices?.removeEventListener("devicechange", handleDeviceChange);
      for (const sourceId of streams.keys()) releaseSource(sourceId);
    };
  }, [refreshDevices, releaseSource, setIssue]);

  useEffect(() => {
    const activeSourceIds = new Set(sources.map((source) => source.id));
    for (const sourceId of streamsRef.current.keys()) {
      if (!activeSourceIds.has(sourceId)) releaseSource(sourceId);
    }
  }, [releaseSource, sources]);

  return {
    devices,
    runtimes,
    registerVideoElement,
    getSourceStream,
    connectSource,
    disconnectSource,
    connectAll,
    disconnectAll,
  };
}
