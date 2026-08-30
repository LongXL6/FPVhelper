"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FlightTelemetry, TelemetrySource } from "@/lib/telemetry";
import {
  appendTrainingSessionSample,
  createTrainingSessionDraft,
  finishTrainingSession,
  serializeTrainingSession,
  trainingSessionFilename,
  type TrainingSession,
  type TrainingSessionDraft,
} from "@/lib/training-session";

interface TrainingSessionController {
  isRecording: boolean;
  sessionId: string | null;
  sampleCount: number;
  elapsedMs: number;
  lastSession: TrainingSession | null;
  startRecording: () => void;
  stopRecording: () => void;
  exportLastSession: () => void;
}

function createSessionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `session-${Date.now()}`;
}

export function useTrainingSession(telemetry: FlightTelemetry, source: TelemetrySource): TrainingSessionController {
  const [isRecording, setIsRecording] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sampleCount, setSampleCount] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [lastSession, setLastSession] = useState<TrainingSession | null>(null);
  const draftRef = useRef<TrainingSessionDraft | null>(null);

  const startRecording = useCallback(() => {
    const id = createSessionId();
    draftRef.current = createTrainingSessionDraft(id, source, Date.now(), performance.now());
    setSessionId(id);
    setSampleCount(0);
    setElapsedMs(0);
    setIsRecording(true);
  }, [source]);

  const stopRecording = useCallback(() => {
    const draft = draftRef.current;
    if (!draft) return;
    const session = finishTrainingSession(draft, Date.now(), performance.now());
    draftRef.current = null;
    setLastSession(session);
    setElapsedMs(session.durationMs);
    setSampleCount(session.sampleCount);
    setIsRecording(false);
  }, []);

  useEffect(() => {
    if (!isRecording) return;
    const draft = draftRef.current;
    if (!draft) return;
    if (appendTrainingSessionSample(draft, telemetry, source)) {
      setSampleCount(draft.samples.length);
    }
  }, [isRecording, source, telemetry]);

  useEffect(() => {
    if (!isRecording) return;
    const timer = window.setInterval(() => {
      const draft = draftRef.current;
      if (draft) setElapsedMs(Math.max(0, performance.now() - draft.startedMonotonicMs));
    }, 250);
    return () => window.clearInterval(timer);
  }, [isRecording]);

  const exportLastSession = useCallback(() => {
    if (!lastSession) return;
    const blob = new Blob([serializeTrainingSession(lastSession)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = trainingSessionFilename(lastSession);
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [lastSession]);

  return {
    isRecording,
    sessionId,
    sampleCount,
    elapsedMs,
    lastSession,
    startRecording,
    stopRecording,
    exportLastSession,
  };
}
