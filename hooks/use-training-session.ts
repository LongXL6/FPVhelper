"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { measurementEnabled, measurementEvent, measurementIdentity, measurementSampleFields } from "@/lib/capture-measurement";
import { hasCurrentSessionExport, sessionFinalization } from "@/lib/training-session-metadata";
import { PUBLIC_APP_BUILD } from "@/lib/app-version";
import type { TrainingSessionSummary } from "@/lib/training-session-index";
import type { LocalVideoRecordingReceipt } from "@/lib/local-video-recording";
import type { ConnectionState, FlightTelemetry, LinkState, SubscribeTelemetrySamples, TelemetrySource } from "@/lib/telemetry";
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
  trainingSessionFilename,
  type TrainingSession,
  type TrainingSessionDraft,
  type TrainingSessionInterruptionReason,
  type TrainingSessionMarkerKind,
  type TrainingSessionTermination,
} from "@/lib/training-session";
import {
  getBrowserTrainingSessionSaveFilePicker,
  saveTrainingSessionWithPicker,
  type TrainingSessionSaveFilePicker,
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

const DRAFT_PERSIST_INTERVAL_MS = 1_000;

interface UseTrainingSessionOptions {
  telemetry: FlightTelemetry;
  source: TelemetrySource;
  connection: ConnectionState;
  linkState: LinkState;
  athleteCode: string;
  autoExport: boolean;
  inputKey: string;
  subscribeSamples?: SubscribeTelemetrySamples;
  finishCompanionRecording?: () => Promise<LocalVideoRecordingReceipt | null>;
  companionRecordingStarted?: () => boolean;
}

export interface TrainingSessionExportResult {
  status: "confirmed" | "requested" | "cancelled" | "failed";
  message: string;
  localStateSaved: boolean;
}

export interface TrainingSessionExportReceipt {
  receiptId: string;
  session: TrainingSession;
  method: "download" | "folder";
  bytes: number;
  filename?: string;
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
  hasPendingMedia: boolean;
  rcConfirmedSessionId: string | null;
  pendingTerminationSessionId: string | null;
  mediaPhase: "idle" | "finishing" | "awaiting_rc" | "associating" | "association_failed";
  mediaAssociationError: string | null;
  retryMediaAssociation: () => Promise<void>;
  sessionId: string | null;
  sampleCount: number;
  uniqueSampleCount: number;
  markerCount: number;
  elapsedMs: number;
  lastSession: TrainingSession | null;
  allSessions: TrainingSessionSummary[];
  loadSession: (id: string) => Promise<TrainingSession | null>;
  loadSessionsForReport: () => Promise<TrainingSession[]>;
  persistedSampleCount: number;
  persistedElapsedMs: number;
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
  updateSessionNotes: (sessionId: string, notes: string) => Promise<void>;
  updateLastSessionNotes: (notes: string) => Promise<void>;
  exportSession: (sessionId: string, notesOverride?: string) => Promise<TrainingSessionExportResult>;
  configureExportDirectory: () => Promise<void>;
  reauthorizeExportDirectory: () => Promise<void>;
  clearExportDirectory: () => Promise<void>;
}

interface MediaFinalizationOperation {
  sessionId: string;
  operationId: string;
  expected: boolean;
  inputKey: string;
  pendingTermination: TrainingSessionTermination | null;
  settled: boolean;
  receipt: LocalVideoRecordingReceipt | null;
  associated: boolean;
  associating: Promise<void> | null;
  autoExport: boolean;
  autoExportRequested: boolean;
  exportDirectory: TrainingSessionDirectoryHandle | null;
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
  subscribeSamples,
  finishCompanionRecording,
  companionRecordingStarted,
}: UseTrainingSessionOptions): TrainingSessionController {
  const [isRecording, setIsRecording] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const [rcConfirmedSessionId, setRcConfirmedSessionId] = useState<string | null>(null);
  const rcConfirmedSessionIdRef = useRef<string | null>(null);
  const [pendingTerminationSessionId, setPendingTerminationSessionId] = useState<string | null>(null);
  const [mediaPhase, setMediaPhase] = useState<TrainingSessionController["mediaPhase"]>("idle");
  const [mediaAssociationError, setMediaAssociationError] = useState<string | null>(null);
  const hasPendingMedia = mediaPhase !== "idle";
  const mediaOperationRef = useRef<MediaFinalizationOperation | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sampleCount, setSampleCount] = useState(0);
  const [uniqueSampleCount, setUniqueSampleCount] = useState(0);
  const [markerCount, setMarkerCount] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [lastSession, setLastSession] = useState<TrainingSession | null>(null);
  const [sessions, setSessions] = useState<TrainingSessionSummary[]>([]);
  const [persistedSampleCount, setPersistedSampleCount] = useState(0);
  const [persistedElapsedMs, setPersistedElapsedMs] = useState(0);
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
  const recordingActiveRef = useRef(false);
  const uniqueSequencesRef = useRef<{ draftId: string; sequences: Set<number> } | null>(null);
  const recordingInputKeyRef = useRef<string | null>(null);
  const pendingSessionRef = useRef<TrainingSession | null>(null);
  const completedPendingSessionRef = useRef<TrainingSession | null>(null);
  const storeRef = useRef<TrainingSessionStore | null>(null);
  const directoryStoreRef = useRef<TrainingSessionDirectoryStore | null>(null);
  const directoryHandleRef = useRef<TrainingSessionDirectoryHandle | null>(null);
  const sessionsRef = useRef<TrainingSessionSummary[]>([]);
  const draftSaveRef = useRef<Promise<void> | null>(null);
  const companionFinishingRef = useRef(false);
  const startingRef = useRef(false);
  const finishingRef = useRef(false);
  const workstationIdRef = useRef<string | null>(null);
  const terminationRef = useRef<TrainingSessionTermination | null>(null);
  const noteSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const sessionMutationIdsRef = useRef(new Set<string>());
  const exportWaitersRef = useRef(new Map<string, Promise<void>>());

  const applySessions = useCallback((nextSessions: TrainingSessionSummary[], latestSession: TrainingSession | null) => {
    sessionsRef.current = nextSessions;
    setSessions(nextSessions);
    if (!draftRef.current && !pendingSessionRef.current) {
      rcConfirmedSessionIdRef.current = latestSession?.id ?? null;
      setRcConfirmedSessionId(latestSession?.id ?? null);
      setLastSession(latestSession);
      setSessionId(latestSession?.id ?? null);
      setSampleCount(latestSession?.sampleCount ?? 0);
      setUniqueSampleCount(latestSession ? countUniqueTrainingSamples(latestSession.samples) : 0);
      setMarkerCount(latestSession?.markers.length ?? 0);
      setElapsedMs(latestSession?.durationMs ?? 0);
      setPersistedSampleCount(latestSession?.sampleCount ?? 0);
      setPersistedElapsedMs(latestSession?.samples.at(-1)?.elapsedMs ?? 0);
    }
  }, []);

  const refreshSessions = useCallback(async (store: TrainingSessionStore) => {
    const [nextSessions, nextUnexportedValidCount, nextStorageIntegrity] = await Promise.all([
      store.listSessionSummaries(),
      store.countUnexportedValidSessions(),
      store.getStorageIntegrity(),
    ]);
    const latestId = mediaOperationRef.current?.sessionId ?? nextSessions[0]?.id;
    const latestSession = latestId ? await store.getSession(latestId) : null;
    applySessions(nextSessions, latestSession);
    setUnexportedValidCount(nextUnexportedValidCount);
    setStorageIntegrity(nextStorageIntegrity);
    return nextSessions;
  }, [applySessions]);

  const loadSession = useCallback(async (id: string) => (
    pendingSessionRef.current?.id === id && rcConfirmedSessionIdRef.current !== id ? pendingSessionRef.current : await storeRef.current?.getSession(id) ?? null
  ), []);
  const loadSessionsForReport = useCallback(async () => await storeRef.current?.listSessions() ?? [], []);

  const persistDraft = useCallback(async (draft: TrainingSessionDraft) => {
    // Coalesce timer writes; callers adding markers/finalizing can request a fresh checkpoint after this one.
    if (draftSaveRef.current) await draftSaveRef.current.catch(() => undefined);
    const store = storeRef.current;
    if (!store) throw new Error("训练存储尚未就绪");
    const count = draft.samples.length;
    const elapsed = draft.samples.at(-1)?.elapsedMs ?? 0;
    const save = store.saveDraft(draft).then(() => {
      if (draftRef.current?.id === draft.id) {
        setPersistedSampleCount(count);
        setPersistedElapsedMs(elapsed);
      }
    });
    draftSaveRef.current = save;
    try {
      await save;
      if (measurementEnabled()) measurementEvent("session.checkpoint.confirmed", {
        sessionId: draft.id, sampleCount: count, elapsedMs: elapsed,
        operationId: measurementIdentity(save, "checkpoint"),
      });
    }
    catch (error) {
      if (measurementEnabled()) measurementEvent("session.checkpoint.failed", {
        sessionId: draft.id, sampleCount: count, operationId: measurementIdentity(save, "checkpoint"),
      });
      throw error;
    }
    finally { if (draftSaveRef.current === save) draftSaveRef.current = null; }
  }, []);

  const exportStoredSession = useCallback(async (
    session: TrainingSession,
    store: TrainingSessionStore,
    method: TrainingSessionExportReceipt["method"],
    openedPicker?: TrainingSessionSaveFilePicker | null,
  ): Promise<TrainingSessionExportResult> => {
    const exportedAtEpochMs = Date.now();
    const exportedSession = markTrainingSessionExported(session, exportedAtEpochMs);
    const picker = openedPicker === undefined ? getBrowserTrainingSessionSaveFilePicker() : openedPicker;
    if (!picker) {
      const feedback = requestUnconfirmedTrainingSessionDownload(session);
      setExportNotice(feedback.notice);
      setExportWarning(feedback.warning);
      return {
        status: feedback.warning ? "failed" : "requested",
        message: feedback.warning ?? feedback.notice ?? "已请求下载但未确认落盘。",
        localStateSaved: true,
      };
    }

    let bytes: number;
    try {
      bytes = await saveTrainingSessionWithPicker(exportedSession, picker);
    } catch (exportError) {
      const message = isAbortError(exportError)
        ? "已取消文件保存；本机记录仍保留，导出状态未改变。"
        : `文件保存未完成：${storageErrorMessage(exportError)}；本机记录仍保留，导出状态未改变。`;
      setExportNotice(null);
      setExportWarning(message);
      return { status: isAbortError(exportError) ? "cancelled" : "failed", message, localStateSaved: true };
    }

    setLastExport({
      receiptId: createTrainingSessionExportReceiptId(exportedSession.id, exportedAtEpochMs),
      session: exportedSession,
      method,
      bytes,
      exportedAtEpochMs,
    });

    try {
      await store.patchSession(session.id, { kind: "export", exportedAtEpochMs, snapshotRevision: sessionFinalization(session).contentRevision });
      await refreshSessions(store);
      setStorageError(null);
      setExportWarning(null);
      setExportNotice("已确认 JSON 文件写入完成；本机记录已标记为已导出。");
      return { status: "confirmed", message: "已确认 JSON 文件写入完成；本机记录已标记为已导出。", localStateSaved: true };
    } catch (saveError) {
      const message = `JSON 文件已写入，但导出状态未写入 IndexedDB：${storageErrorMessage(saveError)}`;
      setStorageError(message);
      setExportNotice(null);
      setExportWarning(message);
      return { status: "confirmed", message, localStateSaved: false };
    }
  }, [refreshSessions]);

  const exportStoredSessionToDirectory = useCallback(async (
    session: TrainingSession,
    store: TrainingSessionStore,
    handle: TrainingSessionDirectoryHandle | null,
  ): Promise<{ confirmed: boolean; reason: string | null; filename?: string; localStateSaved: boolean }> => {
    if (!handle) {
      return { confirmed: false, reason: "尚未选择自动保存文件夹", localStateSaved: true };
    }

    const ownsStorageStatus = () => {
      const currentId = draftRef.current?.id ?? pendingSessionRef.current?.id ?? mediaOperationRef.current?.sessionId;
      return !currentId || currentId === session.id;
    };
    const permission = await getTrainingSessionDirectoryPermission(handle);
    if (permission !== "granted") {
      if (directoryHandleRef.current === handle) setExportDirectoryState("permission_required");
      return { confirmed: false, reason: `记录 ${session.id.slice(0, 8)} 的自动保存文件夹“${handle.name}”需要重新授权`, localStateSaved: true };
    }

    const exportedAtEpochMs = Date.now();
    const exportedSession = markTrainingSessionExported(session, exportedAtEpochMs);
    let receipt: { bytes: number; filename: string };
    try {
      receipt = await saveTrainingSessionToDirectory(exportedSession, handle);
    } catch (exportError) {
      const permissionAfterFailure = await getTrainingSessionDirectoryPermission(handle);
      if (directoryHandleRef.current === handle) setExportDirectoryState(permissionAfterFailure === "granted" ? "error" : "permission_required");
      return {
        confirmed: false,
        reason: `记录 ${session.id.slice(0, 8)} 的自动保存文件夹“${handle.name}”写入失败：${storageErrorMessage(exportError)}`,
        localStateSaved: true,
      };
    }

    if (directoryHandleRef.current === handle) setExportDirectoryState("ready");
    setLastExport({
      receiptId: createTrainingSessionExportReceiptId(exportedSession.id, exportedAtEpochMs),
      session: exportedSession,
      method: "folder",
      bytes: receipt.bytes,
      filename: receipt.filename,
      exportedAtEpochMs,
    });
    setExportNotice(`已保存“${receipt.filename}”到“${handle.name}”，写入与关闭已完成；已有文件保留。`);
    setExportWarning(null);

    try {
      await store.patchSession(session.id, { kind: "export", exportedAtEpochMs, snapshotRevision: sessionFinalization(session).contentRevision });
      await refreshSessions(store);
      if (ownsStorageStatus()) setStorageError(null);
    } catch (saveError) {
      const message = `记录 ${session.id.slice(0, 8)} 的 JSON 已写入“${handle.name}”，但导出状态未写入 IndexedDB：${storageErrorMessage(saveError)}`;
      if (ownsStorageStatus()) setStorageError(message);
      setExportWarning(message);
      return { confirmed: true, reason: null, filename: receipt.filename, localStateSaved: false };
    }
    return { confirmed: true, reason: null, filename: receipt.filename, localStateSaved: true };
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
      setExportNotice("已清除后续记录的自动保存文件夹；已停止记录的待完成导出仍使用原文件夹，需要时可重新选择。");
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

  const canStart = useMemo(() => !hasPendingMedia && canStartTrainingSession({
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
  }), [athleteCode, connection, hasPendingMedia, hasPendingSave, isFinishing, isRecording, isStarting, linkState, source, storageError, storageIntegrity, storageReady]);

  const startRecording = useCallback(async () => {
    const store = storeRef.current;
    if (measurementEnabled()) measurementEvent("session.start.requested", {
      sessionHookId: measurementIdentity(draftRef, "session-hook"), inputKey, canStart,
    });
    if (!canStart || !store || startingRef.current || recordingActiveRef.current || finishingRef.current || pendingSessionRef.current || (mediaOperationRef.current && !mediaOperationRef.current.associated)) return null;
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
      completedPendingSessionRef.current = null;
      terminationRef.current = null;
      mediaOperationRef.current = null;
      rcConfirmedSessionIdRef.current = null;
      setRcConfirmedSessionId(null);
      setPendingTerminationSessionId(null);
      setMediaPhase("idle");
      setMediaAssociationError(null);
      uniqueSequencesRef.current = { draftId: draft.id, sequences: new Set() };
      recordingActiveRef.current = true;
      if (measurementEnabled()) measurementEvent("session.start.confirmed", {
        sessionHookId: measurementIdentity(draftRef, "session-hook"), sessionId: id, inputKey,
        startedMonotonicMs: draft.startedMonotonicMs,
      });
      setSessionId(id);
      setSampleCount(0);
      setUniqueSampleCount(0);
      setMarkerCount(0);
      setElapsedMs(0);
      setPersistedSampleCount(0);
      setPersistedElapsedMs(0);
      setHasPendingSave(false);
      setIsRecording(true);
      return id;
    } catch (saveError) {
      if (measurementEnabled()) measurementEvent("session.start.failed", {
        sessionHookId: measurementIdentity(draftRef, "session-hook"), sessionId: id, inputKey,
      });
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
    try {
      let stored = completedPendingSessionRef.current;
      if (!stored) {
        await persistDraft(draft);
        stored = pendingSessionRef.current;
        if (!stored) throw new Error("Session 终态丢失");
        await store.completeSession(stored);
        completedPendingSessionRef.current = stored;
        rcConfirmedSessionIdRef.current = stored.id;
        setRcConfirmedSessionId(stored.id);
        setPersistedSampleCount(stored.sampleCount);
        setPersistedElapsedMs(stored.samples.at(-1)?.elapsedMs ?? 0);
        if (measurementEnabled()) measurementEvent("session.complete.confirmed", { sessionId: stored.id, sampleCount: stored.sampleCount });
      }
      // A later, stronger termination is metadata only; never overwrite notes/exports or reopen a draft.
      while (pendingSessionRef.current && (pendingSessionRef.current.interrupted !== stored.interrupted
        || pendingSessionRef.current.interruptionReason !== stored.interruptionReason)) {
        const updated = await store.patchSession(stored.id, { kind: "termination", termination: pendingSessionRef.current });
        stored = { ...stored, ...updated };
        completedPendingSessionRef.current = stored;
      }
      draftRef.current = null;
      uniqueSequencesRef.current = null;
      recordingInputKeyRef.current = null;
      pendingSessionRef.current = null;
      completedPendingSessionRef.current = null;
      setHasPendingSave(false);
      setPendingTerminationSessionId(null);
      setStorageError(null);
      setLastSession(stored);
      setPersistedSampleCount(stored.sampleCount);
      setPersistedElapsedMs(stored.samples.at(-1)?.elapsedMs ?? 0);
      setIsFinishing(false);
      try { await refreshSessions(store); }
      catch (error) { setStorageError(`遥控数据已保存，记录列表刷新失败：${storageErrorMessage(error)}；可重试刷新`); }
    } catch (error) {
      if (measurementEnabled()) measurementEvent("session.complete.failed", { sessionId: draft.id, sampleCount: draft.samples.length });
      if (completedPendingSessionRef.current) setPendingTerminationSessionId(draft.id);
      setStorageError(completedPendingSessionRef.current
        ? `遥控样本已入库，终止状态尚未更新：${storageErrorMessage(error)}；请重试保存`
        : `遥控数据尚未安全保存：${storageErrorMessage(error)}；记录仍保留在本页，可重试`);
    } finally {
      finishingRef.current = false;
      setIsFinishing(false);
    }
  }, [persistDraft, refreshSessions]);

  const persistTermination = useCallback(async (operation: MediaFinalizationOperation) => {
    const termination = operation.pendingTermination;
    const store = storeRef.current;
    if (!termination || !store) return;
    try {
      await store.patchSession(operation.sessionId, { kind: "termination", termination });
      if (operation.pendingTermination === termination) { operation.pendingTermination = null; setPendingTerminationSessionId(null); }
      setHasPendingSave(Boolean(pendingSessionRef.current || operation.pendingTermination));
      setStorageError(null);
    } catch (error) {
      setHasPendingSave(true);
      setPendingTerminationSessionId(operation.sessionId);
      setStorageError(`遥控样本已入库，终止状态尚未更新：${storageErrorMessage(error)}；请重试保存`);
      throw error;
    }
  }, []);

  const associateMedia = useCallback(async (operation: MediaFinalizationOperation) => {
    if (!operation.settled || operation.associated || pendingSessionRef.current?.id === operation.sessionId) return;
    if (operation.associating) return operation.associating;
    const store = storeRef.current;
    if (!store) return;
    const work = (async () => {
      if (mediaOperationRef.current === operation) setMediaPhase("associating");
      try {
        await persistTermination(operation);
        if (operation.expected) await store.patchSession(operation.sessionId, { kind: "media", operationId: operation.operationId, receipt: operation.receipt });
        else if (operation.receipt) throw new Error("未请求的录像返回了收据，关联已拒绝");
        operation.associated = true;
        if (mediaOperationRef.current === operation) { setMediaPhase("idle"); setMediaAssociationError(null); }
        if (operation.expected) {
          try { await refreshSessions(store); setStorageError(null); }
          catch (error) { setStorageError(`遥控数据与媒体状态已入库，列表刷新失败：${storageErrorMessage(error)}`); }
        }
      } catch (error) {
        if (mediaOperationRef.current === operation) {
          setMediaPhase("association_failed");
          setMediaAssociationError(`${operation.receipt ? "视频文件写入与关闭已完成，但收据关联失败" : "媒体结果尚未关联"}：${storageErrorMessage(error)}；可仅重试关联`);
        }
        return;
      }
      if (operation.autoExport && !operation.autoExportRequested) {
        operation.autoExportRequested = true;
        // An early RC export can still be closing when video arrives. Wait for its confirmed metadata
        // before capturing the automatic final JSON; the media patch and RC saved state do not wait.
        while (sessionMutationIdsRef.current.has(operation.sessionId)) {
          await (exportWaitersRef.current.get(operation.sessionId) ?? noteSaveQueueRef.current).catch(() => undefined);
        }
        sessionMutationIdsRef.current.add(operation.sessionId);
        try {
          const latest = await store.getSession(operation.sessionId);
          if (!latest) { setExportWarning("遥控记录已保存，自动导出前无法读取记录；可在记录页重试导出"); return; }
          const result = await exportStoredSessionToDirectory(latest, store, operation.exportDirectory);
          if (!result.confirmed && result.reason) {
            const feedback = combineTrainingSessionExportFailures(result.reason, requestUnconfirmedTrainingSessionDownload(latest));
            setExportNotice(feedback.notice); setExportWarning(feedback.warning);
          }
        } finally { sessionMutationIdsRef.current.delete(operation.sessionId); }
      }
    })();
    operation.associating = work;
    try { await work; }
    catch (error) { setExportWarning(`遥控数据已保存，后续导出未完成：${storageErrorMessage(error)}`); }
    finally { operation.associating = null; }
  }, [exportStoredSessionToDirectory, persistTermination, refreshSessions]);

  const retryMediaAssociation = useCallback(async () => {
    const operation = mediaOperationRef.current;
    if (operation) await associateMedia(operation);
  }, [associateMedia]);

  const finishRecording = useCallback(async (
    interrupted: boolean,
    interruptionReason: TrainingSessionInterruptionReason | null = null,
  ) => {
    if (measurementEnabled()) measurementEvent("session.stop.requested", {
      sessionHookId: measurementIdentity(draftRef, "session-hook"), sessionId: draftRef.current?.id ?? null,
      interrupted, interruptionReason,
    });
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
      if (mediaOperationRef.current) await associateMedia(mediaOperationRef.current);
      return;
    }

    const draft = draftRef.current;
    if (!draft || finishingRef.current) {
      const operation = mediaOperationRef.current;
      if (!draft && operation && !operation.associated && storeRef.current) {
        operation.pendingTermination = termination;
        setLastSession((current) => current?.id === operation.sessionId ? withTrainingSessionTermination(current, termination) : current);
        try { await persistTermination(operation); await refreshSessions(storeRef.current); }
        catch { /* Explicit pending termination and error remain retryable without a draft. */ }
      }
      return;
    }
    recordingActiveRef.current = false;
    setIsRecording(false);
    const frozen = finishTrainingSession(draft, Date.now(), performance.now(), {
      interrupted: termination.interrupted,
      ...(termination.interruptionReason ? { interruptionReason: termination.interruptionReason } : {}),
    });
    const operation: MediaFinalizationOperation = { sessionId: frozen.id, operationId: uniqueLocalId("media"),
      expected: companionRecordingStarted?.() ?? Boolean(finishCompanionRecording), inputKey, pendingTermination: null, settled: !finishCompanionRecording,
      receipt: null, associated: false, associating: null, autoExport, autoExportRequested: false,
      // Capture while recording controls still own this folder, before late media/export waits.
      exportDirectory: directoryHandleRef.current };
    mediaOperationRef.current = operation;
    const session: TrainingSession = { ...frozen, finalization: { version: 1, contentRevision: 0, confirmedExportRevision: null,
      media: { state: operation.expected ? "pending" : "not_requested", operationId: operation.expected ? operation.operationId : null } } };
    pendingSessionRef.current = session;
    if (measurementEnabled()) measurementEvent("session.stop.frozen", {
      sessionHookId: measurementIdentity(draftRef, "session-hook"), sessionId: session.id,
      sampleCount: session.sampleCount, durationMs: session.durationMs,
      lastSequence: session.samples.at(-1)?.sequence ?? null,
    });
    setHasPendingSave(true);
    setLastSession(session);
    setElapsedMs(session.durationMs);
    setSampleCount(session.sampleCount);
    setUniqueSampleCount(countUniqueTrainingSamples(session.samples));
    setMarkerCount(session.markers.length);
    if (finishCompanionRecording) {
      companionFinishingRef.current = true;
      setMediaPhase("finishing");
      // Invoke synchronously before database awaits; stop requests must not queue behind storage.
      let completion: Promise<LocalVideoRecordingReceipt | null>;
      try { completion = finishCompanionRecording(); } catch (error) { completion = Promise.reject(error); }
      void completion.then((receipt) => { operation.receipt = receipt; }).catch((error: unknown) => {
        setExportWarning(`视频未完整保存，遥控数据独立保存：${storageErrorMessage(error)}`);
      }).finally(async () => {
        operation.settled = true;
        if (mediaOperationRef.current === operation) { companionFinishingRef.current = false; setMediaPhase("awaiting_rc"); }
        await associateMedia(operation);
      });
    }
    await persistPendingSession();
    await associateMedia(operation);
  }, [associateMedia, autoExport, companionRecordingStarted, finishCompanionRecording, inputKey, persistPendingSession, persistTermination, refreshSessions]);

  const stopRecording = useCallback(() => linkState === "lost"
    ? finishRecording(true, "rx_link_lost")
    : finishRecording(false), [finishRecording, linkState]);
  const retryPendingSave = useCallback(async () => {
    if (pendingSessionRef.current) await persistPendingSession();
    else if (storeRef.current) { try { if (mediaOperationRef.current) await persistTermination(mediaOperationRef.current); await refreshSessions(storeRef.current); setStorageError(null); } catch (error) { setStorageError(storageErrorMessage(error)); } }
    if (mediaOperationRef.current) await associateMedia(mediaOperationRef.current);
  }, [associateMedia, persistPendingSession, persistTermination, refreshSessions]);

  const addMarker = useCallback(async (kind: Exclude<TrainingSessionMarkerKind, "manual">) => {
    const draft = draftRef.current;
    const store = storeRef.current;
    if (!isRecording || !recordingActiveRef.current || pendingSessionRef.current || finishingRef.current || !draft || !store) return;
    appendTrainingSessionMarker(draft, {
      id: uniqueLocalId("marker"),
      kind,
      wallClockEpochMs: Date.now(),
      monotonicMs: performance.now(),
    });
    setMarkerCount(draft.markers.length);
    try {
      await persistDraft(draft);
      setStorageError(null);
    } catch (saveError) {
      setStorageError(`人工标记尚未写入 IndexedDB：${storageErrorMessage(saveError)}；本页内记录仍保留`);
    }
  }, [isRecording, persistDraft]);

  const recordTelemetrySample = useCallback(function recordTelemetrySample(sample: FlightTelemetry, sampleSource: TelemetrySource) {
    const fields = measurementEnabled() ? {
      ...measurementSampleFields(sample), consumerId: measurementIdentity(recordTelemetrySample, "consumer"),
      sessionHookId: measurementIdentity(draftRef, "session-hook"), sessionId: draftRef.current?.id ?? null,
      inputKey, recordingInputKey: recordingInputKeyRef.current, sampleSource,
    } : null;
    if (!recordingActiveRef.current || source !== "serial" || sampleSource !== "serial" || connection !== "live" || linkState === "lost") {
      if (fields) measurementEvent("session.sample.rejected", { ...fields, reason:
        !recordingActiveRef.current ? "not_recording" : source !== "serial" ? "source_not_serial"
          : sampleSource !== "serial" ? "sample_not_serial" : connection !== "live" ? "connection_not_live" : "link_lost" });
      return;
    }
    if (recordingInputKeyRef.current !== inputKey) {
      if (fields) measurementEvent("session.sample.rejected", { ...fields, reason: "input_changed" });
      return;
    }
    const draft = draftRef.current;
    if (!draft || pendingSessionRef.current || finishingRef.current || sample.monotonicTimestampMs < draft.startedMonotonicMs) {
      if (fields) measurementEvent("session.sample.rejected", { ...fields, reason:
        !draft ? "no_draft" : pendingSessionRef.current ? "pending_session" : finishingRef.current ? "finishing" : "before_start" });
      return;
    }
    if (appendTrainingSessionSample(draft, sample, sampleSource)) {
      if (fields) measurementEvent("session.sample.appended", { ...fields, accepted: true, sampleCount: draft.samples.length });
      if (uniqueSequencesRef.current?.draftId !== draft.id) {
        uniqueSequencesRef.current = { draftId: draft.id, sequences: new Set(draft.samples.map((entry) => entry.sequence)) };
      }
      uniqueSequencesRef.current.sequences.add(sample.sequence);
    } else if (fields) {
      measurementEvent("session.sample.duplicate", { ...fields, accepted: false, reason: "adjacent_sequence_source" });
    }
  }, [connection, inputKey, linkState, source]);

  useEffect(() => {
    if (subscribeSamples) return;
    recordTelemetrySample(telemetry, source);
  }, [recordTelemetrySample, source, subscribeSamples, telemetry]);

  useEffect(() => subscribeSamples?.(recordTelemetrySample), [recordTelemetrySample, subscribeSamples]);

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
    const operation = mediaOperationRef.current;
    const originalInput = recordingInputKeyRef.current ?? (operation && !operation.associated ? operation.inputKey : null);
    if (originalInput !== inputKey) return;
    if (linkState === "lost" && (isRecording || draftRef.current || pendingSessionRef.current || (operation && !operation.associated))) {
      void finishRecording(true, "rx_link_lost");
    }
  }, [finishRecording, inputKey, isRecording, linkState]);

  useEffect(() => {
    if (!isRecording || !sessionId) return;
    let cancelled = false;
    // Start publishes zero counts; later ticks publish only changed progress for this Session.
    let publishedSampleCount = 0;
    let publishedUniqueSampleCount = 0;
    const timer = window.setInterval(() => {
      const draft = draftRef.current;
      if (cancelled || !recordingActiveRef.current || draft?.id !== sessionId) return;
      setElapsedMs(Math.max(0, performance.now() - draft.startedMonotonicMs));
      const unique = uniqueSequencesRef.current;
      if (unique?.draftId !== draft.id) return;
      const count = draft.samples.length;
      const uniqueCount = unique.sequences.size;
      if (count === publishedSampleCount && uniqueCount === publishedUniqueSampleCount) return;
      publishedSampleCount = count;
      publishedUniqueSampleCount = uniqueCount;
      setSampleCount(count);
      setUniqueSampleCount(uniqueCount);
    }, 250);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isRecording, sessionId]);

  useEffect(() => {
    if (!isRecording) return;
    const timer = window.setInterval(() => {
      const draft = draftRef.current;
      const store = storeRef.current;
      if (!draft || !store || draftSaveRef.current) return;
      void persistDraft(draft)
        .then(() => setStorageError(null))
        .catch((saveError: unknown) => {
          setStorageError(`草稿自动保存失败：${storageErrorMessage(saveError)}；请勿关闭页面并检查本机存储`);
        });
    }, DRAFT_PERSIST_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isRecording, persistDraft]);

  useEffect(() => {
    const handlePageHide = () => {
      const draft = draftRef.current;
      const store = storeRef.current;
      if (draft && store && recordingActiveRef.current && !pendingSessionRef.current && !finishingRef.current && !companionFinishingRef.current) {
        void persistDraft(draft).catch((saveError: unknown) => {
          setStorageError(`关页前草稿保存失败：${storageErrorMessage(saveError)}`);
        });
      }
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [persistDraft]);

  useEffect(() => {
    if (!shouldWarnBeforeTrainingExit({ isRecording, hasPendingSave: hasPendingSave || hasPendingMedia, unexportedValidCount })) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasPendingMedia, hasPendingSave, isRecording, unexportedValidCount]);

  const updateSessionNotes = useCallback((targetSessionId: string, notes: string) => {
    if (sessionMutationIdsRef.current.has(targetSessionId)) {
      return Promise.reject(new Error("这条记录正在保存或导出，请完成后重试。备注草稿仍保留在页面中。"));
    }
    sessionMutationIdsRef.current.add(targetSessionId);
    const save = noteSaveQueueRef.current.catch(() => undefined).then(async () => {
      const store = storeRef.current;
      const currentSession = await store?.getSession(targetSessionId);
      if (!store || !currentSession) throw new Error("未找到可保存的本机记录，请先完成记录保存。");
      if (pendingSessionRef.current?.id === targetSessionId) throw new Error("这条记录尚未完成保存，请先重试保存 Session。");
      try {
        await store.patchSession(targetSessionId, { kind: "notes", notes });
        await refreshSessions(store);
        setStorageError(null);
      } catch (saveError) {
        setStorageError(`训练备注尚未保存：${storageErrorMessage(saveError)}`);
        throw saveError;
      }
    }).finally(() => sessionMutationIdsRef.current.delete(targetSessionId));
    noteSaveQueueRef.current = save;
    return save;
  }, [refreshSessions]);

  const updateLastSessionNotes = useCallback(async (notes: string) => {
    const currentSession = sessionsRef.current[0];
    if (!currentSession || hasPendingSave) return;
    // Preserve the legacy UI's handled-error contract; the library uses the rejecting API above.
    await updateSessionNotes(currentSession.id, notes).catch(() => undefined);
  }, [hasPendingSave, updateSessionNotes]);

  const exportSession = useCallback(async (targetSessionId: string, notesOverride?: string): Promise<TrainingSessionExportResult> => {
    const exportDirectory = directoryHandleRef.current;
    const store = storeRef.current;
    const summary = sessionsRef.current.find((candidate) => candidate.id === targetSessionId)
      ?? ((!pendingSessionRef.current || rcConfirmedSessionIdRef.current === targetSessionId) && lastSession?.id === targetSessionId ? lastSession : null);
    if (!store || !summary) {
      const message = "未找到可导出的本机记录，请先完成记录保存。";
      setExportNotice(null);
      setExportWarning(message);
      return { status: "failed", message, localStateSaved: false };
    }
    if (sessionMutationIdsRef.current.has(targetSessionId) || (pendingSessionRef.current?.id === targetSessionId && rcConfirmedSessionIdRef.current !== targetSessionId)) {
      const message = "这条记录正在保存或导出，请完成后重试。";
      setExportNotice(null);
      setExportWarning(message);
      return { status: "failed", message, localStateSaved: true };
    }
    sessionMutationIdsRef.current.add(targetSessionId);
    let finishExport!: () => void;
    const waiter = new Promise<void>((resolve) => { finishExport = resolve; });
    exportWaitersRef.current.set(targetSessionId, waiter);
    try {
      if (exportDirectory) {
        if (notesOverride !== undefined) await store.patchSession(targetSessionId, { kind: "notes", notes: notesOverride });
        const session = await loadSession(targetSessionId);
        if (!session) throw new Error("记录样本无法完整读取，请检查本机存储或归档文件");
        const snapshot = session;
        const result = await exportStoredSessionToDirectory(snapshot, store, exportDirectory);
        if (!result.confirmed) {
          const message = `${result.reason}；已有文件与本机记录保留。`;
          setExportNotice(null);
          setExportWarning(message);
          return { status: "failed", message, localStateSaved: result.localStateSaved };
        }
        const message = result.localStateSaved
          ? `已保存“${result.filename}”；已有文件保留。`
          : `已保存“${result.filename}”，但本机导出状态尚未保存。`;
        return { status: "confirmed", message, localStateSaved: result.localStateSaved };
      }
      const picker = getBrowserTrainingSessionSaveFilePicker();
      // Open while the click still has browser activation; reading a long record can take time.
      const selectedFile = picker?.({ suggestedName: trainingSessionFilename(summary), types: [{ description: "FPVHelper 训练记录", accept: { "application/json": [".json"] } }] });
      void selectedFile?.catch(() => undefined);
      if (notesOverride !== undefined) await store.patchSession(targetSessionId, { kind: "notes", notes: notesOverride });
      const session = await loadSession(targetSessionId);
      if (!session) throw new Error("记录样本无法完整读取，请检查本机存储或归档文件");
      const snapshot = session;
      return await exportStoredSession(snapshot, store, "download", selectedFile ? () => selectedFile : null);
    } catch (exportError) {
      const message = isAbortError(exportError) ? "已取消文件保存，本机记录仍保留。" : `导出未完成：${storageErrorMessage(exportError)}`;
      setExportWarning(message);
      return { status: isAbortError(exportError) ? "cancelled" : "failed", message, localStateSaved: true };
    } finally {
      sessionMutationIdsRef.current.delete(targetSessionId);
      exportWaitersRef.current.delete(targetSessionId);
      finishExport();
    }
  }, [exportStoredSession, exportStoredSessionToDirectory, lastSession, loadSession]);

  return {
    isRecording,
    isStarting,
    isFinishing,
    hasPendingMedia,
    rcConfirmedSessionId,
    pendingTerminationSessionId,
    mediaPhase,
    mediaAssociationError,
    retryMediaAssociation,
    sessionId,
    sampleCount,
    uniqueSampleCount,
    markerCount,
    elapsedMs,
    lastSession,
    allSessions: sessions,
    loadSession,
    loadSessionsForReport,
    persistedSampleCount,
    persistedElapsedMs,
    storageReady,
    storageError,
    exportNotice,
    exportWarning,
    storageIntegrity,
    recentSessionCount: sessions.length,
    unexportedValidCount,
    unexportedCount: sessions.filter((session) => !hasCurrentSessionExport(session)).length,
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
    updateSessionNotes,
    updateLastSessionNotes,
    exportSession,
    configureExportDirectory,
    reauthorizeExportDirectory,
    clearExportDirectory,
  };
}
