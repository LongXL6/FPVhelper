"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalVideoRecording, type LocalVideoRecordingState } from "./use-local-video-recording";
import { localVideoRecordingFilename, type LocalVideoRecordingReceipt } from "@/lib/local-video-recording";
import { startStickVideoCompositor, type StickVideoCompositor } from "@/lib/stick-video-compositor";
import { createTrainingSessionDirectoryWritable, getBrowserTrainingSessionDirectoryPicker, getTrainingSessionDirectoryPermission, runTrainingSessionDirectoryAction,
  type TrainingSessionDirectoryHandle, type TrainingSessionDirectoryWritable } from "@/lib/training-session-export-directory";
import type { VideoCropRect } from "@/lib/video-workspace";

interface DvrStartOptions {
  sourceStream: MediaStream;
  crop?: VideoCropRect;
  frameRate: number;
  athleteCode: string;
  mimeType: string;
  createWritable: (filename: string) => Promise<TrainingSessionDirectoryWritable>;
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : "本地 DVR 录像失败"; }
function cancellation() { return new DOMException("DVR 录像已取消", "AbortError"); }
function isAbort(error: unknown) { return error !== null && typeof error === "object" && "name" in error && error.name === "AbortError"; }

// The recorder can close on a failed start. Share that completion with outer cleanup.
function ownWritable(original: TrainingSessionDirectoryWritable) {
  let completion: Promise<void> | null = null;
  const finish = (action: () => Promise<void>) => completion ??= Promise.resolve().then(action);
  const releaseUnused = (reason?: unknown) => finish(() => original.abort ? original.abort(reason) : original.close());
  return { releaseUnused, writable: {
    write: (data: Blob) => original.write(data),
    close: () => finish(() => original.close()),
    abort: releaseUnused,
  } };
}

interface DvrAttempt {
  abort: AbortController;
  setupDone: Promise<void>;
  resolveSetup: () => void;
  filename: string | null;
  compositor: StickVideoCompositor | null;
  file: ReturnType<typeof ownWritable> | null;
  recorderInvoked: boolean;
  encoderStarted: boolean;
  stopRequested: boolean;
  failure: Error | null;
  stopPromise: Promise<LocalVideoRecordingReceipt | null> | null;
}

