"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  startLocalVideoRecording,
  type LocalVideoRecordingReceipt,
  type LocalVideoRecordingRuntime,
} from "@/lib/local-video-recording";
import type { TrainingSessionDirectoryWritable } from "@/lib/training-session-export-directory";

export type LocalVideoRecordingState = "idle" | "starting" | "recording" | "stopping" | "saved" | "error";

export function useLocalVideoRecording() {
  const [state, setState] = useState<LocalVideoRecordingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<LocalVideoRecordingReceipt | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const runtimeRef = useRef<LocalVideoRecordingRuntime | null>(null);
  const startedAtRef = useRef<number | null>(null);

  const settleRuntime = useCallback((runtime: LocalVideoRecordingRuntime) => {
    void runtime.done.then((nextReceipt) => {
      if (runtimeRef.current !== runtime) return;
      runtimeRef.current = null;
      setReceipt(nextReceipt);
      setElapsedMs(nextReceipt.finishedAtEpochMs - nextReceipt.startedAtEpochMs);
      setError(null);
      setState("saved");
    }).catch((recordingError: unknown) => {
      if (runtimeRef.current !== runtime) return;
      runtimeRef.current = null;
      setError(recordingError instanceof Error ? recordingError.message : "本地视频录制失败");
      setState("error");
    });
  }, []);

  const start = useCallback(async ({
    stream,
    writable,
    filename,
    mimeType,
    stopStreamTracksOnFinish,
    startedAtEpochMs,
  }: {
    stream: MediaStream;
    writable: TrainingSessionDirectoryWritable;
    filename: string;
    mimeType: string;
    stopStreamTracksOnFinish: boolean;
    startedAtEpochMs: number;
  }) => {
    if (runtimeRef.current) {
      if (stopStreamTracksOnFinish) stream.getTracks().forEach((track) => track.stop());
      await writable.close().catch(() => undefined);
      return false;
    }
    setState("starting");
    setError(null);
    setReceipt(null);
    setFilename(filename);
    setElapsedMs(0);
    try {
      const runtime = startLocalVideoRecording({
        stream,
        writable,
        filename,
        mimeType,
        stopStreamTracksOnFinish,
        startedAtEpochMs,
      });
      runtimeRef.current = runtime;
      startedAtRef.current = startedAtEpochMs;
      setState("recording");
      settleRuntime(runtime);
      return true;
    } catch (recordingError) {
      setError(recordingError instanceof Error ? recordingError.message : "无法开始本地视频录制");
      setState("error");
      return false;
    }
  }, [settleRuntime]);

  const stop = useCallback(async () => {
    const runtime = runtimeRef.current;
    if (!runtime) return null;
    setState("stopping");
    try {
      return await runtime.stop();
    } catch {
      return null;
    }
  }, []);

  const fail = useCallback(async (recordingError: Error) => {
    const runtime = runtimeRef.current;
    if (!runtime) return null;
    setState("stopping");
    try {
      return await runtime.fail(recordingError);
    } catch {
      return null;
    }
  }, []);

  const reportStartError = useCallback((recordingError: unknown) => {
    setError(recordingError instanceof Error ? recordingError.message : "无法开始本地视频录制");
    setState("error");
  }, []);

  useEffect(() => {
    if (state !== "recording") return;
    const timer = window.setInterval(() => {
      if (startedAtRef.current !== null) setElapsedMs(Math.max(0, Date.now() - startedAtRef.current));
    }, 250);
    return () => window.clearInterval(timer);
  }, [state]);

  useEffect(() => () => {
    void runtimeRef.current?.stop();
  }, []);

  return {
    state,
    error,
    receipt,
    filename,
    elapsedMs,
    isActive: state === "starting" || state === "recording" || state === "stopping",
    start,
    stop,
    fail,
    reportStartError,
  };
}
