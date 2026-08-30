"use client";

import { RefObject, useCallback, useEffect, useRef, useState } from "react";

type VideoState = "idle" | "connecting" | "live" | "error";

interface VideoCaptureController {
  videoRef: RefObject<HTMLVideoElement | null>;
  devices: MediaDeviceInfo[];
  selectedDeviceId: string;
  state: VideoState;
  error: string | null;
  setSelectedDeviceId: (deviceId: string) => void;
  connect: () => Promise<void>;
  disconnect: () => void;
}

export function useVideoCapture(): VideoCaptureController {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [state, setState] = useState<VideoState>("idle");
  const [error, setError] = useState<string | null>(null);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const available = (await navigator.mediaDevices.enumerateDevices()).filter(
      (device) => device.kind === "videoinput",
    );
    setDevices(available);
    setSelectedDeviceId((current) => current || available[0]?.deviceId || "");
  }, []);

  const disconnect = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setState("idle");
    setError(null);
  }, []);

  const connect = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setState("error");
      setError("当前浏览器无法访问视频采集设备。 ");
      return;
    }

    disconnect();
    setState("connecting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: selectedDeviceId
          ? { deviceId: { exact: selectedDeviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
          : { width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      await refreshDevices();
      setState("live");
      setError(null);
    } catch (captureError) {
      setState("error");
      setError(captureError instanceof Error ? captureError.message : "HDMI 采集卡连接失败");
    }
  }, [disconnect, refreshDevices, selectedDeviceId]);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refreshDevices(), 0);
    navigator.mediaDevices?.addEventListener("devicechange", refreshDevices);
    return () => {
      window.clearTimeout(initialRefresh);
      navigator.mediaDevices?.removeEventListener("devicechange", refreshDevices);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [refreshDevices]);

  return {
    videoRef,
    devices,
    selectedDeviceId,
    state,
    error,
    setSelectedDeviceId,
    connect,
    disconnect,
  };
}
