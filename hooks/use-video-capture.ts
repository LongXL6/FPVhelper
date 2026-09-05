"use client";

import { RefObject, useCallback, useEffect, useRef, useState } from "react";
import {
  classifyVideoCaptureError,
  videoIssue,
  videoPreflightIssue,
  type VideoCaptureErrorCode,
  type VideoCaptureIssue,
} from "@/lib/hardware-errors";
import {
  loadPreferredVideoDevice,
  localVideoCaptureSettings,
  persistPreferredVideoDevice,
  selectAvailableVideoDevice,
  type LocalVideoCaptureSettings,
} from "@/lib/video-capture";

type VideoState = "idle" | "connecting" | "live" | "error";

interface VideoCaptureController {
  videoRef: RefObject<HTMLVideoElement | null>;
  devices: MediaDeviceInfo[];
  selectedDeviceId: string;
  captureSettings: LocalVideoCaptureSettings | null;
  state: VideoState;
  error: string | null;
  errorCode: VideoCaptureErrorCode | null;
  setSelectedDeviceId: (deviceId: string) => void;
  connect: () => Promise<void>;
  disconnect: () => void;
}

function browserStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function useVideoCapture(): VideoCaptureController {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const activeDeviceIdRef = useRef("");
  const trackListenerCleanupRef = useRef<(() => void) | null>(null);
  const intentionalStopRef = useRef(false);
  const connectionAttemptRef = useRef(0);
  const preferredDeviceIdRef = useRef("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceIdState] = useState("");
  const [captureSettings, setCaptureSettings] = useState<LocalVideoCaptureSettings | null>(null);
  const [state, setState] = useState<VideoState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<VideoCaptureErrorCode | null>(null);

  const setIssue = useCallback((issue: VideoCaptureIssue) => {
    setState("error");
    setErrorCode(issue.code);
    setError(issue.message);
  }, []);

  const releaseCurrentStream = useCallback(() => {
    intentionalStopRef.current = true;
    trackListenerCleanupRef.current?.();
    trackListenerCleanupRef.current = null;
    const stream = streamRef.current;
    streamRef.current = null;
    activeDeviceIdRef.current = "";
    stream?.getTracks().forEach((track) => track.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    setCaptureSettings(null);
    intentionalStopRef.current = false;
  }, []);

  const refreshDevices = useCallback(async (): Promise<MediaDeviceInfo[] | null> => {
    if (!navigator.mediaDevices?.enumerateDevices) return null;
    try {
      const available = (await navigator.mediaDevices.enumerateDevices()).filter(
        (device) => device.kind === "videoinput",
      );
      const availableDeviceIds = available.map((device) => device.deviceId);
      setDevices(available);
      setSelectedDeviceIdState((current) =>
        selectAvailableVideoDevice(
          availableDeviceIds,
          current,
          preferredDeviceIdRef.current,
        ),
      );
      return available;
    } catch {
      return null;
    }
  }, []);

  const disconnect = useCallback(() => {
    connectionAttemptRef.current += 1;
    releaseCurrentStream();
    setState("idle");
    setError(null);
    setErrorCode(null);
  }, [releaseCurrentStream]);

  const setSelectedDeviceId = useCallback((deviceId: string) => {
    preferredDeviceIdRef.current = deviceId;
    persistPreferredVideoDevice(browserStorage(), deviceId);
    setSelectedDeviceIdState(deviceId);
  }, []);

  const connect = useCallback(async () => {
    const preflightIssue = videoPreflightIssue({
      secureContext: typeof window !== "undefined" && window.isSecureContext,
      mediaSupported: Boolean(navigator.mediaDevices?.getUserMedia),
    });
    if (preflightIssue) {
      connectionAttemptRef.current += 1;
      releaseCurrentStream();
      setIssue(preflightIssue);
      return;
    }

    const connectionAttempt = connectionAttemptRef.current + 1;
    connectionAttemptRef.current = connectionAttempt;
    releaseCurrentStream();
    setState("connecting");
    setError(null);
    setErrorCode(null);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: selectedDeviceId
          ? {
              deviceId: { exact: selectedDeviceId },
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            }
          : { width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
    } catch (captureError) {
      if (connectionAttemptRef.current !== connectionAttempt) return;
      setIssue(classifyVideoCaptureError(captureError));
      return;
    }

    if (connectionAttemptRef.current !== connectionAttempt) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      stream.getTracks().forEach((track) => track.stop());
      setIssue(videoIssue("video_device_not_found"));
      return;
    }

    streamRef.current = stream;
    const trackSettings = videoTrack.getSettings();
    const activeDeviceId = trackSettings.deviceId || selectedDeviceId;
    activeDeviceIdRef.current = activeDeviceId;
    setCaptureSettings(localVideoCaptureSettings(trackSettings));

    const handleTrackEnded = () => {
      if (
        intentionalStopRef.current ||
        connectionAttemptRef.current !== connectionAttempt ||
        streamRef.current !== stream
      ) {
        return;
      }
      connectionAttemptRef.current += 1;
      releaseCurrentStream();
      setIssue(videoIssue("video_device_disconnected"));
    };
    videoTrack.addEventListener("ended", handleTrackEnded);
    trackListenerCleanupRef.current = () => videoTrack.removeEventListener("ended", handleTrackEnded);

    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      try {
        await videoRef.current.play();
      } catch {
        if (connectionAttemptRef.current !== connectionAttempt) return;
        releaseCurrentStream();
        setIssue(videoIssue("video_playback_failed"));
        return;
      }
    }

    if (connectionAttemptRef.current !== connectionAttempt) {
      if (streamRef.current === stream) releaseCurrentStream();
      else stream.getTracks().forEach((track) => track.stop());
      return;
    }

    if (activeDeviceId) {
      preferredDeviceIdRef.current = activeDeviceId;
      persistPreferredVideoDevice(browserStorage(), activeDeviceId);
      setSelectedDeviceIdState(activeDeviceId);
    }
    await refreshDevices();
    if (connectionAttemptRef.current !== connectionAttempt) return;
    setState("live");
    setError(null);
    setErrorCode(null);
  }, [refreshDevices, releaseCurrentStream, selectedDeviceId, setIssue]);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    const initialRefresh = window.setTimeout(() => {
      const preferredDeviceId = loadPreferredVideoDevice(browserStorage());
      preferredDeviceIdRef.current = preferredDeviceId;
      setSelectedDeviceIdState((current) => current || preferredDeviceId);
      void refreshDevices();
    }, 0);
    const handleDeviceChange = () => {
      void refreshDevices().then((available) => {
        const activeDeviceId = activeDeviceIdRef.current;
        if (
          available &&
          activeDeviceId &&
          streamRef.current &&
          !available.some((device) => device.deviceId === activeDeviceId)
        ) {
          connectionAttemptRef.current += 1;
          releaseCurrentStream();
          setIssue(videoIssue("video_device_disconnected"));
        }
      });
    };
    mediaDevices?.addEventListener("devicechange", handleDeviceChange);
    return () => {
      window.clearTimeout(initialRefresh);
      mediaDevices?.removeEventListener("devicechange", handleDeviceChange);
      connectionAttemptRef.current += 1;
      releaseCurrentStream();
    };
  }, [refreshDevices, releaseCurrentStream, setIssue]);

  return {
    videoRef,
    devices,
    selectedDeviceId,
    captureSettings,
    state,
    error,
    errorCode,
    setSelectedDeviceId,
    connect,
    disconnect,
  };
}
