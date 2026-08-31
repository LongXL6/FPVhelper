"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PUBLIC_APP_BUILD } from "@/lib/app-version";
import type { ConnectionState, FlightTelemetry, LinkState, TelemetrySource } from "@/lib/telemetry";
import {
  createTrainingSessionStore,
  EMPTY_TRAINING_SESSION_STORAGE_INTEGRITY,
  type TrainingSessionStorageIntegrity,
  type TrainingSessionStore,
} from "@/lib/training-session-store";
import {
  appendTrainingSessionMarker,
  appendTrainingSessionSample,
  createTrainingSessionDraft,
  finishTrainingSession,
  markTrainingSessionExported,
  recoverInterruptedTrainingSession,
  resolveTrainingSessionTermination,
  withTrainingSessionTermination,
  withTrainingSessionNotes,
  type TrainingSession,
  type TrainingSessionDraft,
  type TrainingSessionInterruptionReason,
  type TrainingSessionMarkerKind,
  type TrainingSessionTermination,
} from "@/lib/training-session";
import {
  getBrowserTrainingSessionSaveFilePicker,
  saveTrainingSessionWithPicker,
} from "@/lib/training-session-export";
import {
  closeTrainingSessionDirectoryStoreSafely,
  createTrainingSessionDirectoryStore,
  getBrowserTrainingSessionDirectoryPicker,
  getTrainingSessionDirectoryPermission,
  createTrainingSessionDirectoryWritable,
  runTrainingSessionDirectoryAction,
  saveTrainingSessionToDirectory,
  type TrainingSessionDirectoryHandle,
  type TrainingSessionDirectoryStore,
  type TrainingSessionDirectoryWritable,
} from "@/lib/training-session-export-directory";
import {
  countUniqueTrainingSamples,
  shouldWarnBeforeTrainingExit,
} from "@/lib/training-session-summary";
import { getOrCreateBrowserWorkstationId } from "@/lib/workstation-id";
import { canStartTrainingSession } from "./training-session-start-guard";
import {
  combineTrainingSessionExportFailures,
  createTrainingSessionExportReceiptId,
  requestUnconfirmedTrainingSessionDownload,
} from "./training-session-export-feedback";

const DRAFT_PERSIST_INTERVAL_MS = 5_000;

interface UseTrainingSessionOptions {
  telemetry: FlightTelemetry;
  source: TelemetrySource;
  connection: ConnectionState;
  linkState: LinkState;
  athleteCode: string;
  autoExport: boolean;
  inputKey: string;
}

export interface TrainingSessionExportReceipt {
  receiptId: string;
  session: TrainingSession;
  method: "download" | "folder";
  bytes: number;
  exportedAtEpochMs: number;
}

export type TrainingSessionDirectoryState =
  | "loading"
  | "unsupported"
  | "unconfigured"
  | "permission_required"
  | "ready"
  | "error";

interface TrainingSessionController {
  isRecording: boolean;
  isStarting: boolean;
  isFinishing: boolean;
  sessionId: string | null;
  sampleCount: number;
  uniqueSampleCount: number;
  markerCount: number;
  elapsedMs: number;
  lastSession: TrainingSession | null;
  allSessions: TrainingSession[];
  storageReady: boolean;
  storageError: string | null;
  exportNotice: string | null;
  exportWarning: string | null;
  storageIntegrity: TrainingSessionStorageIntegrity;
  recentSessionCount: number;
  unexportedValidCount: number;
  unexportedCount: number;
  hasPendingSave: boolean;
  lastExport: TrainingSessionExportReceipt | null;
  exportDirectoryState: TrainingSessionDirectoryState;
  exportDirectoryName: string | null;
  canStart: boolean;
  startRecording: () => Promise<string | null>;
  stopRecording: () => Promise<void>;
  isSessionRecording: (sessionId: string) => boolean;
  createExportFileWritable: (filename: string) => Promise<TrainingSessionDirectoryWritable>;
  retryPendingSave: () => Promise<void>;
  addMarker: (kind: Exclude<TrainingSessionMarkerKind, "manual">) => Promise<void>;
  updateLastSessionNotes: (notes: string) => Promise<void>;
  exportSession: (sessionId: string) => Promise<void>;
  configureExportDirectory: () => Promise<void>;
  reauthorizeExportDirectory: () => Promise<void>;
  clearExportDirectory: () => Promise<void>;
}