export function useDvrRecording() {
  const local = useLocalVideoRecording();
  const { start: startVideo, stop: stopVideo, fail: failVideo } = local;
  const [state, setState] = useState<LocalVideoRecordingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<LocalVideoRecordingReceipt | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [directoryName, setDirectoryName] = useState<string | null>(null);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const mounted = useRef(true), attemptRef = useRef<DvrAttempt | null>(null);
  const receiptRef = useRef<LocalVideoRecordingReceipt | null>(null);
  const directoryRef = useRef<TrainingSessionDirectoryHandle | null>(null);
  const pickerRef = useRef<object | null>(null);
  const isBusy = useCallback(() => attemptRef.current !== null || pickerRef.current !== null, []);

  const finishAttempt = useCallback((attempt: DvrAttempt, failure?: Error): Promise<LocalVideoRecordingReceipt | null> => {
    if (attemptRef.current !== attempt) return attempt.stopPromise ?? Promise.resolve(null);
    if (failure) {
      attempt.failure ??= failure;
      if (attempt.recorderInvoked) void failVideo(failure);
    }
    if (attempt.stopPromise) return attempt.stopPromise;
    attempt.stopRequested = true;
    if (mounted.current) setState("stopping");
    attempt.stopPromise = (async () => {
      await attempt.setupDone;
      let result: LocalVideoRecordingReceipt | null = null;
      try {
        if (attempt.encoderStarted) result = attempt.failure ? await failVideo(attempt.failure) : await stopVideo();
        else await attempt.file?.releaseUnused(attempt.failure ?? cancellation());
      } catch (failure) { attempt.failure ??= new Error(errorMessage(failure)); }
      finally {
        attempt.compositor?.dispose();
        if (attemptRef.current === attempt) {
          attemptRef.current = null;
          receiptRef.current = result;
          if (mounted.current) {
            setReceipt(result);
            setError(attempt.failure?.message ?? (attempt.encoderStarted && !result ? "DVR 录像未能完整保存" : null));
            setState(result ? "saved" : attempt.failure || attempt.encoderStarted ? "error" : "idle");
          }
        }
      }
      return result;
    })();
    // Aborting an active canvas would interrupt the encoder before its final chunk.
    if (!attempt.recorderInvoked) attempt.abort.abort();
    return attempt.stopPromise;
  }, [failVideo, stopVideo]);

  const stop = useCallback(() => {
    const attempt = attemptRef.current;
    return attempt ? finishAttempt(attempt) : Promise.resolve(receiptRef.current);
  }, [finishAttempt]);

  const start = useCallback(async (options: DvrStartOptions): Promise<boolean> => {
    if (!mounted.current || isBusy()) return false;
    let resolveSetup!: () => void;
    const attempt: DvrAttempt = { abort: new AbortController(), setupDone: new Promise<void>((done) => { resolveSetup = done; }),
      resolveSetup: () => resolveSetup(), filename: null, compositor: null, file: null, recorderInvoked: false,
      encoderStarted: false, stopRequested: false, failure: null, stopPromise: null };
    attemptRef.current = attempt; receiptRef.current = null;
    setState("starting"); setError(null); setReceipt(null); setFilename(null);
    const assertCurrent = () => {
      if (!mounted.current || attemptRef.current !== attempt || attempt.stopRequested || attempt.abort.signal.aborted) throw attempt.failure ?? cancellation();
    };
    try {
      const crop = options.crop;
      attempt.filename = localVideoRecordingFilename({ athleteCode: options.athleteCode.trim() || "DVR", sessionId: crypto.randomUUID(),
        startedAtEpochMs: Date.now(), mimeType: options.mimeType,
        cropped: Boolean(crop && (crop.xPercent !== 0 || crop.yPercent !== 0 || crop.widthPercent !== 100 || crop.heightPercent !== 100)) });
      setFilename(attempt.filename);
      attempt.compositor = await startStickVideoCompositor({ sourceStream: options.sourceStream, crop, frameRate: options.frameRate,
        athleteCode: options.athleteCode.trim() || "DVR", drawOverlay: false, signal: attempt.abort.signal,
        getTelemetry: () => { throw new Error("DVR 不应读取遥控数据"); },
        onError: (failure) => {
          if (attemptRef.current !== attempt || (attempt.stopRequested && attempt.abort.signal.aborted && isAbort(failure))) return;
          void finishAttempt(attempt, failure);
        } });
      assertCurrent();
      attempt.file = ownWritable(await options.createWritable(attempt.filename));
      assertCurrent();
      attempt.recorderInvoked = true;
      attempt.encoderStarted = await startVideo({ stream: attempt.compositor.stream, writable: attempt.file.writable,
        filename: attempt.filename, mimeType: options.mimeType, startedAtEpochMs: Date.now(), stopStreamTracksOnFinish: false });
      if (!attempt.encoderStarted) attempt.failure ??= new Error("无法开始 DVR 录像");
    } catch (failure) {
      if (!(attempt.stopRequested && isAbort(failure))) attempt.failure ??= new Error(errorMessage(failure));
    } finally { attempt.resolveSetup(); }
    if (!attempt.encoderStarted || attempt.stopRequested || attempt.failure || !mounted.current) {
      await finishAttempt(attempt, attempt.failure ?? undefined);
      return false;
    }
    setState("recording");
    return true;
  }, [finishAttempt, isBusy, startVideo]);

  useEffect(() => {
    const attempt = attemptRef.current;
    if (!attempt?.encoderStarted || attempt.filename !== local.filename) return;
    if (local.state === "error") void finishAttempt(attempt, new Error(local.error ?? "DVR 录像失败"));
    else if (local.state === "saved") void finishAttempt(attempt);
  }, [finishAttempt, local.error, local.filename, local.state]);

  const chooseDirectory = useCallback(async (): Promise<boolean> => {
    if (!mounted.current || isBusy()) return false;
    const token = {}; pickerRef.current = token; setDirectoryError(null);
    try {
      const picker = getBrowserTrainingSessionDirectoryPicker();
      if (!picker) throw new Error("此浏览器不支持选择 DVR 保存文件夹，请使用支持文件夹写入的浏览器");
      const result = await runTrainingSessionDirectoryAction({ action: "replace", existingHandle: directoryRef.current, picker });
      if (!mounted.current || pickerRef.current !== token) return false;
      if (!result.handle || !result.granted) throw new Error("未取得新文件夹写入权限，原 DVR 文件夹选择保持不变");
      directoryRef.current = result.handle; setDirectoryName(result.handle.name); return true;
    } catch (failure) {
      if (mounted.current && pickerRef.current === token && !isAbort(failure)) setDirectoryError(errorMessage(failure));
      return false;
    } finally { if (pickerRef.current === token) pickerRef.current = null; }
  }, [isBusy]);

  const createWritable = useCallback(async (name: string): Promise<TrainingSessionDirectoryWritable> => {
    const handle = directoryRef.current;
    if (!handle) throw new Error("请先选择 DVR 保存文件夹");
    try {
      if (await getTrainingSessionDirectoryPermission(handle) !== "granted") throw new Error("DVR 保存文件夹没有写入权限，请重新选择或授权");
      return await createTrainingSessionDirectoryWritable(handle, name);
    } catch (failure) {
      if (mounted.current && directoryRef.current === handle) setDirectoryError(errorMessage(failure));
      throw failure;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!attemptRef.current) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      mounted.current = false; pickerRef.current = null; directoryRef.current = null;
      window.removeEventListener("beforeunload", beforeUnload);
      if (attemptRef.current) void finishAttempt(attemptRef.current);
    };
  }, [finishAttempt]);

  return { start, stop, isBusy, state, error: local.filename === filename && local.error ? local.error : error,
    receipt, filename, elapsedMs: local.filename === filename ? local.elapsedMs : 0,
    isActive: state === "starting" || state === "recording" || state === "stopping",
    isStarting: state === "starting", isRecording: state === "recording", isStopping: state === "stopping",
    chooseDirectory, createWritable, directoryName, directoryError, hasDirectory: directoryName !== null };
}
