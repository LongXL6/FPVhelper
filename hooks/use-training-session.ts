"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionState, FlightTelemetry, TelemetrySource } from "@/lib/telemetry";
import { createTrainingSessionStore, type TrainingSessionStore } from "@/lib/training-session-store";
import {
  appendTrainingSessionSample,
  createTrainingSessionDraft,
  finishTrainingSession,
  normalizeAthleteCode,
  recoverInterruptedTrainingSession,
  serializeTrainingSession,
  trainingSessionFilename,
  type TrainingSession,
  type TrainingSessionDraft,
} from "@/lib/training-session";

const DRAFT_PERSIST_INTERVAL_MS = 5_000;

interface UseTrainingSessionOptions {
  telemetry: FlightTelemetry;
  source: TelemetrySource;
  connection: ConnectionState;
  athleteCode: string;
}

interface TrainingSessionController {
  isRecording: boolean;
  isStarting: boolean;
  isFinishing: boolean;
  sessionId: string | null;
  sampleCount: number;
  elapsedMs: number;
  lastSession: TrainingSession | null;
  storageReady: boolean;
  storageError: string | null;
  recentSessionCount: number;
  canStart: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  exportLastSession: () => void;
}

function createSessionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `session-${Date.now()}`;
}

function storageErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "浏览器本地训练记录存储失败";
}

export function useTrainingSession({
  telemetry,
  source,
  connection,
  athleteCode,
}: UseTrainingSessionOptions): TrainingSessionController {
  const [isRecording, setIsRecording] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sampleCount, setSampleCount] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [lastSession, setLastSession] = useState<TrainingSession | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [recentSessionCount, setRecentSessionCount] = useState(0);
  const draftRef = useRef<TrainingSessionDraft | null>(null);
  const storeRef = useRef<TrainingSessionStore | null>(null);
  const startingRef = useRef(false);
  const finishingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const store = storeRef.current ?? createTrainingSessionStore();
    storeRef.current = store;

    void (async () => {
      try {
        const activeDraft = await store.getActiveDraft();
        if (cancelled) return;
        if (activeDraft) {
          const recovered = recoverInterruptedTrainingSession(activeDraft);
          await store.completeSession(recovered);
        }
        const [sessions, count] = await Promise.all([store.listSessions(1), store.countSessions()]);
        if (cancelled) return;
        const latestSession = sessions[0] ?? null;
        setLastSession(latestSession);
        setSessionId(latestSession?.id ?? null);
        setSampleCount(latestSession?.sampleCount ?? 0);
        setElapsedMs(latestSession?.durationMs ?? 0);
        setRecentSessionCount(count);
        setStorageReady(true);
      } catch (initError) {
        if (cancelled) return;
        setStorageError(storageErrorMessage(initError));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const canStart = useMemo(() => (
    storageReady &&
    storageError === null &&
    !isRecording &&
    !isStarting &&
    !isFinishing &&
    source === "serial" &&
    connection === "live" &&
    normalizeAthleteCode(athleteCode).length > 0
  ), [athleteCode, connection, isFinishing, isRecording, isStarting, source, storageError, storageReady]);

  const startRecording = useCallback(async () => {
    const store = storeRef.current;
    if (!canStart || !store || startingRef.current) return;
    startingRef.current = true;
    setIsStarting(true);
    setStorageError(null);
    const id = createSessionId();
    const draft = createTrainingSessionDraft({
      id,
      athleteCode,
      source,
      startedAtEpochMs: Date.now(),
      startedMonotonicMs: performance.now(),
    });

    try {
      await store.saveDraft(draft);
      draftRef.current = draft;
      setSessionId(id);
      setSampleCount(0);
      setElapsedMs(0);
      setIsRecording(true);
    } catch (saveError) {
      setStorageError(storageErrorMessage(saveError));
    } finally {
      startingRef.current = false;
      setIsStarting(false);
    }
  }, [athleteCode, canStart, source]);

  const finishRecording = useCallback(async (interrupted: boolean) => {
    const draft = draftRef.current;
    const store = storeRef.current;
    if (!draft || !store || finishingRef.current) return;
    finishingRef.current = true;
    setIsFinishing(true);
    setIsRecording(false);

    const session = finishTrainingSession(draft, Date.now(), performance.now(), { interrupted });
    draftRef.current = null;
    setLastSession(session);
    setElapsedMs(session.durationMs);
    setSampleCount(session.sampleCount);

    try {
      await store.completeSession(session);
      setRecentSessionCount(await store.countSessions());
    } catch (saveError) {
      setStorageError(storageErrorMessage(saveError));
    } finally {
      finishingRef.current = false;
      setIsFinishing(false);
    }
  }, []);

  const stopRecording = useCallback(() => finishRecording(false), [finishRecording]);

  useEffect(() => {
    if (!isRecording || source !== "serial" || connection !== "live") return;
    const draft = draftRef.current;
    if (!draft || telemetry.monotonicTimestampMs < draft.startedMonotonicMs) return;
    if (appendTrainingSessionSample(draft, telemetry, source)) {
      setSampleCount(draft.samples.length);
    }
  }, [connection, isRecording, source, telemetry]);

  useEffect(() => {
    if (!isRecording) return;
    if (source !== "serial" || connection !== "live") void finishRecording(true);
  }, [connection, finishRecording, isRecording, source]);

  useEffect(() => {
    if (!isRecording) return;
    const timer = window.setInterval(() => {
      const draft = draftRef.current;
      if (draft) setElapsedMs(Math.max(0, performance.now() - draft.startedMonotonicMs));
    }, 250);
    return () => window.clearInterval(timer);
  }, [isRecording]);

  useEffect(() => {
    if (!isRecording) return;
    const timer = window.setInterval(() => {
      const draft = draftRef.current;
      const store = storeRef.current;
      if (!draft || !store) return;
      void store.saveDraft(draft).catch((saveError: unknown) => {
        setStorageError(storageErrorMessage(saveError));
        void finishRecording(true);
      });
    }, DRAFT_PERSIST_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [finishRecording, isRecording]);

  useEffect(() => {
    const handlePageHide = () => {
      if (draftRef.current) void finishRecording(true);
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [finishRecording]);

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
    isStarting,
    isFinishing,
    sessionId,
    sampleCount,
    elapsedMs,
    lastSession,
    storageReady,
    storageError,
    recentSessionCount,
    canStart,
    startRecording,
    stopRecording,
    exportLastSession,
  };
}