function uniqueLocalId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${prefix}-${Date.now()}-${performance.now().toFixed(3)}-${Math.random().toString(36).slice(2, 10)}`;
}

function storageErrorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "浏览器本地训练记录存储失败";
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

export function useTrainingSession({
  telemetry,
  source,
  connection,
  linkState,
  athleteCode,
  autoExport,
  inputKey,
}: UseTrainingSessionOptions): TrainingSessionController {
  const [isRecording, setIsRecording] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sampleCount, setSampleCount] = useState(0);
  const [uniqueSampleCount, setUniqueSampleCount] = useState(0);
  const [markerCount, setMarkerCount] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [lastSession, setLastSession] = useState<TrainingSession | null>(null);
  const [sessions, setSessions] = useState<TrainingSession[]>([]);
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [exportWarning, setExportWarning] = useState<string | null>(null);
  const [storageIntegrity, setStorageIntegrity] = useState<TrainingSessionStorageIntegrity>(
    EMPTY_TRAINING_SESSION_STORAGE_INTEGRITY,
  );
  const [unexportedValidCount, setUnexportedValidCount] = useState(0);
  const [hasPendingSave, setHasPendingSave] = useState(false);
  const [lastExport, setLastExport] = useState<TrainingSessionExportReceipt | null>(null);
  const [exportDirectoryState, setExportDirectoryState] = useState<TrainingSessionDirectoryState>("loading");
  const [exportDirectoryName, setExportDirectoryName] = useState<string | null>(null);
  const draftRef = useRef<TrainingSessionDraft | null>(null);
  const recordingInputKeyRef = useRef<string | null>(null);
  const pendingSessionRef = useRef<TrainingSession | null>(null);
  const storeRef = useRef<TrainingSessionStore | null>(null);
  const directoryStoreRef = useRef<TrainingSessionDirectoryStore | null>(null);
  const directoryHandleRef = useRef<TrainingSessionDirectoryHandle | null>(null);
  const sessionsRef = useRef<TrainingSession[]>([]);
  const startingRef = useRef(false);
  const finishingRef = useRef(false);
  const workstationIdRef = useRef<string | null>(null);
  const terminationRef = useRef<TrainingSessionTermination | null>(null);

  const applySessions = useCallback((nextSessions: TrainingSession[]) => {
    sessionsRef.current = nextSessions;
    setSessions(nextSessions);
    const latestSession = nextSessions[0] ?? null;
    if (!draftRef.current && !pendingSessionRef.current) {
      setLastSession(latestSession);
      setSessionId(latestSession?.id ?? null);
      setSampleCount(latestSession?.sampleCount ?? 0);
      setUniqueSampleCount(latestSession ? countUniqueTrainingSamples(latestSession.samples) : 0);
      setMarkerCount(latestSession?.markers.length ?? 0);
      setElapsedMs(latestSession?.durationMs ?? 0);
    }
  }, []);

  const refreshSessions = useCallback(async (store: TrainingSessionStore) => {
    const [nextSessions, nextUnexportedValidCount, nextStorageIntegrity] = await Promise.all([
      store.listSessions(),
      store.countUnexportedValidSessions(),
      store.getStorageIntegrity(),
    ]);
    applySessions(nextSessions);
    setUnexportedValidCount(nextUnexportedValidCount);
    setStorageIntegrity(nextStorageIntegrity);
    return nextSessions;
  }, [applySessions]);

  const exportStoredSession = useCallback(async (
    session: TrainingSession,
    store: TrainingSessionStore,
    method: TrainingSessionExportReceipt["method"],
  ) => {
    const exportedAtEpochMs = Date.now();
    const exportedSession = markTrainingSessionExported(session, exportedAtEpochMs);
    const picker = getBrowserTrainingSessionSaveFilePicker();
    if (!picker) {
      const feedback = requestUnconfirmedTrainingSessionDownload(session);
      setExportNotice(feedback.notice);
      setExportWarning(feedback.warning);
      return;
    }

    let bytes: number;
    try {
      bytes = await saveTrainingSessionWithPicker(exportedSession, picker);
    } catch (exportError) {
      setExportNotice(null);
      setExportWarning(`文件保存未完成：${storageErrorMessage(exportError)}；Session 仍安全保存在本机且保持未导出状态。`);
      return;
    }

    setLastExport({
      receiptId: createTrainingSessionExportReceiptId(exportedSession.id, exportedAtEpochMs),
      session: exportedSession,
      method,
      bytes,
      exportedAtEpochMs,
    });

    try {
      await store.saveSession(exportedSession);
      await refreshSessions(store);
      setStorageError(null);
      setExportWarning(null);
      setExportNotice("已确认 JSON 文件写入完成；本机记录已标记为已导出。");
    } catch (saveError) {
      setStorageError(`JSON 文件已写入，但导出状态未写入 IndexedDB：${storageErrorMessage(saveError)}`);
    }
  }, [refreshSessions]);

  const exportStoredSessionToDirectory = useCallback(async (
    session: TrainingSession,
    store: TrainingSessionStore,
  ) => {
    const handle = directoryHandleRef.current;
    if (!handle) {
      return { confirmed: false, reason: "尚未选择自动保存文件夹" };
    }

    const permission = await getTrainingSessionDirectoryPermission(handle);
    if (permission !== "granted") {
      setExportDirectoryState("permission_required");
      return { confirmed: false, reason: "自动保存文件夹需要重新授权" };
    }

    const exportedAtEpochMs = Date.now();
    const exportedSession = markTrainingSessionExported(session, exportedAtEpochMs);
    let bytes: number;
    try {
      bytes = await saveTrainingSessionToDirectory(exportedSession, handle);
    } catch (exportError) {
      const permissionAfterFailure = await getTrainingSessionDirectoryPermission(handle);
      setExportDirectoryState(permissionAfterFailure === "granted" ? "error" : "permission_required");
      return {
        confirmed: false,
        reason: `自动保存文件夹写入失败：${storageErrorMessage(exportError)}`,
      };
    }

    setExportDirectoryState("ready");
    setLastExport({
      receiptId: createTrainingSessionExportReceiptId(exportedSession.id, exportedAtEpochMs),
      session: exportedSession,
      method: "folder",
      bytes,
      exportedAtEpochMs,
    });
    setExportNotice(`已确认 JSON 写入“${handle.name}”；文件关闭完成。再次导出同一 Session 会覆盖同名 JSON。`);
    setExportWarning(null);

    try {
      await store.saveSession(exportedSession);
      await refreshSessions(store);
      setStorageError(null);
    } catch (saveError) {
      setStorageError(`JSON 已写入“${handle.name}”，但导出状态未写入 IndexedDB：${storageErrorMessage(saveError)}`);
    }
    return { confirmed: true, reason: null };
  }, [refreshSessions]);

  useEffect(() => {
    if (!getBrowserTrainingSessionDirectoryPicker()) {
      let cancelled = false;
      void Promise.resolve().then(() => {
        if (!cancelled) setExportDirectoryState("unsupported");
      });
      return () => {
        cancelled = true;
      };
    }

    let cancelled = false;
    const directoryStore = createTrainingSessionDirectoryStore();
    directoryStoreRef.current = directoryStore;
    void (async () => {
      try {
        const handle = await directoryStore.load();
        if (cancelled) return;
        directoryHandleRef.current = handle;
        setExportDirectoryName(handle?.name ?? null);
        if (!handle) {
          setExportDirectoryState("unconfigured");
          return;
        }
        const permission = await getTrainingSessionDirectoryPermission(handle);
        if (cancelled) return;
        setExportDirectoryState(permission === "granted" ? "ready" : "permission_required");
      } catch (directoryError) {
        if (cancelled) return;
        setExportDirectoryState("error");
        setExportWarning(`无法读取自动保存文件夹设置：${storageErrorMessage(directoryError)}`);
      }
    })();

    return () => {
      cancelled = true;
      directoryHandleRef.current = null;
      if (directoryStoreRef.current === directoryStore) directoryStoreRef.current = null;
      void closeTrainingSessionDirectoryStoreSafely(directoryStore);
    };
  }, []);

  const configureExportDirectory = useCallback(async () => {
    const picker = getBrowserTrainingSessionDirectoryPicker();
    const directoryStore = directoryStoreRef.current;
    if (!picker || !directoryStore) {
      setExportDirectoryState("unsupported");
      setExportWarning("当前浏览器不支持文件夹自动保存；请使用最新版 Chrome/Edge，或继续手动导出。");
      return;
    }

    try {
      const existingHandle = directoryHandleRef.current;
      const result = await runTrainingSessionDirectoryAction({
        action: "replace",
        existingHandle,
        picker,
      });
      if (!result.handle || !result.granted) {
        setExportDirectoryState(existingHandle ? "permission_required" : "unconfigured");
        setExportDirectoryName(existingHandle?.name ?? null);
        setExportWarning("新文件夹未获得读写权限，设置未更改；自动保存仍会退回普通浏览器下载。");
        return;
      }
      const handle = result.handle;
      await directoryStore.save(handle);
      directoryHandleRef.current = handle;
      setExportDirectoryState("ready");
      setExportDirectoryName(handle.name);
      setExportWarning(null);
      setExportNotice(`已选择“${handle.name}”；后续有效结束会自动写入 JSON。`);
    } catch (directoryError) {
      if (isAbortError(directoryError)) return;
      setExportDirectoryState("error");
      setExportWarning(`自动保存文件夹设置失败：${storageErrorMessage(directoryError)}`);
    }
  }, []);

  const reauthorizeExportDirectory = useCallback(async () => {
    const existingHandle = directoryHandleRef.current;
    if (!existingHandle) {
      setExportDirectoryState("unconfigured");
      setExportDirectoryName(null);
      setExportWarning("没有可重新授权的文件夹；请先选择文件夹。");
      return;
    }

    try {
      const result = await runTrainingSessionDirectoryAction({
        action: "reauthorize",
        existingHandle,
        picker: null,
      });
      if (!result.granted) {
        setExportDirectoryState("permission_required");
        setExportWarning(`“${existingHandle.name}”未获得读写权限；可再次授权或更换文件夹。`);
        return;
      }
      setExportDirectoryState("ready");
      setExportDirectoryName(existingHandle.name);
      setExportWarning(null);
      setExportNotice(`“${existingHandle.name}”已获得自动保存权限。`);
    } catch (directoryError) {
      setExportDirectoryState("permission_required");
      setExportWarning(`自动保存文件夹重新授权失败：${storageErrorMessage(directoryError)}`);
    }
  }, []);

  const clearExportDirectory = useCallback(async () => {
    const directoryStore = directoryStoreRef.current;
    if (!directoryStore) return;
    try {
      await directoryStore.clear();
      directoryHandleRef.current = null;
      setExportDirectoryName(null);
      setExportDirectoryState("unconfigured");
      setExportWarning(null);
      setExportNotice("已清除自动保存文件夹；需要时可重新选择。");
    } catch (directoryError) {
      setExportDirectoryState("error");
      setExportWarning(`清除自动保存文件夹失败：${storageErrorMessage(directoryError)}`);
    }
  }, []);

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
          try {
            await store.completeSession(recovered);
          } catch (recoveryError) {
            draftRef.current = activeDraft;
            pendingSessionRef.current = recovered;
            setLastSession(recovered);
            setSessionId(recovered.id);
            setSampleCount(recovered.sampleCount);
            setUniqueSampleCount(countUniqueTrainingSamples(recovered.samples));
            setMarkerCount(recovered.markers.length);
            setElapsedMs(recovered.durationMs);
            setHasPendingSave(true);
            setStorageError(`恢复中断记录失败：${storageErrorMessage(recoveryError)}；请重试保存`);
          }
        }
        await refreshSessions(store);
        if (!cancelled) setStorageReady(true);
      } catch (initError) {
        if (cancelled) return;
        setStorageError(storageErrorMessage(initError));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshSessions]);

  const canStart = useMemo(() => canStartTrainingSession({
    storageReady,
    storageError,
    storageIntegrity,
    hasPendingSave,
    isRecording,
    isStarting,
    isFinishing,
    source,
    connection,
    linkState,
    athleteCode,
  }), [athleteCode, connection, hasPendingSave, isFinishing, isRecording, isStarting, linkState, source, storageError, storageIntegrity, storageReady]);

  const startRecording = useCallback(async () => {
    const store = storeRef.current;
    if (!canStart || !store || startingRef.current) return null;
    startingRef.current = true;
    setIsStarting(true);
    setStorageError(null);
    const id = uniqueLocalId("session");

    try {
      const workstationId = workstationIdRef.current ?? getOrCreateBrowserWorkstationId();
      if (!workstationId) {
        throw new Error("无法创建并持久化工作站 ID，请检查浏览器本地存储权限");
      }
      workstationIdRef.current = workstationId;
      const draft = createTrainingSessionDraft({
        id,
        workstationId,
        build: PUBLIC_APP_BUILD,
        athleteCode,
        source,
        startedAtEpochMs: Date.now(),
        startedMonotonicMs: performance.now(),
      });
      await store.saveDraft(draft);
      draftRef.current = draft;
      recordingInputKeyRef.current = inputKey;
      pendingSessionRef.current = null;
      terminationRef.current = null;
      setSessionId(id);
      setSampleCount(0);
      setUniqueSampleCount(0);
      setMarkerCount(0);
      setElapsedMs(0);
      setHasPendingSave(false);
      setIsRecording(true);
      return id;
    } catch (saveError) {
      setStorageError(`开始记录失败：${storageErrorMessage(saveError)}`);
      return null;
    } finally {
      startingRef.current = false;
      setIsStarting(false);
    }
  }, [athleteCode, canStart, inputKey, source]);

  const createExportFileWritable = useCallback(async (filename: string) => {
    const handle = directoryHandleRef.current;
    if (!handle) throw new Error("尚未选择本地保存文件夹");
    const permission = await getTrainingSessionDirectoryPermission(handle);
    if (permission !== "granted") {
      setExportDirectoryState("permission_required");
      throw new Error("本地保存文件夹需要重新授权");
    }
    try {
      const writable = await createTrainingSessionDirectoryWritable(handle, filename);
      setExportDirectoryState("ready");
      return writable;
    } catch (fileError) {
      const permissionAfterFailure = await getTrainingSessionDirectoryPermission(handle);
      setExportDirectoryState(permissionAfterFailure === "granted" ? "error" : "permission_required");
      throw fileError;
    }
  }, []);

  const isSessionRecording = useCallback((targetSessionId: string) => (
    draftRef.current?.id === targetSessionId
    && pendingSessionRef.current === null
    && !finishingRef.current
  ), []);

  const persistPendingSession = useCallback(async () => {
    const draft = draftRef.current;
    const store = storeRef.current;
    if (!draft || !pendingSessionRef.current || !store || finishingRef.current) return;
    finishingRef.current = true;
    setIsFinishing(true);
    setHasPendingSave(true);

    let sessionStored = false;
    let storedSession: TrainingSession | null = null;
    try {
      await store.saveDraft(draft);
      while (true) {
        if (pendingSessionRef.current !== storedSession) {
          storedSession = pendingSessionRef.current;
          if (!storedSession) throw new Error("Session 终止状态丢失");
          await store.completeSession(storedSession);
        }
        await refreshSessions(store);
        if (pendingSessionRef.current === storedSession) break;
      }
      draftRef.current = null;
      recordingInputKeyRef.current = null;
      pendingSessionRef.current = null;
      setHasPendingSave(false);
      setStorageError(null);
      sessionStored = true;
    } catch (saveError) {
      setStorageError(`Session 尚未安全保存：${storageErrorMessage(saveError)}；记录仍保留在本页，可重试`);
    }

    if (sessionStored && autoExport && storedSession) {
      const directoryResult = await exportStoredSessionToDirectory(storedSession, store);
      if (!directoryResult.confirmed && directoryResult.reason) {
        const feedback = requestUnconfirmedTrainingSessionDownload(storedSession);
        const combinedFeedback = combineTrainingSessionExportFailures(directoryResult.reason, feedback);
        setExportNotice(combinedFeedback.notice);
        setExportWarning(combinedFeedback.warning);
      }
    }

    finishingRef.current = false;
    setIsFinishing(false);
  }, [autoExport, exportStoredSessionToDirectory, refreshSessions]);

  const finishRecording = useCallback(async (
    interrupted: boolean,
    interruptionReason: TrainingSessionInterruptionReason | null = null,
  ) => {
    const termination = resolveTrainingSessionTermination(terminationRef.current, {
      interrupted,
      interruptionReason,
    });
    terminationRef.current = termination;

    const pendingSession = pendingSessionRef.current;
    if (pendingSession) {
      const upgradedSession = withTrainingSessionTermination(pendingSession, termination);
      pendingSessionRef.current = upgradedSession;
      setLastSession(upgradedSession);
      if (!finishingRef.current) await persistPendingSession();
      return;
    }

    const draft = draftRef.current;
    if (!draft || finishingRef.current) return;
    setIsRecording(false);
    const session = finishTrainingSession(draft, Date.now(), performance.now(), {
      interrupted: termination.interrupted,
      ...(termination.interruptionReason ? { interruptionReason: termination.interruptionReason } : {}),
    });
    pendingSessionRef.current = session;
    setLastSession(session);
    setElapsedMs(session.durationMs);
    setSampleCount(session.sampleCount);
    setUniqueSampleCount(countUniqueTrainingSamples(session.samples));
    setMarkerCount(session.markers.length);
    await persistPendingSession();
  }, [persistPendingSession]);

  const stopRecording = useCallback(() => linkState === "lost"
    ? finishRecording(true, "rx_link_lost")
    : finishRecording(false), [finishRecording, linkState]);
  const retryPendingSave = useCallback(() => persistPendingSession(), [persistPendingSession]);

  const addMarker = useCallback(async (kind: Exclude<TrainingSessionMarkerKind, "manual">) => {
    const draft = draftRef.current;
    const store = storeRef.current;
    if (!isRecording || !draft || !store) return;
    appendTrainingSessionMarker(draft, {
      id: uniqueLocalId("marker"),
      kind,
      wallClockEpochMs: Date.now(),
      monotonicMs: performance.now(),
    });
    setMarkerCount(draft.markers.length);
    try {
      await store.saveDraft(draft);
      setStorageError(null);
    } catch (saveError) {
      setStorageError(`人工标记尚未写入 IndexedDB：${storageErrorMessage(saveError)}；本页内记录仍保留`);
    }
  }, [isRecording]);

  useEffect(() => {
    if (!isRecording || source !== "serial" || connection !== "live") return;
    if (recordingInputKeyRef.current !== inputKey) return;
    const draft = draftRef.current;
    if (!draft || telemetry.monotonicTimestampMs < draft.startedMonotonicMs) return;
    if (appendTrainingSessionSample(draft, telemetry, source)) {
      setSampleCount(draft.samples.length);
      setUniqueSampleCount(countUniqueTrainingSamples(draft.samples));
    }
  }, [connection, inputKey, isRecording, source, telemetry]);

  useEffect(() => {
    if (!isRecording || recordingInputKeyRef.current === inputKey) return;
    void finishRecording(true, "channel_changed");
  }, [finishRecording, inputKey, isRecording]);

  useEffect(() => {
    if (!isRecording) return;
    if (recordingInputKeyRef.current !== inputKey) return;
    if (source !== "serial" || connection !== "live") {
      void finishRecording(true, "telemetry_unavailable");
    }
  }, [connection, finishRecording, inputKey, isRecording, source]);

  useEffect(() => {
    if (recordingInputKeyRef.current !== inputKey) return;
    if (linkState === "lost" && (isRecording || draftRef.current || pendingSessionRef.current)) {
      void finishRecording(true, "rx_link_lost");
    }
  }, [finishRecording, inputKey, isRecording, linkState]);

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
      void store.saveDraft(draft)
        .then(() => setStorageError(null))
        .catch((saveError: unknown) => {
          setStorageError(`草稿自动保存失败：${storageErrorMessage(saveError)}；请勿关闭页面并检查本机存储`);
        });
    }, DRAFT_PERSIST_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isRecording]);

  useEffect(() => {
    const handlePageHide = () => {
      const draft = draftRef.current;
      const store = storeRef.current;
      if (draft && store) {
        void store.saveDraft(draft).catch((saveError: unknown) => {
          setStorageError(`关页前草稿保存失败：${storageErrorMessage(saveError)}`);
        });
      }
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, []);

  useEffect(() => {
    if (!shouldWarnBeforeTrainingExit({ isRecording, hasPendingSave, unexportedValidCount })) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasPendingSave, isRecording, unexportedValidCount]);

  const updateLastSessionNotes = useCallback(async (notes: string) => {
    const store = storeRef.current;
    const currentSession = sessionsRef.current[0];
    if (!store || !currentSession || hasPendingSave) return;
    const updatedSession = withTrainingSessionNotes(currentSession, notes);
    try {
      await store.saveSession(updatedSession);
      await refreshSessions(store);
      setStorageError(null);
    } catch (saveError) {
      setStorageError(`训练备注尚未保存：${storageErrorMessage(saveError)}`);
    }
  }, [hasPendingSave, refreshSessions]);

  const exportSession = useCallback(async (targetSessionId: string) => {
    const store = storeRef.current;
    const session = sessionsRef.current.find((candidate) => candidate.id === targetSessionId);
    if (!store || !session) return;
    await exportStoredSession(session, store, "download");
  }, [exportStoredSession]);

  return {
    isRecording,
    isStarting,
    isFinishing,
    sessionId,
    sampleCount,
    uniqueSampleCount,
    markerCount,
    elapsedMs,
    lastSession,
    allSessions: sessions,
    storageReady,
    storageError,
    exportNotice,
    exportWarning,
    storageIntegrity,
    recentSessionCount: sessions.length,
    unexportedValidCount,
    unexportedCount: sessions.filter((session) => session.exportedAt === null).length,
    hasPendingSave,
    lastExport,
    exportDirectoryState,
    exportDirectoryName,
    canStart,
    startRecording,
    stopRecording,
    isSessionRecording,
    createExportFileWritable,
    retryPendingSave,
    addMarker,
    updateLastSessionNotes,
    exportSession,
    configureExportDirectory,
    reauthorizeExportDirectory,
    clearExportDirectory,
  };
}
