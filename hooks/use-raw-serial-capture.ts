"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  appendRawSerialCaptureChunk,
  createRawSerialCaptureBlob,
  createRawSerialCaptureBuffer,
  downloadLocalFile,
  RAW_SERIAL_CAPTURE_DURATION_MS,
  rawSerialCaptureFilename,
  type RawSerialCaptureBuffer,
} from "../lib/local-diagnostics";

export type RawSerialCaptureStopReason = "completed" | "size_limit" | "disconnected";

export interface RawSerialCaptureState {
  state: "idle" | "capturing" | "ready";
  startedAt: string | null;
  remainingMs: number;
  byteLength: number;
  stopReason: RawSerialCaptureStopReason | null;
}

const IDLE_RAW_CAPTURE: RawSerialCaptureState = {
  state: "idle",
  startedAt: null,
  remainingMs: 0,
  byteLength: 0,
  stopReason: null,
};

export function useRawSerialCapture() {
  const [capture, setCapture] = useState<RawSerialCaptureState>(IDLE_RAW_CAPTURE);
  const mountedRef = useRef(false);
  const stateRef = useRef<RawSerialCaptureState["state"]>("idle");
  const bufferRef = useRef<RawSerialCaptureBuffer | null>(null);
  const deadlineRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) clearInterval(timerRef.current);
    timerRef.current = null;
    deadlineRef.current = null;
  }, []);

  const finish = useCallback((stopReason: RawSerialCaptureStopReason) => {
    const buffer = bufferRef.current;
    const deadline = deadlineRef.current;
    if (!mountedRef.current || stateRef.current !== "capturing" || !buffer || deadline === null) return false;
    const resolvedStopReason = stopReason !== "size_limit" && performance.now() >= deadline
      ? "completed"
      : stopReason;
    clearTimer();
    stateRef.current = "ready";
    setCapture({
      state: "ready",
      startedAt: buffer.startedAt,
      remainingMs: 0,
      byteLength: buffer.byteLength,
      stopReason: resolvedStopReason,
    });
    return true;
  }, [clearTimer]);

  const start = useCallback(() => {
    if (!mountedRef.current || stateRef.current !== "idle" || bufferRef.current !== null) return false;
    const startedAt = new Date().toISOString();
    bufferRef.current = createRawSerialCaptureBuffer(startedAt);
    const deadline = performance.now() + RAW_SERIAL_CAPTURE_DURATION_MS;
    deadlineRef.current = deadline;
    stateRef.current = "capturing";
    setCapture({
      state: "capturing",
      startedAt,
      remainingMs: RAW_SERIAL_CAPTURE_DURATION_MS,
      byteLength: 0,
      stopReason: null,
    });
    timerRef.current = setInterval(() => {
      if (deadlineRef.current !== deadline) return;
      const remainingMs = Math.max(0, deadline - performance.now());
      const buffer = bufferRef.current;
      if (remainingMs === 0) {
        finish("completed");
        return;
      }
      setCapture((current) => current.state !== "capturing" ? current : {
        ...current,
        remainingMs,
        byteLength: buffer?.byteLength ?? current.byteLength,
      });
    }, 250);
    return true;
  }, [finish]);

  const ingest = useCallback((chunk: Uint8Array) => {
    const current = bufferRef.current;
    const deadline = deadlineRef.current;
    if (stateRef.current !== "capturing" || !current || deadline === null) return;
    if (performance.now() >= deadline) {
      finish("completed");
      return;
    }
    const next = appendRawSerialCaptureChunk(current, chunk);
    bufferRef.current = next;
    if (next.truncated) finish("size_limit");
  }, [finish]);

  const cancel = useCallback(() => {
    if (!mountedRef.current) return;
    clearTimer();
    stateRef.current = "idle";
    bufferRef.current = null;
    setCapture(IDLE_RAW_CAPTURE);
  }, [clearTimer]);

  const download = useCallback(() => {
    const buffer = bufferRef.current;
    if (!buffer || capture.state !== "ready" || buffer.byteLength === 0) return false;
    downloadLocalFile(createRawSerialCaptureBlob(buffer), rawSerialCaptureFilename(buffer.startedAt));
    return true;
  }, [capture.state]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
      stateRef.current = "idle";
      bufferRef.current = null;
    };
  }, [clearTimer]);

  return { capture, start, ingest, finish, cancel, download };
}
