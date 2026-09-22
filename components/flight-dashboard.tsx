"use client";

import dynamic from "next/dynamic";
import { AddPilotDialog } from "@/components/add-pilot-dialog";
import pilotSetupStyles from "@/components/pilot-setup.module.css";

import { sessionMediaStatusText } from "@/lib/training-session-metadata";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  DraggableStickOverlay,
  useStickOverlayPairLayout,
} from "@/components/draggable-stick-overlay";
import { Icon, type IconName } from "@/components/ui/icon";
import { WorkspaceVideoElement, PilotViewportTelemetry } from "@/components/video-workspace-display";
import { SessionLibrary } from "@/components/session-library";
import { ThrottleTimeline } from "@/components/throttle-timeline";
import { withMeasurementProfiler } from "@/components/measurement-profiler";
import { SessionReportLoader } from "@/components/session-report-loader";
import { startStickVideoCompositor, type StickOverlayAppearance } from "@/lib/stick-video-compositor";
import { StickAxes } from "@/components/stick-axes";
import { StickOverlayControls } from "@/components/stick-overlay-controls";
import { formatStickAxisValue } from "@/lib/stick-display";
import { DemoTelemetryWatermark } from "@/components/demo-telemetry-watermark";
import { OnboardingChecklist } from "@/components/onboarding-checklist";
import { PilotVideoBindingControls } from "@/components/pilot-video-binding-controls";
import { PilotNameField } from "@/components/pilot-name-field";
import { ArmAutoRecordSettings, armAutoRecordStatus } from "@/components/arm-auto-record-settings";
import { useArmAutoRecord } from "@/hooks/use-arm-auto-record";
import type { ArmAutoRecordStopReason } from "@/lib/arm-auto-record";
import {
  quarantinedTrainingRecordCount,
  TrainingStorageIntegrityNotice,
} from "@/components/training-storage-integrity-notice";
import {
  AnalyticsTokenReplacementAction,
  AnalyticsWorkstationId,
  prepareAnalyticsTokenReplacementAction,
} from "@/components/analytics-workstation-id";
import { TrainingExportNotice } from "@/components/training-export-notice";
import { TrainingSessionFileValidator } from "@/components/training-session-file-validator";
import { WorkstationShortcutToggle } from "@/components/workstation-shortcut-toggle";
import { useAnalyticsLifecycle, type AnalyticsErrorSurface } from "@/hooks/use-analytics-lifecycle";
import { useLocalVideoRecording } from "@/hooks/use-local-video-recording";
import {
  createPilotTelemetryWorkspaceStore,
  PilotTelemetryWorkspaceHost,
  usePilotTelemetryController,
  usePilotTelemetryNames,
} from "@/hooks/use-pilot-telemetry-workspace";
import { useTrainingSession } from "@/hooks/use-training-session";
import {
  useVideoWorkspaceCapture,
  videoSourceRuntime,
} from "@/hooks/use-video-workspace-capture";
import { useVersionCheck } from "@/hooks/use-version-check";
import { useWorkstationRuntime } from "@/hooks/use-workstation-runtime";
import { PUBLIC_APP_BUILD } from "@/lib/app-version";
import type { SerialErrorCode, VideoCaptureErrorCode } from "@/lib/hardware-errors";
import {
  localVideoRecordingFilename,
  localVideoContainerForMimeType,
  preferredLocalVideoMimeType,
  type LocalVideoRecordingReceipt,
} from "@/lib/local-video-recording";
import {
  appendDiagnosticTransition,
  buildLocalDiagnosticBundle,
  downloadLocalDiagnosticBundle,
  type LocalDiagnosticTransition,
} from "@/lib/local-diagnostics";
import { clamp, type ConnectionState } from "@/lib/telemetry";
import {
  resizeStickOverlayPairLayout,
  stickOverlayPairIsDefault,
  type StickOverlayPairLayout,
} from "@/lib/stick-overlay-layout";
import {
  DEFAULT_TRAINING_SESSION_PREFERENCES,
  loadTrainingSessionPreferences,
  saveTrainingSessionPreferences,
  TRAINING_SESSION_PREFERENCES_KEY,
  type TrainingSessionPreferences,
} from "@/lib/training-session-preferences";
import {
  TRAINING_MARKER_LABELS,
  trainingSessionProgress,
} from "@/lib/training-session-summary";
import {
  activePilotChannel,
  activeVideoSource,
  activeVideoViewport,
  addVideoSource,
  addPilotToWorkspace,
  addedPilotIds,
  restorePilotToWorkspace,
  createDefaultVideoWorkspace,
  loadVideoWorkspace,
  removeVideoSource,
  resetPilotChannelCrop,
  resolveVideoWorkspaceNames,
  saveVideoWorkspace,
  selectPilotChannel,
  selectVideoSource,
  setPilotChannelCrop,
  setPilotChannelViewMode,
  setPilotChannelAutomaticName,
  setVideoSourceDevice,
  setVideoSourceLabel,
  setVideoSourceLayout,
  updatePilotChannel,
  LEGACY_VIDEO_WORKSPACE_STORAGE_KEY,
  VIDEO_WORKSPACE_STORAGE_KEY,
  videoViewportsForSource,
  type VideoSourceConfig,
  type VideoWorkspaceConfig,
  type FrozenPilotName,
} from "@/lib/video-workspace";
import {
  assessTrainingAttemptCandidate,
  normalizeAthleteCode,
  type TrainingSessionInvalidReason,
  type TrainingSessionMarkerKind,
} from "@/lib/training-session";
import {
  classifyWorkstationShortcut,
  createRecordHoldController,
  isWorkstationInteractiveTarget,
  loadWorkstationSingleKeyShortcuts,
  saveWorkstationSingleKeyShortcuts,
  WORKSTATION_SINGLE_KEY_SHORTCUTS_KEY,
  workstationRecordHoldAction,
  workstationShortcutShouldPreventDefault,
  workstationTabStartBlockReason,
} from "@/lib/workstation-runtime";

interface DashboardRecordingAttempt {
  beta: boolean;
  sessionId: string | null;
  setupAbort: AbortController;
  setupDone: Promise<void>;
  setupFinished: boolean;
  videoStarted: boolean;
  telemetryGap: boolean;
  failure: Error | null;
  finish: Promise<void> | null;
  finishVideo: Promise<LocalVideoRecordingReceipt | null> | null;
  removeAbortListener: () => void;
}

const statusCopy = {
  demo: "演示数据",
  connecting: "正在连接",
  live: "数据桥在线",
  stale: "数据已停滞",
  error: "需要检查",
} as const;

export function dashboardEscapeAction(
  event: Pick<KeyboardEvent, "defaultPrevented" | "isComposing" | "target">,
  context: {
    document: Pick<Document, "fullscreenElement" | "querySelector">;
    coachMode: boolean;
    controlsLocked: boolean;
    connection: ConnectionState;
  },
): "exit_coach" | "cancel_pending_connection" | null {
  if (event.defaultPrevented || event.isComposing || isWorkstationInteractiveTarget(event.target) || context.document.fullscreenElement) return null;
  const target = event.target as { closest?: (selector: string) => unknown } | null;
  if (target?.closest?.('dialog, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [popover]')
    || context.document.querySelector('dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')) return null;
  try {
    if (context.document.querySelector(":popover-open")) return null;
  } catch { /* Older browsers do not support native popovers. */ }
  if (context.coachMode) return "exit_coach";
  return !context.controlsLocked && context.connection === "connecting" ? "cancel_pending_connection" : null;
}

function videoSourceDisplayName(sources: readonly VideoSourceConfig[], source: VideoSourceConfig) {
  const index = sources.findIndex((candidate) => candidate.id === source.id);
  return source.label.trim() || `视频输入 ${index >= 0 ? index + 1 : 1}`;
}

function useDashboardAnalyticsErrorSurface({
  storageError,
  preferenceError,
  serialErrorCode,
  videoErrorCode,
}: {
  storageError: string | null;
  preferenceError: string | null;
  serialErrorCode: SerialErrorCode | null;
  videoErrorCode: VideoCaptureErrorCode | null;
}) {
  return useMemo<AnalyticsErrorSurface | null>(() => {
    if (storageError || preferenceError) {
      return { kind: "storage", message: storageError || preferenceError || "本机存储异常" };
    }
    if (serialErrorCode) return { kind: "serial", code: serialErrorCode };
    if (videoErrorCode) return { kind: "video", code: videoErrorCode };
    return null;
  }, [preferenceError, serialErrorCode, storageError, videoErrorCode]);
}

const rawCaptureStopCopy = {
  completed: "原始串口夹具已完成 60 秒录制，可以下载。",
  size_limit: "原始串口夹具已达到 8 MiB 本地上限并提前结束，可以下载。",
  disconnected: "串口在录制期间断开；断线前的原始字节已保留，可以下载。",
} as const;

const invalidReasonCopy: Record<TrainingSessionInvalidReason, string> = {
  source_not_ground_rc: "不是真实 GROUND_RC",
  mixed_sources: "混入其他数据源",
  too_short: "不足 60 秒",
  too_few_unique_samples: "不足 300 个不重复样本",
  non_monotonic: "时间戳不严格单调",
  no_athlete_code: "缺少选手代号",
  rx_link_lost: "遥控链路丢失",
  interrupted: "刷新或连接中断",
};

const linkStateCopy = {
  unknown: "等待 MSP_STATUS_EX 链路状态",
  ok: "遥控链路正常",
  lost: "遥控链路丢失",
} as const;

const parserQualityCopy = {
  unknown: "等待数据",
  good: "良好",
  degraded: "需观察",
  poor: "较差",
} as const;

const TRAIL_LEFT_STICK_LAYOUT = { xPercent: 3, yPercent: 59, size: 154 };
const TRAIL_RIGHT_STICK_LAYOUT = { xPercent: 78, yPercent: 59, size: 154 };
const SIMPLE_LEFT_STICK_LAYOUT = { xPercent: 3, yPercent: 74, size: 92 };
const SIMPLE_RIGHT_STICK_LAYOUT = { xPercent: 82, yPercent: 74, size: 92 };
const COACH_LEFT_STICK_LAYOUT = { xPercent: 3, yPercent: 57, size: 220 };
const COACH_RIGHT_STICK_LAYOUT = { xPercent: 78, yPercent: 57, size: 220 };
const markerKinds = Object.keys(TRAINING_MARKER_LABELS) as Exclude<TrainingSessionMarkerKind, "manual">[];
const TRAINING_PREFERENCES_EVENT = "fpvhelper:training-preferences";
const DEFAULT_TRAINING_PREFERENCES_SNAPSHOT = JSON.stringify(DEFAULT_TRAINING_SESSION_PREFERENCES);
const RECORD_SHORTCUT_HOLD_MS = 700;
const WORKSTATION_NOTICE_MS = 4_000;
const WORKSTATION_SHORTCUTS_EVENT = "fpvhelper:workstation-shortcuts";
const VIDEO_WORKSPACE_EVENT = "fpvhelper:video-workspace";
const DEFAULT_VIDEO_WORKSPACE_SNAPSHOT = JSON.stringify(createDefaultVideoWorkspace());

function subscribeToVideoRecordingCapabilities() { return () => undefined; }
function getVideoRecordingMimeTypeSnapshot() {
  return typeof MediaRecorder === "undefined"
    ? null
    : preferredLocalVideoMimeType((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

function subscribeToTrainingPreferences(onStoreChange: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === TRAINING_SESSION_PREFERENCES_KEY) onStoreChange();
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener(TRAINING_PREFERENCES_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(TRAINING_PREFERENCES_EVENT, onStoreChange);
  };
}

function getTrainingPreferencesSnapshot() {
  try {
    return window.localStorage.getItem(TRAINING_SESSION_PREFERENCES_KEY) ?? DEFAULT_TRAINING_PREFERENCES_SNAPSHOT;
  } catch {
    return DEFAULT_TRAINING_PREFERENCES_SNAPSHOT;
  }
}

function subscribeToWorkstationShortcuts(onStoreChange: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === WORKSTATION_SINGLE_KEY_SHORTCUTS_KEY) onStoreChange();
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener(WORKSTATION_SHORTCUTS_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(WORKSTATION_SHORTCUTS_EVENT, onStoreChange);
  };
}

function getWorkstationShortcutsSnapshot() {
  try {
    return loadWorkstationSingleKeyShortcuts(window.localStorage);
  } catch {
    return false;
  }
}

function subscribeToVideoWorkspace(onStoreChange: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === VIDEO_WORKSPACE_STORAGE_KEY || event.key === LEGACY_VIDEO_WORKSPACE_STORAGE_KEY) onStoreChange();
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener(VIDEO_WORKSPACE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(VIDEO_WORKSPACE_EVENT, onStoreChange);
  };
}

function getVideoWorkspaceSnapshot() {
  try {
    return window.localStorage.getItem(VIDEO_WORKSPACE_STORAGE_KEY)
      ?? window.localStorage.getItem(LEGACY_VIDEO_WORKSPACE_STORAGE_KEY)
      ?? DEFAULT_VIDEO_WORKSPACE_SNAPSHOT;
  } catch {
    return DEFAULT_VIDEO_WORKSPACE_SNAPSHOT;
  }
}

function formatSessionDuration(durationMs: number) {
  const totalSeconds = Math.max(0, durationMs) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(1).padStart(4, "0");
  return `${String(minutes).padStart(2, "0")}:${seconds}`;
}

function formatFileSize(bytes: number) {
  if (bytes < 1_024 * 1_024) return `${Math.max(1, Math.round(bytes / 1_024))} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function formatLocalTimecode(timestamp: number) {
  if (!timestamp) return "--:--:--.---";
  const date = new Date(timestamp);
  const pad = (value: number, length = 2) => value.toString().padStart(length, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function captureInteractionEpochMs() {
  return Date.now();
}

function localDiagnosticEnvironment() {
  return {
    secureContext: window.isSecureContext,
    online: navigator.onLine,
    serialSupported: Boolean(navigator.serial),
    mediaSupported: Boolean(navigator.mediaDevices?.getUserMedia),
    indexedDbSupported: "indexedDB" in window,
    directoryPickerSupported: "showDirectoryPicker" in window,
    fullscreenSupported: document.fullscreenEnabled,
    wakeLockSupported: "wakeLock" in navigator,
  };
}

function SignalMark({ active }: { active: boolean }) {
  return (
    <span className="signal-mark" aria-hidden="true">
      {[1, 2, 3, 4].map((bar) => <i key={bar} className={active || bar === 1 ? "active" : ""} />)}
    </span>
  );
}

function StickPlot({
  eyebrow,
  xLabel,
  yLabel,
  x,
  y,
  tone,
}: {
  eyebrow: string;
  xLabel: string;
  yLabel: string;
  x: number;
  y: number;
  tone: "blue" | "orange";
}) {
  const left = `${(clamp(x, -100, 100) + 100) / 2}%`;
  const top = `${(100 - clamp(y, -100, 100)) / 2}%`;

  return (
    <section className={`stick-card stick-card--${tone}`}>
      <div className="card-heading">
        <span>{eyebrow}</span>
        <b>{formatStickAxisValue(x)}</b>
      </div>
      <div className="stick-field" aria-label={`${eyebrow}，${xLabel} ${formatStickAxisValue(x)}，${yLabel} ${formatStickAxisValue(y)}；归一化行程 −1000 至 +1000，中心 0`}>
        <span className="stick-trace" style={{ left, top }} />
        <span className="stick-dot" style={{ left, top }} />
        <StickAxes xLabel={xLabel} yLabel={yLabel} />
      </div>
      <div className="stick-values">
        <span><i />{xLabel}<b>{formatStickAxisValue(x)}</b></span>
        <span><i />{yLabel}<b>{formatStickAxisValue(y)}</b></span>
      </div>
    </section>
  );
}

function Gauge({ label, value, detail, accent = "blue" }: { label: string; value: number | null; detail: string; accent?: "blue" | "orange" }) {
  const safeValue = value === null ? 0 : clamp(value, 0, 100);
  const circumference = 2 * Math.PI * 44;
  const dashOffset = circumference - (safeValue / 100) * circumference;

  return (
    <section className={`gauge-card gauge-card--${accent}`}>
      <div className="gauge-ring">
        <svg viewBox="0 0 104 104" aria-hidden="true">
          <circle className="gauge-track" cx="52" cy="52" r="44" />
          <circle
            className="gauge-value"
            cx="52"
            cy="52"
            r="44"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
          />
        </svg>
        <strong>{value === null ? "—" : Math.round(value)}</strong>
        <small>{value === null ? "N/A" : "%"}</small>
      </div>
      <div>
        <span className="metric-label">{label}</span>
        <p>{detail}</p>
      </div>
    </section>
  );
}

const LiveGatePanel = dynamic(() => import("@/components/live-gate-panel").then((module) => module.LiveGatePanel), {
  loading: () => <p role="status">正在打开实时过门实验…</p>,
});

type WorkspaceView = "live" | "records" | "settings" | "experiments";
const workspaceNavigation: { id: WorkspaceView; label: string; icon: IconName; description: string }[] = [
  { id: "live", label: "飞行工作台", icon: "live", description: "每一次练习，都值得被看见。" },
  { id: "records", label: "训练记录", icon: "folder", description: "从记录里，找到下一次进步。" },
  { id: "settings", label: "工作站设置", icon: "settings", description: "准备就绪，便可专注飞行。" },
];

export function FlightDashboard() {
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("live");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [experimentsOpened, setExperimentsOpened] = useState(false);
  const [telemetryDetailsOpen, setTelemetryDetailsOpen] = useState(false);
  const [revealSessionId, setRevealSessionId] = useState<string | null>(null);
  const workspaceHeadingRef = useRef<HTMLHeadingElement>(null);
  const recordingWasActive = useRef(false);
  const preferencesSnapshot = useSyncExternalStore(
    subscribeToTrainingPreferences,
    getTrainingPreferencesSnapshot,
    () => DEFAULT_TRAINING_PREFERENCES_SNAPSHOT,
  );
  const loadedPreferences = useMemo(() => loadTrainingSessionPreferences({
    getItem: () => preferencesSnapshot,
    setItem: () => undefined,
  }), [preferencesSnapshot]);
  const singleKeyShortcutsEnabled = useSyncExternalStore(
    subscribeToWorkstationShortcuts,
    getWorkstationShortcutsSnapshot,
    () => false,
  );
  const { autoExport, recordPilotVideo, showStickOverlays, stickOverlayMode, stickOverlayOpacity } = loadedPreferences.preferences;
  const [preferenceWriteError, setPreferenceWriteError] = useState<string | null>(null);
  const videoWorkspaceSnapshot = useSyncExternalStore(
    subscribeToVideoWorkspace,
    getVideoWorkspaceSnapshot,
    () => DEFAULT_VIDEO_WORKSPACE_SNAPSHOT,
  );
  const loadedVideoWorkspace = useMemo(() => loadVideoWorkspace({
    getItem: () => videoWorkspaceSnapshot,
    setItem: () => undefined,
  }), [videoWorkspaceSnapshot]);
  const [recordingPilotName, setRecordingPilotName] = useState<FrozenPilotName | null>(null);
  const [nameControlsWereLocked, setNameControlsWereLocked] = useState(false);
  const [videoWorkspaceWriteError, setVideoWorkspaceWriteError] = useState<string | null>(null);
  const [addingPilot, setAddingPilot] = useState(false);
  const [coachMode, setCoachMode] = useState(false);
  const [selectedMarkerKind, setSelectedMarkerKind] = useState<Exclude<TrainingSessionMarkerKind, "manual">>("clean");
  const [analyticsTokenDraft, setAnalyticsTokenDraft] = useState("");
  const [analyticsInstallMessage, setAnalyticsInstallMessage] = useState<string | null>(null);
  const [diagnosticNotice, setDiagnosticNotice] = useState<string | null>(null);
  const [workstationNotice, setWorkstationNotice] = useState<string | null>(null);
  const [overlayLayoutNotice, setOverlayLayoutNotice] = useState<string | null>(null);
  const [telemetryWorkspaceStore] = useState(createPilotTelemetryWorkspaceStore);
  const pilotDeviceNames = usePilotTelemetryNames(telemetryWorkspaceStore);
  const videoWorkspace = useMemo(() => resolveVideoWorkspaceNames(
    loadedVideoWorkspace.workspace, pilotDeviceNames, recordingPilotName,
  ), [loadedVideoWorkspace.workspace, pilotDeviceNames, recordingPilotName]);
  const videoSetupRef = useRef<HTMLDetailsElement>(null);
  const activeVideoStageRef = useRef<HTMLDivElement>(null);
  const recordingOverlayAppearanceRef = useRef<StickOverlayAppearance | undefined>(undefined);
  const armSettingsRef = useRef<HTMLDetailsElement>(null);
  const exportShortcutInFlightRef = useRef(false);
  const pilotOutputCanvasesRef = useRef(new Map<string, HTMLCanvasElement>());
  const diagnosticTransitionsRef = useRef<LocalDiagnosticTransition[]>([]);
  const activeSource = activeVideoSource(videoWorkspace);
  const candidateChannel = activePilotChannel(videoWorkspace);
  const configuredPilotIds = addedPilotIds(videoWorkspace);
  const occupiedPilotIds = () => videoWorkspace.pilotChannels.filter((channel) => {
    const controller = telemetryWorkspaceStore.getSnapshot(channel.id);
    return controller.source === "serial" || controller.connection === "connecting";
  }).map((channel) => channel.id);
  const hasPilots = configuredPilotIds.length > 0;
  const activeChannel = candidateChannel && configuredPilotIds.includes(candidateChannel.id) ? candidateChannel : undefined;
  const activeViewport = activeVideoViewport(videoWorkspace);
  const sourceChannels = activeSource
    ? videoWorkspace.pilotChannels
        .filter((channel) => channel.sourceId === activeSource.id && configuredPilotIds.includes(channel.id))
        .sort((left, right) => left.slot - right.slot)
    : [];
  const videoCapture = useVideoWorkspaceCapture(videoWorkspace.sources);
  const localVideoRecording = useLocalVideoRecording();
  const stopLocalVideo = localVideoRecording.stop;
  const recordingCompositorRef = useRef<Awaited<ReturnType<typeof startStickVideoCompositor>> | null>(null);
  const recordingAttemptRef = useRef<DashboardRecordingAttempt | null>(null);
  const [autoCaptureActive, setAutoCaptureActive] = useState(false);
  const [autoCaptureDataGap, setAutoCaptureDataGap] = useState(false);
  const finishAttemptVideo = useCallback(async (attempt: DashboardRecordingAttempt | null) => {
    if (!attempt) return null;
    if (!attempt.setupFinished) attempt.setupAbort.abort();
    await attempt.setupDone;
    if (!attempt.finishVideo) {
      if (recordingAttemptRef.current !== attempt) throw new Error("录像操作身份已改变；未停止当前录像");
      const compositor = recordingCompositorRef.current;
      attempt.finishVideo = (async () => {
        try {
          if (!attempt.videoStarted) return null;
          const receipt = await stopLocalVideo();
          if (!receipt) throw attempt.failure ?? new Error("视频未完整保存：未取得本次录像的写入收据");
          return receipt;
        } finally {
          attempt.removeAbortListener();
          compositor?.dispose();
          if (recordingCompositorRef.current === compositor) recordingCompositorRef.current = null;
        }
      })();
    }
    return attempt.finishVideo;
  }, [stopLocalVideo]);
  const finishCompanionRecording = useCallback(
    () => finishAttemptVideo(recordingAttemptRef.current),
    [finishAttemptVideo],
  );
  useEffect(() => () => {
    const attempt = recordingAttemptRef.current;
    if (attempt && !attempt.setupFinished) attempt.setupAbort.abort();
    attempt?.removeAbortListener();
    recordingCompositorRef.current?.dispose();
  }, []);
  const companionRecordingStarted = useCallback(() => recordingAttemptRef.current?.videoStarted ?? false, []);
  const activeVideoRuntime = videoSourceRuntime(videoCapture.runtimes, activeSource?.id);
  const videoDevices = videoCapture.devices;
  const selectedDeviceId = activeSource?.deviceId ?? "";
  const captureSettings = activeVideoRuntime.captureSettings;
  const videoState = activeVideoRuntime.state;
  const videoError = activeVideoRuntime.error;
  const videoErrorCode = activeVideoRuntime.errorCode;
  const liveVideoSourceCount = videoWorkspace.sources.filter(
    (sourceConfig) => videoSourceRuntime(videoCapture.runtimes, sourceConfig.id).state === "live",
  ).length;
  const connectingVideoSourceCount = videoWorkspace.sources.filter(
    (sourceConfig) => videoSourceRuntime(videoCapture.runtimes, sourceConfig.id).state === "connecting",
  ).length;
  const anyVideoLive = liveVideoSourceCount > 0;
  const workspaceTiles = videoWorkspace.sources.flatMap((sourceConfig) => (
    videoViewportsForSource(videoWorkspace, sourceConfig).map((viewport) => ({
      sourceConfig,
      viewport,
      channel: videoWorkspace.pilotChannels.find((candidate) => candidate.id === viewport.pilotChannelId),
    }))
  ));
  const pilotChannelIds = videoWorkspace.pilotChannels.map((channel) => channel.id);
  const telemetryControl = usePilotTelemetryController(telemetryWorkspaceStore, activeChannel?.id);
  const athleteCode = activeChannel?.athleteCode ?? "";
  const { telemetry, throttleHistory, stickMotion, connection, source, error, linkState, subscribeSamples } = telemetryControl;
  const recordingTelemetryRef = useRef(telemetry);
  useEffect(() => subscribeSamples((sample, sampleSource) => {
    if (sampleSource === "serial") recordingTelemetryRef.current = sample;
  }), [subscribeSamples]);
  const automatic = useArmAutoRecord({
    subscribeSamples, source, connection, linkState,
    inputKey: activeChannel?.id ?? "unassigned",
    start: startDashboardRecording,
    stop: finishDashboardRecording,
    canEnable: () => recordPilotVideo && canStartDashboardRecording && !controlsLocked,
    canObserve: videoState === "live" && localVideoRecording.state !== "error",
  });
  const version = useVersionCheck();
  const trainingSession = useTrainingSession({
    telemetry,
    source,
    connection,
    linkState,
    athleteCode,
    autoExport: autoExport || recordPilotVideo,
    inputKey: activeChannel?.id ?? "unassigned",
    subscribeSamples,
    finishCompanionRecording,
    companionRecordingStarted,
    stopOnTelemetryLoss: !automatic.state.enabled && !autoCaptureActive,
  });
  const workstation = useWorkstationRuntime({ keepAwake: automatic.state.enabled || trainingSession.isRecording || localVideoRecording.isActive });

  useEffect(() => {
    const attempt = recordingAttemptRef.current;
    if (!attempt?.beta || (source === "serial" && connection === "live" && linkState === "ok")) return;
    attempt.telemetryGap = true;
    setAutoCaptureDataGap(true);
  }, [connection, linkState, source]);


  const commitVideoWorkspace = useCallback((nextWorkspace: VideoWorkspaceConfig) => {
    try {
      const saveError = saveVideoWorkspace(window.localStorage, nextWorkspace);
      setVideoWorkspaceWriteError(saveError);
      if (!saveError) window.dispatchEvent(new Event(VIDEO_WORKSPACE_EVENT));
      return !saveError;
    } catch (storageError) {
      setVideoWorkspaceWriteError(storageError instanceof Error ? storageError.message : "无法保存视频工作区设置");
      return false;
    }
  }, []);

  const setPilotGateProfile = useCallback((pilotChannelId: string, profileId: string | null) => {
    const current = loadVideoWorkspace(window.localStorage).workspace;
    commitVideoWorkspace(updatePilotChannel(current, pilotChannelId, { gateProfileId: profileId }));
  }, [commitVideoWorkspace]);
  const liveVisionCrop = useMemo(() => ({
    x: (activeViewport?.crop.xPercent ?? 0) / 100,
    y: (activeViewport?.crop.yPercent ?? 0) / 100,
    width: (activeViewport?.crop.widthPercent ?? 100) / 100,
    height: (activeViewport?.crop.heightPercent ?? 100) / 100,
  }), [activeViewport?.crop.xPercent, activeViewport?.crop.yPercent, activeViewport?.crop.widthPercent, activeViewport?.crop.heightPercent]);

  const registerPilotOutputCanvas = useCallback((pilotChannelId: string, element: HTMLCanvasElement | null) => {
    if (!element) return;
    pilotOutputCanvasesRef.current.set(pilotChannelId, element);
    return () => {
      if (pilotOutputCanvasesRef.current.get(pilotChannelId) === element) {
        pilotOutputCanvasesRef.current.delete(pilotChannelId);
      }
    };
  }, []);

  useEffect(() => {
    if (!workstationNotice) return;
    const timer = window.setTimeout(() => setWorkstationNotice(null), WORKSTATION_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [workstationNotice]);

  useEffect(() => {
    if (!overlayLayoutNotice) return;
    const timer = window.setTimeout(() => setOverlayLayoutNotice(null), 1_800);
    return () => window.clearTimeout(timer);
  }, [overlayLayoutNotice]);

  const updateTrainingPreferences = useCallback((preferences: Partial<TrainingSessionPreferences>) => {
    try {
      const saveError = saveTrainingSessionPreferences(window.localStorage, { ...loadedPreferences.preferences, ...preferences });
      setPreferenceWriteError(saveError);
      if (!saveError) window.dispatchEvent(new Event(TRAINING_PREFERENCES_EVENT));
      return saveError === null;
    } catch (saveError) {
      setPreferenceWriteError(saveError instanceof Error ? saveError.message : "无法保存本机界面偏好");
      return false;
    }
  }, [loadedPreferences.preferences]);

  const updateSingleKeyShortcuts = useCallback((enabled: boolean) => {
    try {
      const saveError = saveWorkstationSingleKeyShortcuts(window.localStorage, enabled);
      setPreferenceWriteError(saveError);
      if (!saveError) window.dispatchEvent(new Event(WORKSTATION_SHORTCUTS_EVENT));
    } catch {
      setPreferenceWriteError("无法保存本机单键快捷操作设置");
    }
  }, []);

  const toggleCoachMode = useCallback(async () => {
    setWorkspaceView("live");
    setWorkstationNotice(null);
    if (coachMode) {
      if (document.fullscreenElement) {
        try {
          await document.exitFullscreen();
        } catch {
          setWorkstationNotice("浏览器未能退出全屏，请按 Esc 重试");
          return;
        }
      }
      setCoachMode(false);
      return;
    }
    if (!document.fullscreenEnabled || typeof document.documentElement.requestFullscreen !== "function") {
      setCoachMode(true);
      setWorkstationNotice("当前浏览器不支持 Fullscreen API，已进入页面内大屏模式");
      return;
    }
    try {
      await document.documentElement.requestFullscreen();
      setCoachMode(true);
    } catch {
      setWorkstationNotice("浏览器拒绝全屏请求；请从地址栏权限或浏览器菜单手动允许");
    }
  }, [coachMode]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) setCoachMode(false);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);
  const preferenceError = preferenceWriteError || videoWorkspaceWriteError || loadedVideoWorkspace.error || loadedPreferences.error;
  useEffect(() => {
    if (localVideoRecording.state !== "error" && localVideoRecording.state !== "saved") return;
    recordingCompositorRef.current?.dispose();
    recordingCompositorRef.current = null;
  }, [localVideoRecording.state]);

  const controlsLocked = automatic.state.enabled || autoCaptureActive || trainingSession.isRecording || trainingSession.isStarting || trainingSession.isFinishing || trainingSession.hasPendingSave || trainingSession.hasPendingMedia || localVideoRecording.isActive;
  if (nameControlsWereLocked !== controlsLocked) {
    setNameControlsWereLocked(controlsLocked);
    if (!controlsLocked) setRecordingPilotName(null);
  }
  const activeVideoControlsLocked = controlsLocked || videoState === "connecting" || videoState === "live";
  const sessionIsFinalizing = trainingSession.isFinishing || trainingSession.hasPendingSave;
  const tabStartBlockReason = workstationTabStartBlockReason(workstation.tabState);
  const tabAllowsStart = tabStartBlockReason === null;
  const bridgeIsLive = source === "serial" && connection === "live";
  const groundRxReady = bridgeIsLive && linkState === "ok";
  const videoLabel = videoState === "live" ? "HDMI 画面在线" : videoState === "connecting" ? "正在打开视频" : "等待 HDMI 输入";
  const videoFormatLabel = videoState === "live" && captureSettings
    ? [
        captureSettings.width && captureSettings.height ? `${captureSettings.width}×${captureSettings.height}` : null,
        captureSettings.frameRate ? `${captureSettings.frameRate.toFixed(1)} FPS` : null,
      ].filter(Boolean).join(" · ")
    : "";
  const rcSourceLabel = source === "demo" ? "DEMO" : "GROUND_RC";
  const timecode = formatLocalTimecode(telemetry.timestamp);
  const sessionRate = trainingSession.isRecording
    ? trainingSession.sampleCount > 1 && trainingSession.elapsedMs > 0
      ? (trainingSession.sampleCount - 1) / (trainingSession.elapsedMs / 1000)
      : null
    : trainingSession.lastSession?.estimatedRcSampleRateHz ?? null;
  const sessionSources = trainingSession.isRecording
    ? rcSourceLabel
    : trainingSession.lastSession?.dataSources.map((dataSource) => dataSource === "ground_rc" ? "GROUND_RC" : "DEMO").join(" + ") ?? "—";
  const quarantinedRecordCount = quarantinedTrainingRecordCount(trainingSession.storageIntegrity);
  const activeViewportIsCropped = Boolean(activeViewport && (
    activeViewport.crop.xPercent !== 0
    || activeViewport.crop.yPercent !== 0
    || activeViewport.crop.widthPercent !== 100
    || activeViewport.crop.heightPercent !== 100
  ));
  const localVideoMimeType = useSyncExternalStore(
    subscribeToVideoRecordingCapabilities, getVideoRecordingMimeTypeSnapshot, () => undefined,
  );
  const localVideoContainer = localVideoContainerForMimeType(localVideoMimeType ?? "");
  const localVideoFormatLabel = localVideoContainer?.toUpperCase() ?? "视频";
  const localVideoFormatCopy = localVideoMimeType === undefined
    ? "正在检测本机录像格式…"
    : localVideoContainer === "mp4"
      ? "保存 MP4 视频，原始打杆数据另存 JSON。"
      : localVideoContainer === "webm"
        ? "当前浏览器不支持 MP4 录制，将保存 WebM 视频；原始打杆数据另存 JSON。"
        : "当前浏览器不支持本地视频录制。";
  const localVideoStartBlockReason = !recordPilotVideo
    ? null
    : typeof MediaRecorder === "undefined" || !localVideoMimeType
      ? "当前浏览器不支持本地视频录像；可切换为仅原始打杆数据"
      : trainingSession.exportDirectoryState !== "ready"
        ? "先选择并授权本地保存文件夹，或关闭视频录像"
        : !activeSource || !activeViewport
          ? "先为选手绑定一个视频画面"
          : videoState !== "live"
            ? "先打开当前选手绑定的 HDMI 画面"
            : (
              typeof HTMLCanvasElement === "undefined"
              || typeof HTMLCanvasElement.prototype.captureStream !== "function"
            )
              ? "当前浏览器不能合成摇杆录像；可关闭视频录像后只记录打杆数据"
              : null;
  const startRequirement = tabStartBlockReason
    ? tabStartBlockReason
    : !trainingSession.storageReady
      ? "正在准备浏览器本地存储"
      : trainingSession.storageIntegrity.migrationWarning
        ? "存储升级尚未完成，旧记录仍可查看和导出"
        : trainingSession.storageError
          ? "本地存储异常，暂不能开始"
          : !normalizeAthleteCode(athleteCode)
            ? "连接飞控自动读取姓名，或手动填写"
            : !bridgeIsLive
              ? "连接桥接飞控，等待遥控输入就绪"
              : linkState === "lost"
                ? "遥控链路已丢失，不能开始记录"
                : linkState === "unknown"
                  ? "等待飞控确认遥控链路"
                  : localVideoStartBlockReason ?? "已满足开始条件";
  const canStartDashboardRecording = !!activeChannel && trainingSession.canStart && tabAllowsStart && localVideoStartBlockReason === null;
  const exportDirectoryCopy = trainingSession.exportDirectoryState === "ready"
    ? `本地保存目录：${trainingSession.exportDirectoryName}`
    : trainingSession.exportDirectoryState === "permission_required"
      ? `需要重新授权：${trainingSession.exportDirectoryName ?? "已保存的目录"}`
      : trainingSession.exportDirectoryState === "unsupported"
        ? "当前浏览器不支持目录直写；JSON 将退回普通下载，视频录像需关闭"
        : trainingSession.exportDirectoryState === "loading"
          ? "正在检查本地保存目录"
          : trainingSession.exportDirectoryState === "error"
            ? trainingSession.exportDirectoryName
              ? "目录访问失败，可重新授权或更换文件夹"
              : "目录设置读取失败，可重新选择"
            : "尚未选择本地保存目录；JSON 可普通下载，视频录像需先选择目录";
  const localVideoStatusCopy = !recordPilotVideo
    ? "已关闭；本轮只记录遥测 JSON"
    : localVideoRecording.state === "recording"
      ? `正在写入 ${localVideoRecording.filename ?? "本地 WebM"}`
      : localVideoRecording.state === "starting"
        ? "正在启动浏览器本地编码器"
        : localVideoRecording.state === "stopping"
          ? "正在写完最后一段并关闭视频文件"
          : localVideoRecording.state === "saved" && localVideoRecording.receipt
            ? `已确认写入并关闭 ${localVideoRecording.receipt.filename} · ${formatFileSize(localVideoRecording.receipt.bytes)}`
            : localVideoRecording.state === "error"
              ? `视频未保存完整：${localVideoRecording.error ?? "本地编码或写盘失败"}；遥测 Session 不受影响`
              : `将保存当前选手的${activeViewportIsCropped ? "裁切" : "完整"}画面与摇杆叠层。${localVideoFormatCopy}`;

  const activeRecordingSourceId = activeSource?.id ?? null;
  const activeRecordingPilotChannelId = activeViewport?.pilotChannelId ?? null;
  const captureFrameRate = captureSettings?.frameRate ?? null;
  const startTrainingSession = trainingSession.startRecording;
  const stopTrainingSession = trainingSession.stopRecording;
  const isTrainingSessionRecording = trainingSession.isSessionRecording;
  const createExportFileWritable = trainingSession.createExportFileWritable;
  const getVideoSourceStream = videoCapture.getSourceStream;
  const startLocalVideo = localVideoRecording.start;
  const failLocalVideo = localVideoRecording.fail;
  const reportLocalVideoStartError = localVideoRecording.reportStartError;

  async function startDashboardRecording(signal?: AbortSignal): Promise<boolean> {
    if (!canStartDashboardRecording || recordingAttemptRef.current || signal?.aborted) return false;
    let resolveSetup!: () => void;
    const attempt: DashboardRecordingAttempt = {
      beta: Boolean(signal), sessionId: null, setupAbort: new AbortController(),
      setupDone: new Promise<void>((resolve) => { resolveSetup = resolve; }),
      setupFinished: false, videoStarted: false, telemetryGap: false,
      failure: null, finish: null, finishVideo: null, removeAbortListener: () => undefined,
    };
    recordingAttemptRef.current = attempt;
    setAutoCaptureActive(attempt.beta);
    setAutoCaptureDataGap(false);
    const cancelSetup = () => {
      if (!attempt.setupFinished) attempt.setupAbort.abort();
      // ARM cancellation must freeze an already-started RC Session even if setup cleanup stalls.
      void finishDashboardRecording();
    };
    signal?.addEventListener("abort", cancelSetup, { once: true });
    attempt.removeAbortListener = () => signal?.removeEventListener("abort", cancelSetup);
    setWorkspaceView("live");
    if (activeChannel) setRecordingPilotName({ pilotChannelId: activeChannel.id, athleteCode });
    const startedAtEpochMs = captureInteractionEpochMs();
    let writable: Awaited<ReturnType<typeof createExportFileWritable>> | null = null;
    let compositor: Awaited<ReturnType<typeof startStickVideoCompositor>> | null = null;
    let delegatedToRecorder = false;
    const assertActive = () => {
      if (attempt.setupAbort.signal.aborted || !attempt.sessionId || !isTrainingSessionRecording(attempt.sessionId)) {
        throw new DOMException("本次记录启动已取消", "AbortError");
      }
    };
    try {
      attempt.sessionId = await startTrainingSession();
      if (!attempt.sessionId) throw new Error("记录未能开始，请检查输入与本机存储");
      assertActive();
      if (!recordPilotVideo) return true;
      if (!activeRecordingSourceId || !activeRecordingPilotChannelId || !localVideoMimeType) {
        throw new Error("当前选手视频输出尚未准备好");
      }
      const filename = localVideoRecordingFilename({
        athleteCode,
        sessionId: attempt.sessionId,
        startedAtEpochMs,
        cropped: activeViewportIsCropped,
        mimeType: localVideoMimeType,
      });
      writable = await createExportFileWritable(filename);
      assertActive();
      const sourceStream = getVideoSourceStream(activeRecordingSourceId);
      if (!sourceStream || sourceStream.getVideoTracks().length === 0) {
        throw new Error("当前 HDMI 画面没有可录制的视频轨道");
      }
      compositor = await startStickVideoCompositor({
        sourceStream,
        ...(activeViewportIsCropped && activeViewport ? { crop: activeViewport.crop } : {}),
        frameRate: Math.max(1, Math.min(60, captureFrameRate ?? 30)),
        athleteCode,
        getTelemetry: () => recordingTelemetryRef.current,
        getOverlayAppearance: () => recordingOverlayAppearanceRef.current,
        getLinkState: () => telemetryWorkspaceStore.getSnapshot(activeRecordingPilotChannelId).linkState,
        getConnection: () => telemetryWorkspaceStore.getSnapshot(activeRecordingPilotChannelId).connection,
        onError: (recordingError) => {
          if (attempt.setupAbort.signal.aborted && !attempt.setupFinished) return;
          attempt.failure = recordingError;
          void failLocalVideo(recordingError);
        },
        signal: attempt.setupAbort.signal,
      });
      assertActive();
      recordingCompositorRef.current = compositor;
      delegatedToRecorder = true;
      attempt.videoStarted = await startLocalVideo({
        stream: compositor.stream,
        writable,
        filename,
        mimeType: localVideoMimeType,
        stopStreamTracksOnFinish: true,
        startedAtEpochMs: captureInteractionEpochMs(),
      });
      if (!attempt.videoStarted) throw new Error("视频编码器未能启动");
      assertActive();
    } catch (recordingError) {
      const cancelled = recordingError instanceof DOMException && recordingError.name === "AbortError";
      if (!cancelled) {
        attempt.failure = recordingError instanceof Error ? recordingError : new Error("录像启动失败");
        reportLocalVideoStartError(attempt.failure);
      }
      if (!attempt.videoStarted) compositor?.dispose();
      if (!delegatedToRecorder) {
        try {
          if (writable?.abort) await writable.abort(recordingError);
          else await writable?.close();
        } catch (closeError) {
          attempt.failure = closeError instanceof Error ? closeError : new Error("临时录像文件未能关闭");
          reportLocalVideoStartError(attempt.failure);
        }
      }
    } finally {
      attempt.setupFinished = true;
      attempt.removeAbortListener();
      resolveSetup();
    }
    if (!attempt.sessionId || attempt.setupAbort.signal.aborted || (attempt.beta && attempt.failure)) {
      await finishDashboardRecording(attempt.failure ? "signal_lost" : "disabled");
      return false;
    }
    return !attempt.failure;
  }

  async function finishDashboardRecording(reason: ArmAutoRecordStopReason = "disabled") {
    const attempt = recordingAttemptRef.current;
    if (!attempt) return;
    if (!attempt.setupFinished) attempt.setupAbort.abort();
    if (!attempt.finish) {
      attempt.finish = (async () => {
        if (!attempt.sessionId) await attempt.setupDone;
        try {
          if (attempt.sessionId) await stopTrainingSession(attempt.beta && (attempt.telemetryGap || attempt.failure || reason === "signal_lost")
            ? "telemetry_unavailable" : undefined);
          // RC persistence above is independent. ARM completion still owns the old media lifetime.
          await finishAttemptVideo(attempt).catch(() => undefined);
        } finally {
          attempt.removeAbortListener();
          if (recordingAttemptRef.current === attempt) {
            recordingAttemptRef.current = null;
            setAutoCaptureActive(false);
          }
        }
      })();
    }
    return attempt.finish;
  }

  async function stopDashboardRecording() {
    const finishing = finishDashboardRecording();
    await Promise.all([automatic.disable(), finishing]);
  }

  const finishFailedBetaVideo = useEffectEvent(() => {
    const attempt = recordingAttemptRef.current;
    if (!attempt?.beta) return;
    attempt.failure ??= new Error(localVideoRecording.error ?? "视频录制失败");
    if (attempt.finish) void stopTrainingSession("telemetry_unavailable");
    void finishDashboardRecording("signal_lost");
    void automatic.disable();
  });
  useEffect(() => {
    if (localVideoRecording.state === "error") finishFailedBetaVideo();
  }, [localVideoRecording.state]);

  const failVideoAfterSourceLoss = useEffectEvent(() => {
    void failLocalVideo(new Error("当前 HDMI 视频源已中断；断线前片段已关闭，但不算完整录像"));
  });

  useEffect(() => {
    if (localVideoRecording.state === "recording" && videoState !== "live") {
      failVideoAfterSourceLoss();
    }
  }, [localVideoRecording.state, videoState]);
  const lastSessionValidity = trainingSession.lastSession
    ? trainingSession.lastSession.validity.valid
      ? "技术有效：真实 GROUND_RC、≥60 秒、≥300 个不重复样本、时间戳严格单调且已关联代号"
      : `技术无效：${trainingSession.lastSession.validity.reasons.map((reason) => invalidReasonCopy[reason]).join("；")}`
    : null;
  const lastSessionAttemptCandidate = trainingSession.lastSession
    ? assessTrainingAttemptCandidate(trainingSession.lastSession)
    : null;
  const progress = trainingSessionProgress(trainingSession.elapsedMs, trainingSession.uniqueSampleCount);
  const visibleError = trainingSession.storageError || preferenceError || error || videoError;
  const analyticsErrorSurface = useDashboardAnalyticsErrorSurface({
    storageError: trainingSession.storageError,
    preferenceError,
    serialErrorCode: telemetryControl.errorCode,
    videoErrorCode,
  });
  const leftStickTrail = useMemo(() => stickMotion.samples.map((sample) => sample.left), [stickMotion.samples]);
  const rightStickTrail = useMemo(() => stickMotion.samples.map((sample) => sample.right), [stickMotion.samples]);
  const leftStickLayout = coachMode ? COACH_LEFT_STICK_LAYOUT : stickOverlayMode === "trail" ? TRAIL_LEFT_STICK_LAYOUT : SIMPLE_LEFT_STICK_LAYOUT;
  const rightStickLayout = coachMode ? COACH_RIGHT_STICK_LAYOUT : stickOverlayMode === "trail" ? TRAIL_RIGHT_STICK_LAYOUT : SIMPLE_RIGHT_STICK_LAYOUT;
  const overlayLayoutScope = coachMode ? `coach.${stickOverlayMode}` : stickOverlayMode;
  const leftStickStorageKey = `fpvhelper.overlay.${overlayLayoutScope}.left-stick.v1`;
  const rightStickStorageKey = `fpvhelper.overlay.${overlayLayoutScope}.right-stick.v1`;
  const overlayPairStorageKey = `fpvhelper.overlay.${overlayLayoutScope}.pair.v1`;
  const defaultStickOverlayPair = useMemo<StickOverlayPairLayout>(() => ({
    left: leftStickLayout,
    right: rightStickLayout,
    docked: false,
    locked: false,
  }), [leftStickLayout, rightStickLayout]);
  const overlayPairStorageOptions = useMemo(() => ({
    storageKey: overlayPairStorageKey,
    leftStorageKey: leftStickStorageKey,
    rightStorageKey: rightStickStorageKey,
    defaultPair: defaultStickOverlayPair,
  }), [defaultStickOverlayPair, leftStickStorageKey, overlayPairStorageKey, rightStickStorageKey]);
  const { pairLayout: stickOverlayPair, storePairLayout: storeStickOverlayPair } = useStickOverlayPairLayout(overlayPairStorageOptions);
  useEffect(() => {
    const stage = activeVideoStageRef.current;
    if (!stage) return;
    const updateRecordingAppearance = () => {
      const bounds = stage.getBoundingClientRect();
      // Keep the last visible geometry when the live workspace is hidden during recording.
      if (bounds.width <= 0 || bounds.height <= 0) return;
      recordingOverlayAppearanceRef.current = {
        pair: stickOverlayPair, stageWidth: bounds.width, stageHeight: bounds.height,
        opacity: stickOverlayOpacity, mode: stickOverlayMode,
      };
    };
    updateRecordingAppearance();
    const observer = new ResizeObserver(updateRecordingAppearance);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stickOverlayPair, stickOverlayOpacity, stickOverlayMode, activeViewport?.id, hasPilots, videoWorkspace.activePilotChannelId, workspaceView]);
  const updateStickOverlayPair = useCallback((pair: StickOverlayPairLayout, persist: boolean) => {
    storeStickOverlayPair(pair, persist);
    if (persist) setOverlayLayoutNotice(pair.locked ? "布局已保存 · 已锁定" : "布局已保存");
  }, [storeStickOverlayPair]);
  const toggleStickOverlayPairLock = useCallback(() => {
    if (!stickOverlayPair.docked) return;
    const nextPair = { ...stickOverlayPair, locked: !stickOverlayPair.locked };
    storeStickOverlayPair(nextPair, true);
    setOverlayLayoutNotice(nextPair.locked ? "左右摇杆已锁定" : "左右摇杆已解锁");
  }, [stickOverlayPair, storeStickOverlayPair]);
  const analytics = useAnalyticsLifecycle({
    telemetryContextKey: activeChannel?.id ?? "unassigned",
    connection,
    source,
    videoState,
    telemetrySequence: telemetry.sequence,
    isRecording: trainingSession.isRecording,
    sessionId: trainingSession.sessionId,
    lastSession: trainingSession.lastSession,
    lastExport: trainingSession.lastExport,
    unexportedValidCount: trainingSession.unexportedValidCount,
    hasPendingSave: trainingSession.hasPendingSave,
    athleteSet: normalizeAthleteCode(athleteCode).length > 0,
    overlayMode: stickOverlayMode,
    serialSupported: telemetryControl.serialSupported,
    mediaSupported: typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia),
    serialErrorCode: telemetryControl.errorCode,
    videoErrorCode,
    parserStats: telemetryControl.parserStats,
    captureSettings,
    errorSurface: analyticsErrorSurface,
  });

  useEffect(() => {
    diagnosticTransitionsRef.current = appendDiagnosticTransition(diagnosticTransitionsRef.current, {
      connection,
      source,
      linkState,
      videoState,
      isRecording: trainingSession.isRecording,
      parserQuality: telemetryControl.parserQuality,
      serialErrorCode: telemetryControl.errorCode,
      videoErrorCode,
      storageReady: trainingSession.storageReady,
      storageHasError: Boolean(trainingSession.storageError),
    });
  }, [
    connection,
    linkState,
    source,
    telemetryControl.errorCode,
    telemetryControl.parserQuality,
    trainingSession.isRecording,
    trainingSession.storageError,
    trainingSession.storageReady,
    videoErrorCode,
    videoState,
  ]);
  const analyticsStatusLabel = analytics.status.state === "enabled"
    ? "已开启"
    : analytics.status.state === "waiting_token"
      ? "等待工作站令牌"
      : "关闭";
  const analyticsStatusCopy = analytics.status.reason === "hostname"
    ? "当前域名仅用于内部验证，不采集统计事件。"
    : analytics.status.reason === "configuration"
      ? "当前发布未开启客户统计。训练、记录与导出不受影响。"
      : analytics.status.reason === "opted_out"
        ? "本机已关闭统计并清除了令牌与待发送队列；随机工作站 ID 仍保留给本地 Session 台账，不会因此发送。"
        : analytics.status.reason === "rejected_token"
          ? "工作站令牌已被服务端拒绝；待发送事件仍保留在本机，请粘贴新令牌。"
        : analytics.status.reason === "replacement"
          ? "已暂停发送并清除旧令牌；工作站 ID 与待发送队列仍保留，请粘贴新令牌。"
        : analytics.status.state === "waiting_token"
          ? "需要俱乐部管理员在本机一次性安装工作站令牌。"
      : "只发送白名单内的假名化运行事件；视频、原始 RC、代号与备注不会上传。";

  const executeWorkstationShortcut = useEffectEvent((shortcut: ReturnType<typeof classifyWorkstationShortcut>, event?: KeyboardEvent) => {
    if (!shortcut) return;
    if (shortcut === "toggle_fullscreen") {
      void toggleCoachMode();
    } else if (shortcut === "record_hold") {
      const action = workstationRecordHoldAction({
        isRecording: trainingSession.isRecording,
        isStarting: trainingSession.isStarting,
        isFinishing: trainingSession.isFinishing,
        canStart: canStartDashboardRecording && !automatic.state.enabled,
        tabAllowsStart: true,
      });
      if (action === "stop") {
        setWorkstationNotice("空格长按：正在结束并保存记录");
        void stopDashboardRecording();
      } else if (action === "start") {
        setWorkstationNotice("空格长按：正在开始记录");
        void startDashboardRecording();
      } else {
        setWorkstationNotice("当前尚未满足开始记录条件");
      }
    } else if (shortcut === "add_marker" && trainingSession.isRecording) {
      void trainingSession.addMarker(selectedMarkerKind);
    } else if (shortcut === "export_latest" && !trainingSession.isRecording && !trainingSession.hasPendingSave && !trainingSession.isFinishing && trainingSession.lastSession) {
      if (exportShortcutInFlightRef.current) return;
      exportShortcutInFlightRef.current = true;
      void trainingSession.exportSession(trainingSession.lastSession.id)
        .finally(() => {
          exportShortcutInFlightRef.current = false;
        });
    } else if (shortcut === "cancel_connection" && event) {
      const action = dashboardEscapeAction(event, { document, coachMode, controlsLocked, connection });
      if (action === "exit_coach") {
        setCoachMode(false);
        setWorkstationNotice("Esc：已退出页面内大屏模式");
      } else if (action === "cancel_pending_connection") {
        setWorkstationNotice("Esc：正在取消连接并返回演示");
        analytics.markDemoReturnIntentional();
        void telemetryControl.useDemo();
      }
    }
  });

  useEffect(() => {
    const recordHold = createRecordHoldController({
      delayMs: RECORD_SHORTCUT_HOLD_MS,
      schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearScheduled: (timer) => window.clearTimeout(timer as number),
      canTrigger: () => document.visibilityState === "visible" && document.hasFocus(),
      onTrigger: () => executeWorkstationShortcut("record_hold"),
      onCancel: (reason) => {
        setWorkstationNotice(reason === "released"
          ? "空格按住时间不足，未改变记录状态"
          : "页面已失焦或不可见，空格操作已取消");
      },
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      const shortcut = classifyWorkstationShortcut({
        key: event.key,
        code: event.code,
        repeat: event.repeat,
        modified: event.altKey || event.ctrlKey || event.metaKey,
        interactive: isWorkstationInteractiveTarget(event.target),
        singleKeyEnabled: singleKeyShortcutsEnabled,
      });
      if (!shortcut) return;
      if (workstationShortcutShouldPreventDefault(shortcut)) event.preventDefault();

      if (shortcut === "record_hold") {
        if (recordHold.press()) setWorkstationNotice("继续按住空格 0.7 秒以开始或结束记录");
        return;
      }

      if (shortcut === "toggle_fullscreen") {
        executeWorkstationShortcut(shortcut);
      } else if (shortcut === "add_marker") {
        executeWorkstationShortcut(shortcut);
      } else if (shortcut === "export_latest") {
        executeWorkstationShortcut(shortcut);
      } else if (shortcut === "cancel_connection") {
        executeWorkstationShortcut(shortcut, event);
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space" && event.key !== " ") return;
      if (recordHold.release()) event.preventDefault();
    };

    const cancelRecordHold = () => recordHold.cancel();
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") cancelRecordHold();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", cancelRecordHold);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      recordHold.cancel();
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", cancelRecordHold);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [singleKeyShortcutsEnabled]);
  const completedSessionId = trainingSession.lastSession?.id;
  useEffect(() => {
    const attempt = recordingAttemptRef.current;
    if (!attempt?.setupFinished || attempt.sessionId !== completedSessionId || trainingSession.isRecording
      || trainingSession.isStarting || sessionIsFinalizing || trainingSession.hasPendingMedia || localVideoRecording.isActive) return;
    attempt.removeAbortListener();
    recordingAttemptRef.current = null;
    setAutoCaptureActive(false);
  }, [completedSessionId, localVideoRecording.isActive, sessionIsFinalizing, trainingSession.hasPendingMedia, trainingSession.isRecording, trainingSession.isStarting]);
  useEffect(() => {
    if (trainingSession.isRecording) recordingWasActive.current = true;
    if (!recordingWasActive.current || trainingSession.isRecording || sessionIsFinalizing || !completedSessionId) return;
    const timer = window.setTimeout(() => {
      recordingWasActive.current = false;
      if (automatic.state.enabled) return;
      setSelectedSessionId(completedSessionId);
      setRevealSessionId(completedSessionId);
      setWorkspaceView("records");
      setCoachMode(false);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      workspaceHeadingRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [automatic.state.enabled, trainingSession.isRecording, sessionIsFinalizing, completedSessionId]);

  function openArmAutoRecordSettings() {
    setWorkspaceView("live");
    window.setTimeout(() => {
      const details = armSettingsRef.current;
      if (!details) return;
      const parent = details.parentElement?.closest("details");
      if (parent) parent.open = true;
      details.open = true;
      details.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
  }

  function navigateWorkspace(view: WorkspaceView) {
    if (view === "experiments") setExperimentsOpened(true);
    setWorkspaceView(view);
    workspaceHeadingRef.current?.focus();
  }
  const currentPage = workspaceView === "experiments"
    ? { label: "实时过门实验", description: "单路画面识别，过门结果由你复核。" }
    : workspaceNavigation.find((item) => item.id === workspaceView)!;
  const librarySessions = trainingSession.lastSession && !trainingSession.isRecording && (trainingSession.hasPendingSave || !trainingSession.allSessions.some((session) => session.id === trainingSession.lastSession?.id))
    ? [trainingSession.lastSession, ...trainingSession.allSessions.filter((session) => session.id !== trainingSession.lastSession?.id)]
    : trainingSession.allSessions;

  return (
    <div className={`workspace-shell ${coachMode ? "workspace-shell--coach" : ""}`}>
      <a className="skip-link" href="#workspace-main">跳到工作区</a>
      <aside className="workspace-nav">
        <button className="workspace-brand" type="button" aria-label="FPV Helper 首页" onClick={() => navigateWorkspace("live")}>
          <svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M5 25V7h22v18M11 25V13h10v12M2 25h12m4 0h12" stroke="currentColor" strokeWidth="2.4" /></svg>
          <span>fpv<span>helper</span><small>Flight, in perspective.</small></span>
        </button>
        <div className="workspace-local-label"><span>L</span><div>本地工作区<small>专注训练，持续进步</small></div></div>
        <nav aria-label="主导航">
          {workspaceNavigation.map((item) => (
            <button key={item.id} type="button" className={`workspace-nav-item ${workspaceView === item.id ? "is-active" : ""}`} aria-label={item.label} aria-current={workspaceView === item.id ? "page" : undefined} onClick={() => navigateWorkspace(item.id)}>
              <Icon name={item.icon} /><span>{item.label}</span>{item.id === "records" && trainingSession.allSessions.length > 0 ? <small>{trainingSession.allSessions.length}</small> : null}
            </button>
          ))}
        </nav>
        <div className="workspace-nav-footer"><Icon name="shield" /><p>留在本机，专注飞行<small>实时画面与训练记录本机处理</small></p><span>LongXL <small>Made for pilots.</small></span></div>
      </aside>
      <main id="workspace-main" className={`workspace-main dashboard-shell ${coachMode ? "dashboard-shell--coach" : ""}`}>
      <div className="workspace-page-heading">
        <div><p>{currentPage.description}</p><h1 ref={workspaceHeadingRef} tabIndex={-1}>{currentPage.label}<span className="heading-dot">.</span></h1></div>
        <span className={`status-chip status-chip--${connection}`}><i />{hasPilots ? statusCopy[connection] : "待添加飞手"}</span>
      </div>
      <PilotTelemetryWorkspaceHost
        pilotChannelIds={pilotChannelIds}
        activePilotChannelId={activeChannel?.id}
        store={telemetryWorkspaceStore}
      />
      <header className="topbar" hidden={!hasPilots}>
        <div className="session-strip">
          <span className="session-meta">当前选手 <b>{athleteCode.trim() || "待填写"}</b></span>
          <span className="session-meta">采集目标 <b>100 Hz</b></span>
          {source === "serial" ? <span className="session-meta">实收 <b>{telemetryControl.rcReceiveHz === null ? "—" : `${telemetryControl.rcReceiveHz} Hz`}</b></span> : null}
          <span className="session-meta">链路 <b>{source === "demo" ? "演示 · 20 Hz" : !bridgeIsLive ? "等待数据" : linkState === "ok" ? "RX 正常" : linkState === "lost" ? "RX 丢失" : "RX 待确认"}</b></span>
          {trainingSession.isRecording ? <span className="session-meta">记录中 <b>{formatSessionDuration(trainingSession.elapsedMs)}</b></span> : null}
        </div>

        <div className="top-actions">
          <OnboardingChecklist autoOpen={videoWorkspace.addedPilotChannelIds === undefined} />
          <button
            className={`button button--quiet button--coach ${coachMode ? "button--coach-active" : ""}`}
            type="button"
            aria-pressed={coachMode}
            title={singleKeyShortcutsEnabled ? "F 键切换全屏教练大屏；Esc 退出" : "点击切换教练大屏；页面内大屏可按 Esc 退出"}
            onClick={() => void toggleCoachMode()}
          >{coachMode ? "退出大屏" : "教练大屏"}{singleKeyShortcutsEnabled ? " (F)" : ""}</button>
          <label className="recording-mode-control">
            <span>录制内容</span>
            <select
              aria-label="录制内容"
              value={recordPilotVideo ? "video" : "data"}
              disabled={controlsLocked}
              onChange={(event) => updateTrainingPreferences({
                autoExport,
                recordPilotVideo: event.target.value === "video",
                showStickOverlays,
                stickOverlayMode,
              })}
            >
              <option value="video">视频＋打杆 OSD＋数据</option>
              <option value="data">仅原始打杆数据</option>
            </select>
          </label>
          <button className="button button--quiet" type="button" onClick={openArmAutoRecordSettings}>ARM 自动记录 · Beta</button>
          <button
            className={`button button--record ${trainingSession.isRecording ? "button--recording" : ""}`}
            type="button"
            aria-pressed={trainingSession.isRecording}
            disabled={trainingSession.isRecording ? sessionIsFinalizing : automatic.state.enabled || !canStartDashboardRecording || localVideoRecording.isActive}
            title={trainingSession.isRecording ? "结束并保存当前 Session" : startRequirement}
            onClick={() => void (trainingSession.isRecording ? stopDashboardRecording() : startDashboardRecording())}
          >
            {sessionIsFinalizing ? "保存遥控数据…" : trainingSession.hasPendingMedia ? "等待视频完成…" : trainingSession.isStarting || localVideoRecording.state === "starting" ? "准备记录…" : trainingSession.isRecording ? "■ 结束记录" : "● 开始记录"}
          </button>
          {source === "serial" ? (
            <button
              className="button button--quiet"
              disabled={controlsLocked}
              onClick={() => {
                analytics.markDemoReturnIntentional();
                void telemetryControl.useDemo();
              }}
            >返回演示</button>
          ) : null}
          <button
            className="button button--primary"
            disabled={!tabAllowsStart || controlsLocked || connection === "connecting"}
            title={tabAllowsStart ? "选择串口并连接桥接飞控" : tabStartBlockReason ?? undefined}
            onClick={() => {
              analytics.beginSerialConnect();
              void telemetryControl.connectSerial();
            }}
          >
            <span className="usb-icon">⌁</span>连接桥接飞控
          </button>
        </div>
      </header>

      <div data-testid="auto-phase" data-phase={automatic.state.phase}>
        {automatic.state.enabled || automatic.state.error ? (
          <aside className="workstation-banner" role="status">
            <b>ARM 自动记录 · Beta</b>
            <span>{automatic.state.disarmRemainingMs !== null
              ? <span data-testid="disarm-countdown">{armAutoRecordStatus(automatic.state)}</span>
              : armAutoRecordStatus(automatic.state)}</span>
            {autoCaptureDataGap ? <span>本段有遥控数据缺口，视频继续记录。</span> : null}
          </aside>
        ) : null}
      </div>

      {hasPilots && !controlsLocked ? (
        <section className="recording-readiness" aria-label="录制准备">
          <div className="recording-readiness__summary">
            <b>{recordPilotVideo ? "视频与打杆，一起留下。" : "本次仅保存原始打杆数据"}</b>
            <span>{recordPilotVideo
              ? `录制当前选手${athleteCode.trim() ? ` ${athleteCode.trim()}` : ""}的${activeViewportIsCropped ? "裁切" : "完整"}画面，烧入打杆 OSD。${localVideoFormatCopy}`
              : "需要视频时，在上方将录制内容切换为「视频＋打杆 OSD＋数据」。"}</span>
          </div>
          <div className="recording-readiness__steps">
            {recordPilotVideo ? (
              <button
                type="button"
                className="recording-readiness__step"
                data-ready={videoState === "live"}
                disabled={!tabAllowsStart || !activeSource || !activeViewport || videoState === "live" || videoState === "connecting"}
                onClick={() => { if (activeSource) void videoCapture.connectSource(activeSource.id); }}
              ><span>视频画面</span><b>{videoState === "live" ? "已接入" : videoState === "connecting" ? "正在连接…" : "打开当前输入 →"}</b></button>
            ) : null}
            <button
              type="button"
              className="recording-readiness__step"
              data-ready={groundRxReady}
              disabled={!tabAllowsStart || source === "serial" || connection === "connecting" || !telemetryControl.serialSupported}
              onClick={() => {
                analytics.beginSerialConnect();
                void telemetryControl.connectSerial();
              }}
            ><span>{recordPilotVideo ? "打杆 OSD" : "打杆数据"}</span><b>{groundRxReady ? "真实输入已就绪" : connection === "connecting" ? "正在连接…" : source === "serial" ? "等待遥控链路恢复" : "连接当前选手 →"}</b></button>
            {recordPilotVideo ? (
              <button
                type="button"
                className="recording-readiness__step"
                data-ready={trainingSession.exportDirectoryState === "ready"}
                title={exportDirectoryCopy}
                disabled={trainingSession.exportDirectoryState === "ready" || trainingSession.exportDirectoryState === "loading" || trainingSession.exportDirectoryState === "unsupported"}
                onClick={() => void (trainingSession.exportDirectoryName && (trainingSession.exportDirectoryState === "permission_required" || trainingSession.exportDirectoryState === "error")
                  ? trainingSession.reauthorizeExportDirectory()
                  : trainingSession.configureExportDirectory())}
              ><span>保存文件夹</span><b>{trainingSession.exportDirectoryState === "ready" ? "已授权" : trainingSession.exportDirectoryState === "loading" ? "正在检查…" : trainingSession.exportDirectoryState === "unsupported" ? "浏览器不支持" : trainingSession.exportDirectoryName ? "授权保存目录 →" : "选择保存目录 →"}</b></button>
            ) : null}
          </div>
          <p className="recording-readiness__result" data-ready={canStartDashboardRecording}>
            {canStartDashboardRecording ? "已就绪，点击「开始记录」。" : startRequirement}
          </p>
        </section>
      ) : null}

      {tabStartBlockReason ? (
        <aside className="workstation-banner workstation-banner--blocked" role="alert">
          <b>工作站状态</b>
          <span>{tabStartBlockReason}</span>
        </aside>
      ) : null}

      {trainingSession.isRecording && workstation.wakeState !== "active" ? (
        <aside className="workstation-banner workstation-banner--blocked" role="alert">
          <b>屏幕唤醒</b>
          <span>{workstation.wakeState === "requesting"
            ? "正在请求保持屏幕唤醒"
            : workstation.wakeState === "unsupported"
              ? "当前浏览器不支持 Wake Lock；请手动关闭系统休眠并保持本页可见"
              : "屏幕保持唤醒失败或已释放；请保持本页可见并检查系统休眠设置"}</span>
        </aside>
      ) : null}

      {workstationNotice ? (
        <aside className="workstation-banner" role="status">
          <b>快捷操作</b>
          <span>{workstationNotice}</span>
        </aside>
      ) : null}

      {visibleError && (
        <aside className="error-banner" role="status">
          <b>{trainingSession.storageError || preferenceError ? "存储提示" : "连接提示"}</b>
          <span>{visibleError}</span>
          {trainingSession.hasPendingSave && !trainingSession.isFinishing ? (
            <button className="mini-button mini-button--active" type="button" onClick={() => void trainingSession.retryPendingSave()}>重试保存</button>
          ) : null}
        </aside>
      )}

      <TrainingExportNotice
        notice={trainingSession.exportNotice}
        warning={trainingSession.exportWarning}
      />

      {workspaceView !== "live" && localVideoRecording.state !== "idle" ? (
        <aside className={`export-banner ${localVideoRecording.state === "error" ? "export-banner--warning" : ""}`} role="status">
          <b>本地视频</b><span>{localVideoStatusCopy}</span>
        </aside>
      ) : null}

      {version.updateAvailable ? (
        <aside className="update-banner" role="status">
          <div>
            <b>发现新版本 {version.latest?.version}</b>
            <span>{trainingSession.isRecording ? "本次记录结束后刷新" : "可手动刷新以使用最新版本"}</span>
          </div>
          {!trainingSession.isRecording ? (
            <button className="mini-button mini-button--active" type="button" onClick={() => window.location.reload()}>
              刷新更新
            </button>
          ) : null}
        </aside>
      ) : null}

      <div className="workspace-view workspace-view--live" hidden={workspaceView !== "live"}>
      {hasPilots ? <div className={pilotSetupStyles.bar}>
        <div><b>{configuredPilotIds.length} 位飞手</b><span>每位飞手对应一个画面，点击画面切换当前飞手。</span></div>
        <button className="button button--primary" type="button" disabled={controlsLocked || !tabAllowsStart} onClick={() => setAddingPilot(true)}>＋ 添加飞手</button>
      </div> : <section className={pilotSetupStyles.empty} aria-label="添加第一位飞手">
        <div className={pilotSetupStyles.emptyFrame} aria-hidden="true">＋</div>
        <h2>先添加一位飞手</h2>
        <p>为飞手选择对应的视频输入或画面区域。<br />添加几位飞手，就显示几个画面。</p>
        <button className="button button--primary" type="button" disabled={controlsLocked || !tabAllowsStart} onClick={() => setAddingPilot(true)}>＋ 添加飞手</button>
        <small>可以逐个添加，稍后继续连接视频与遥控。</small>
      </section>}
      {addingPilot && <AddPilotDialog workspace={videoWorkspace} occupiedPilotIds={occupiedPilotIds()} disabled={controlsLocked || !tabAllowsStart} onClose={() => setAddingPilot(false)} onRestore={(channelId) => {
        if (controlsLocked || !tabAllowsStart) return false;
        try {
          const current = loadVideoWorkspace(window.localStorage).workspace;
          const next = restorePilotToWorkspace(current, channelId, occupiedPilotIds());
          return next !== current && commitVideoWorkspace(next);
        } catch {
          return false;
        }
      }} onAdd={(input) => {
        if (controlsLocked || !tabAllowsStart) return false;
        try {
          const current = loadVideoWorkspace(window.localStorage).workspace;
          const next = addPilotToWorkspace(current, input, occupiedPilotIds());
          return next !== current && commitVideoWorkspace(next);
        } catch {
          return false;
        }
      }} />}
      <div hidden={!hasPilots}>
      <div className="preflight-strip">
        {activeChannel ? <PilotNameField
          compact
          channel={activeChannel}
          deviceNames={pilotDeviceNames[activeChannel.id]}
          disabled={controlsLocked}
          onChange={(athleteCode) => commitVideoWorkspace(updatePilotChannel(videoWorkspace, activeChannel.id, { athleteCode }))}
          onUseDeviceName={() => commitVideoWorkspace(setPilotChannelAutomaticName(videoWorkspace, activeChannel.id))}
        /> : null}
        <span className={groundRxReady ? "is-ready" : ""}><Icon name={groundRxReady ? "check" : "usb"} size={16} />{groundRxReady ? "遥控输入就绪" : source === "demo" ? "正在预览演示输入" : "等待真实遥控输入"}</span>
        <span><Icon name="camera" size={16} />{liveVideoSourceCount ? `${liveVideoSourceCount} 路画面在线` : recordPilotVideo ? "视频录制需接入画面" : "视频可选接入"}</span>
        <small>{trainingSession.isRecording ? `已标记 ${trainingSession.markerCount} 个片段` : startRequirement}</small>
      </div>
      <div className="workspace-grid workspace-grid--simple">
        <section className="video-console">
          <div className="section-bar">
            <div>
              <span className={`live-dot ${videoState === "live" ? "is-live" : ""}`} />
              <b>HDMI IN / {activeSource ? videoSourceDisplayName(videoWorkspace.sources, activeSource) : "MAIN FEED"}</b>
              <small>
                {videoFormatLabel ? `${videoLabel} · ${videoFormatLabel}` : videoLabel}
                {activeViewport ? ` · ${activeViewport.label}` : ""}
              </small>
            </div>
            <div className="video-controls">
              <label>
                <span className="sr-only">视频采集设备</span>
                <select
                  value={selectedDeviceId}
                  disabled={activeVideoControlsLocked}
                  onChange={(event) => {
                    const deviceId = event.target.value;
                    if (activeSource) {
                      commitVideoWorkspace(setVideoSourceDevice(videoWorkspace, activeSource.id, deviceId));
                    }
                  }}
                >
                  <option value="">自动选择采集卡</option>
                  {videoDevices.map((device, index) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || `视频输入 ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
              {videoState === "live" ? (
                <button
                  className="mini-button"
                  onClick={() => {
                    analytics.markVideoDisconnectIntentional();
                    if (activeSource) videoCapture.disconnectSource(activeSource.id);
                  }}
                >断开画面</button>
              ) : (
                <button
                  className="mini-button mini-button--active"
                  disabled={!tabAllowsStart || videoState === "connecting"}
                  title={tabAllowsStart ? "打开视频采集画面" : tabStartBlockReason ?? undefined}
                  onClick={() => {
                    analytics.beginVideoConnect();
                    if (activeSource) void videoCapture.connectSource(activeSource.id);
                  }}
                >{videoState === "connecting" ? "正在打开" : "打开画面"}</button>
              )}
              {videoWorkspace.sources.length > 1 ? (
                anyVideoLive || connectingVideoSourceCount > 0 ? (
                  <button
                    className="mini-button"
                    type="button"
                    disabled={controlsLocked}
                    onClick={() => {
                      analytics.markVideoDisconnectIntentional();
                      videoCapture.disconnectAll();
                    }}
                  >断开全部</button>
                ) : (
                  <button
                    className="mini-button mini-button--active"
                    type="button"
                    disabled={!tabAllowsStart || controlsLocked}
                    onClick={() => {
                      analytics.beginVideoConnect();
                      void videoCapture.connectAll();
                    }}
                  >打开全部</button>
                )
              ) : null}
              <details className="overlay-options"><summary>摇杆叠层</summary><div className="overlay-options-body">
              <button
                className={`mini-button overlay-visibility-toggle ${showStickOverlays ? "mini-button--active" : ""}`}
                type="button"
                aria-pressed={showStickOverlays}
                onClick={() => updateTrainingPreferences({ autoExport, recordPilotVideo, showStickOverlays: !showStickOverlays, stickOverlayMode })}
              >{showStickOverlays ? "叠层开启" : "叠层关闭"}</button>
              {showStickOverlays || coachMode ? (
                <>
                  <button
                    className={`mini-button ${stickOverlayMode === "trail" ? "mini-button--active" : ""}`}
                    type="button"
                    aria-pressed={stickOverlayMode === "trail"}
                    onClick={() => {
                      if (updateTrainingPreferences({ autoExport, recordPilotVideo, showStickOverlays, stickOverlayMode: "trail" })) {
                        analytics.trackOverlayModeChange(stickOverlayMode, "trail");
                      }
                    }}
                  >动态轨迹</button>
                  <button
                    className={`mini-button ${stickOverlayMode === "simple" ? "mini-button--active" : ""}`}
                    type="button"
                    aria-pressed={stickOverlayMode === "simple"}
                    onClick={() => {
                      if (updateTrainingPreferences({ autoExport, recordPilotVideo, showStickOverlays, stickOverlayMode: "simple" })) {
                        analytics.trackOverlayModeChange(stickOverlayMode, "simple");
                      }
                    }}
                  >简洁模式</button>
                  <button
                    className="mini-button"
                    type="button"
                    onClick={() => {
                      storeStickOverlayPair(stickOverlayPair, true);
                      setOverlayLayoutNotice(stickOverlayPair.locked ? "布局已保存 · 已锁定" : "布局已保存");
                    }}
                  >{overlayLayoutNotice ?? "保存布局"}</button>
                  <button
                    className="mini-button"
                    type="button"
                    onClick={() => {
                      const wasDefault = stickOverlayPairIsDefault(stickOverlayPair, defaultStickOverlayPair);
                      storeStickOverlayPair(defaultStickOverlayPair, true);
                      updateTrainingPreferences({ stickOverlayOpacity: 1 });
                      setOverlayLayoutNotice("已恢复默认布局");
                      analytics.trackOverlayLayoutReset(wasDefault);
                    }}
                  >重置叠层</button>
                  <StickOverlayControls
                    pair={stickOverlayPair}
                    opacity={stickOverlayOpacity}
                    disabled={!hasPilots}
                    onSizeChange={(member, size) => {
                      const bounds = activeVideoStageRef.current?.getBoundingClientRect();
                      if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
                      updateStickOverlayPair(resizeStickOverlayPairLayout(stickOverlayPair, member, size - stickOverlayPair[member].size, bounds.width, bounds.height), true);
                    }}
                    onOpacityChange={(opacity) => updateTrainingPreferences({ stickOverlayOpacity: opacity })}
                  />
                </>
              ) : null}
              </div></details>
            </div>
          </div>

          <details className="video-setup-details" ref={videoSetupRef} tabIndex={-1}>
            <summary><span>输入与选手设置</span><small>{activeSource ? videoSourceDisplayName(videoWorkspace.sources, activeSource) : "配置视频输入"} · {videoWorkspace.sources.length} 路输入 · {activeViewport?.label ?? ""}</small></summary>
          <div className="video-workspace-bar" aria-label="本机视频工作区">
            <span className="video-workspace-label">已配置输入</span>
            <div className="video-source-tabs" aria-label="画面输入列表">
              {videoWorkspace.sources.map((sourceConfig, index) => (
                <button
                  key={sourceConfig.id}
                  className={`video-source-tab ${sourceConfig.id === videoWorkspace.activeSourceId ? "is-active" : ""}`}
                  type="button"
                  aria-pressed={sourceConfig.id === videoWorkspace.activeSourceId}
                  disabled={controlsLocked}
                  onClick={() => commitVideoWorkspace(selectVideoSource(videoWorkspace, sourceConfig.id))}
                >
                  <span>输入 {index + 1}</span>
                  <b>{videoSourceDisplayName(videoWorkspace.sources, sourceConfig)}</b>
                </button>
              ))}
            </div>
            <button
              className="mini-button"
              type="button"
              disabled={controlsLocked}
              onClick={() => {
                const nextWorkspace = addVideoSource(videoWorkspace);
                commitVideoWorkspace(nextWorkspace);
              }}
            >+ 独立输入</button>
            <button
              className="mini-button"
              type="button"
              disabled={controlsLocked || videoState === "live" || videoState === "connecting" || videoWorkspace.sources.length <= 1 || !activeSource}
              onClick={() => {
                if (!activeSource) return;
                const nextWorkspace = removeVideoSource(videoWorkspace, activeSource.id);
                commitVideoWorkspace(nextWorkspace);
              }}
            >移除输入</button>
            <small>配置仅保存在本机 · 已连接 {liveVideoSourceCount}/{videoWorkspace.sources.length} 路</small>
          </div>

          {activeSource && activeChannel ? (
            <PilotVideoBindingControls
              sources={videoWorkspace.sources}
              source={activeSource}
              sourceChannels={sourceChannels}
              channel={activeChannel}
              videoState={videoState}
              disabled={controlsLocked}
              registerVideoElement={videoCapture.registerVideoElement}
              onSourceChange={(sourceId) => {
                commitVideoWorkspace(selectVideoSource(videoWorkspace, sourceId));
              }}
              onSourceLabelChange={(label) => {
                commitVideoWorkspace(setVideoSourceLabel(videoWorkspace, activeSource.id, label));
              }}
              onSourceLayoutChange={(layout) => {
                commitVideoWorkspace(setVideoSourceLayout(videoWorkspace, activeSource.id, layout));
              }}
              onChannelChange={(channelId) => {
                commitVideoWorkspace(selectPilotChannel(videoWorkspace, channelId));
              }}
              onAthleteCodeChange={(athleteCode) => {
                commitVideoWorkspace(updatePilotChannel(videoWorkspace, activeChannel.id, { athleteCode }));
              }}
              deviceNames={pilotDeviceNames[activeChannel.id]}
              onUseDeviceName={() => commitVideoWorkspace(setPilotChannelAutomaticName(videoWorkspace, activeChannel.id))}
              onViewModeChange={(viewMode) => {
                commitVideoWorkspace(setPilotChannelViewMode(videoWorkspace, activeChannel.id, viewMode));
              }}
              onCropChange={(crop) => {
                commitVideoWorkspace(setPilotChannelCrop(videoWorkspace, activeChannel.id, crop));
              }}
              onResetCrop={() => {
                commitVideoWorkspace(resetPilotChannelCrop(videoWorkspace, activeChannel.id));
              }}
            />
          ) : null}

          </details>

          <div className={`video-stage ${anyVideoLive ? "has-video" : ""} ${workspaceTiles.length > 1 ? "video-stage--multi" : ""}`}>
            <div className="video-feed-grid" data-viewport-count={workspaceTiles.length}>
              {workspaceTiles.map(({ sourceConfig, viewport, channel }) => {
                const runtime = videoSourceRuntime(videoCapture.runtimes, sourceConfig.id);
                const isActive = viewport.pilotChannelId === videoWorkspace.activePilotChannelId;
                const sourceLabel = videoSourceDisplayName(videoWorkspace.sources, sourceConfig);
                const tileLabel = channel?.athleteCode.trim() || `${sourceLabel} · ${viewport.label}`;
                const isCropped = viewport.crop.xPercent !== 0
                  || viewport.crop.yPercent !== 0
                  || viewport.crop.widthPercent !== 100
                  || viewport.crop.heightPercent !== 100;
                return (
                  <div
                    key={viewport.id}
                    ref={isActive ? activeVideoStageRef : undefined}
                    className={`video-viewport ${runtime.state === "live" ? "is-live" : ""} ${isActive ? "is-active" : ""}`}
                    data-source-id={sourceConfig.id}
                    data-pilot-channel-id={viewport.pilotChannelId}
                  >
                    <WorkspaceVideoElement
                      sourceId={sourceConfig.id}
                      pilotChannelId={viewport.pilotChannelId}
                      cropped={isCropped}
                      keepFramesActive={localVideoRecording.isActive && isActive}
                      crop={viewport.crop}
                      registerVideoElement={videoCapture.registerVideoElement}
                      registerOutputCanvas={registerPilotOutputCanvas}
                    />
                    <div className="video-idle">
                      <div className="flight-gate" aria-hidden="true"><span /><span /></div>
                      <p>{runtime.state === "connecting" ? "正在打开视频" : sourceLabel}</p>
                      <small>{runtime.error ?? "浏览器本地 UVC · 仅本机处理 · 不上传"}</small>
                    </div>
                    <button
                      className={`video-viewport-select ${isActive ? "is-active" : ""}`}
                      type="button"
                      aria-pressed={isActive}
                      disabled={controlsLocked}
                      title={isActive ? "当前遥测与 Session 选手" : `切换遥测与 Session 到 ${tileLabel}`}
                      onClick={() => {
                        const selectedSource = selectVideoSource(videoWorkspace, sourceConfig.id);
                        commitVideoWorkspace(selectPilotChannel(selectedSource, viewport.pilotChannelId));
                      }}
                    >
                      <span>{isActive ? "CURRENT" : sourceLabel}</span>
                      <b>{tileLabel}</b>
                    </button>

                    <button
                      className="video-viewport-configure"
                      type="button"
                      aria-label={`配置 ${tileLabel} 的裁切与绑定`}
                      disabled={controlsLocked}
                      onClick={() => {
                        const selectedSource = selectVideoSource(videoWorkspace, sourceConfig.id);
                        commitVideoWorkspace(selectPilotChannel(selectedSource, viewport.pilotChannelId));
                        if (videoSetupRef.current) {
                          videoSetupRef.current.open = true;
                          videoSetupRef.current.focus({ preventScroll: true });
                          videoSetupRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
                        }
                      }}
                    >裁切与绑定</button>

                    <PilotViewportTelemetry
                      pilotChannelId={viewport.pilotChannelId}
                      label={tileLabel}
                      active={isActive}
                      controlsLocked={controlsLocked || !tabAllowsStart}
                      store={telemetryWorkspaceStore}
                      onActivate={() => {
                        const selectedSource = selectVideoSource(videoWorkspace, sourceConfig.id);
                        commitVideoWorkspace(selectPilotChannel(selectedSource, viewport.pilotChannelId));
                      }}
                      onBeginSerialConnect={analytics.beginSerialConnect}
                      onDemoReturnIntentional={analytics.markDemoReturnIntentional}
                    />

                    {isActive ? (
                      <>
                        <DemoTelemetryWatermark source={source} />
                        <div className={`coach-status coach-status--${connection}`}>
                          <span><i />{statusCopy[connection]} · {source === "demo" ? "DEMO" : "真实 GROUND_RC"}</span>
                          <b>{trainingSession.isRecording
                            ? `● REC ${formatSessionDuration(trainingSession.elapsedMs)}${localVideoRecording.state === "recording" ? " · VIDEO" : " · RC"}`
                            : "REC 待命"}</b>
                          <strong>THR {Math.round(telemetry.throttleStickPercent)}%</strong>
                        </div>
                        {showStickOverlays || coachMode ? (
                          <>
                            <DraggableStickOverlay
                              member="left"
                              pairLayout={stickOverlayPair}
                              label="左摇杆"
                              xLabel="YAW"
                              yLabel="THR"
                              x={telemetry.yawStickPercent}
                              y={telemetry.throttleStickPercent * 2 - 100}
                              tone="orange"
                              mode={stickOverlayMode}
                              opacity={stickOverlayOpacity}
                              trail={leftStickTrail}
                              peak={stickMotion.leftPeak}
                              onPairChange={updateStickOverlayPair}
                              onInteractionStart={() => setOverlayLayoutNotice(null)}
                              onInteractionCommit={(pair) => setOverlayLayoutNotice(pair.docked ? "摇杆已吸附 · 布局已保存" : "布局已保存")}
                              onToggleLock={toggleStickOverlayPairLock}
                            />
                            <DraggableStickOverlay
                              member="right"
                              pairLayout={stickOverlayPair}
                              label="右摇杆"
                              xLabel="ROLL"
                              yLabel="PITCH"
                              x={telemetry.rollStickPercent}
                              y={telemetry.pitchStickPercent}
                              tone="blue"
                              mode={stickOverlayMode}
                              opacity={stickOverlayOpacity}
                              trail={rightStickTrail}
                              peak={stickMotion.rightPeak}
                              onPairChange={updateStickOverlayPair}
                              onInteractionStart={() => setOverlayLayoutNotice(null)}
                              onInteractionCommit={(pair) => setOverlayLayoutNotice(pair.docked ? "摇杆已吸附 · 布局已保存" : "布局已保存")}
                              onToggleLock={toggleStickOverlayPairLock}
                            />
                          </>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="video-footer">
            <span><SignalMark active={anyVideoLive} />{anyVideoLive ? `${liveVideoSourceCount}/${videoWorkspace.sources.length} 路 UVC 在线` : "未接入采集卡"}</span>
            <span>画面与遥测在浏览器本地处理 · 原始 HDMI 不上传</span>
            <span className="timecode">TC {timecode}</span>
          </div>
        </section>

      </div>

      <details className="telemetry-disclosure" onToggle={(event) => setTelemetryDetailsOpen(event.currentTarget.open)}>
        <summary><span>遥控详细数据</span><small>摇杆数值、油门曲线与连接诊断</small></summary>
        {telemetryDetailsOpen ? <div className="telemetry-detail-content">
          {withMeasurementProfiler("telemetry-display", <aside className="telemetry-rail">
            <div className="rail-heading">
              <div><span>CONTROL INPUT</span><h2>遥控输入</h2></div>
              <span className={`source-badge source-badge--${source}`}>{rcSourceLabel}</span>
            </div>

            <div className="stick-grid">
              <StickPlot eyebrow={`左摇杆 · ${rcSourceLabel}`} xLabel="YAW" yLabel="THR" x={telemetry.yawStickPercent} y={telemetry.throttleStickPercent * 2 - 100} tone="orange" />
              <StickPlot eyebrow={`右摇杆 · ${rcSourceLabel}`} xLabel="ROLL" yLabel="PITCH" x={telemetry.rollStickPercent} y={telemetry.pitchStickPercent} tone="blue" />
            </div>
            <p className="stick-scale-note">行程 ±1000 · 油门中心 0 = 50%</p>

            <div className="gauge-grid gauge-grid--primary">
              <Gauge label="遥控油门指令" value={telemetry.throttleStickPercent} detail={`${Math.round(telemetry.rcThrottleUs)} μs · ${rcSourceLabel}${source === "serial" ? " / MSP_RC" : ""}`} accent="orange" />
            </div>

            <details className="telemetry-details">
              <summary>采集桥诊断</summary>
              <section className="bridge-card">
                <div className="card-heading"><span>GROUND BRIDGE</span><b>{!bridgeIsLive
                  ? "MSP WAIT"
                  : linkState === "ok"
                    ? "RX OK"
                    : linkState === "lost"
                      ? "RX LOST"
                      : "RX UNKNOWN"}</b></div>
                <div className="bridge-path">
                  <div className={groundRxReady ? "is-active" : ""}><i />ELRS RX</div>
                  <span>→</span>
                  <div className={bridgeIsLive ? "is-active" : ""}><i />BETAFLIGHT</div>
                  <span>→</span>
                  <div className={bridgeIsLive ? "is-active" : ""}><i />DASHBOARD</div>
                </div>
                <p>地面桥电压：{telemetry.groundBridgeVoltage === null ? "—" : `${telemetry.groundBridgeVoltage.toFixed(1)} V`}{source === "demo" ? "（演示值）" : ""}。</p>
                <p>只读 MSP_RC + MSP_ANALOG + MSP_STATUS_EX；MSP_ANALOG 仅用于地面桥供电诊断，不代表飞行器。</p>
                <p>遥控链路：{linkStateCopy[linkState]}。Bridge FC 在线不等于遥控器在线。</p>
                <p>
                  解析质量：{parserQualityCopy[telemetryControl.parserQuality]} · 有效帧 {telemetryControl.parserStats.checksumValidFrames.toLocaleString()}
                  {" · "}校验错误 {telemetryControl.parserStats.checksumErrors.toLocaleString()}
                  {" · "}协议错误 {telemetryControl.parserStats.protocolErrors.toLocaleString()}
                </p>
              </section>
              <section className="link-card">
                <div>
                  <span className="metric-label">AIRCRAFT TELEMETRY</span>
                  <strong>未接入</strong>
                </div>
                <SignalMark active={false} />
                <p>真实机上 LQ、电池和姿态尚未接入。</p>
              </section>
            </details>
          </aside>)}
          <section className="timeline-card">
            <div className="timeline-heading">
              <div><span>LIVE TRACE · 3 S</span><h2>油门时间轴</h2></div>
              <div className="legend"><span><i className="legend-rc" />遥控油门指令 · {rcSourceLabel}</span><b>{Math.round(telemetry.throttleStickPercent)}%</b></div>
            </div>
            {withMeasurementProfiler("throttle-timeline", <ThrottleTimeline samples={throttleHistory} active={workspaceView === "live"} />)}
          </section>
        </div> : null}
      </details>

      {withMeasurementProfiler("recording-ui", <section className={`session-card ${trainingSession.isRecording ? "session-card--recording" : ""}`}>
        <div className="session-heading">
          <div>
            <span>LOCAL SESSION RECORDER</span>
            <h2>{trainingSession.isRecording ? `正在记录 ${normalizeAthleteCode(athleteCode)}` : trainingSession.isFinishing ? "正在保存遥控数据" : trainingSession.pendingTerminationSessionId ? "遥控数据已保存，终止状态待重试" : trainingSession.hasPendingSave ? "遥控数据待重试保存" : trainingSession.lastSession ? "遥控数据已保存到本机" : "等待开始训练记录"}</h2>
          </div>
          <span className={`session-state ${trainingSession.isRecording ? "session-state--recording" : sessionIsFinalizing ? "" : trainingSession.lastSession?.validity.valid ? "session-state--valid" : trainingSession.lastSession ? "session-state--invalid" : ""}`}>
            <i />{trainingSession.isRecording ? "REC" : sessionIsFinalizing ? "SAVING" : trainingSession.lastSession?.validity.valid ? "VALID" : trainingSession.lastSession ? "INVALID" : "IDLE"}
          </span>
        </div>

        <div className="session-identity">
          <div>
            <b>{startRequirement}</b>
            <small>{trainingSession.storageReady
              ? `本机存储已就绪 · ${trainingSession.recentSessionCount} 条可读记录${quarantinedRecordCount > 0 ? ` · 隔离 ${quarantinedRecordCount} 条` : ""}`
              : "正在检查草稿与历史记录"}</small>
          </div>
          <details className="recording-options arm-recording-settings"><summary>保存与录像设置 <small>{recordPilotVideo ? "视频＋摇杆" : "遥测 JSON"}{autoExport || recordPilotVideo ? " · 自动导出" : " · 手动导出"}</small></summary>
          <div className="session-toggle-group">
            <label className="session-toggle">
              <input
                type="checkbox"
                checked={autoExport || recordPilotVideo}
                disabled={controlsLocked || recordPilotVideo}
                onChange={(event) => updateTrainingPreferences({
                  autoExport: event.target.checked,
                  recordPilotVideo,
                  showStickOverlays,
                  stickOverlayMode,
                })}
              />
              <span>{recordPilotVideo ? "随录像保存原始打杆 JSON" : "结束后自动保存 JSON"}</span>
            </label>
          </div>
          <div className="session-export-directory">
            <span>
              <b>Session / 视频本地保存文件夹</b>
              <small>{exportDirectoryCopy}</small>
              {trainingSession.exportDirectoryName
                ? <small>已有文件会保留；重复导出自动生成 -v2、-v3，训练记录中的导出也使用此文件夹。</small>
                : null}
            </span>
            <span className="session-export-directory-actions">
              {trainingSession.exportDirectoryName && (
                trainingSession.exportDirectoryState === "permission_required"
                || trainingSession.exportDirectoryState === "error"
              ) ? (
                <button
                  className="button session-directory-button"
                  type="button"
                  disabled={controlsLocked}
                  onClick={() => void trainingSession.reauthorizeExportDirectory()}
                >重新授权</button>
              ) : null}
              <button
                className="button session-directory-button"
                type="button"
                disabled={controlsLocked || trainingSession.exportDirectoryState === "loading" || trainingSession.exportDirectoryState === "unsupported"}
                onClick={() => void trainingSession.configureExportDirectory()}
              >{trainingSession.exportDirectoryName ? "更换文件夹" : "选择文件夹"}</button>
              {trainingSession.exportDirectoryName ? (
                <button
                  className="button session-directory-button"
                  type="button"
                  disabled={controlsLocked}
                  onClick={() => void trainingSession.clearExportDirectory()}
                >清除</button>
              ) : null}
            </span>
          </div>
          <ArmAutoRecordSettings
            automatic={automatic}
            detailsRef={armSettingsRef}
            channels={telemetry.rcChannelsUs}
            signalReady={groundRxReady}
            locked={controlsLocked}
            blockReason={!recordPilotVideo ? "请先选择“视频＋打杆 OSD＋数据”" : !canStartDashboardRecording ? startRequirement : null}
          />
          </details>
          <div
            className={`session-video-status session-video-status--${localVideoRecording.state}`}
            role="status"
            data-testid="local-video-recording-status"
          >
            <span>
              <b>LOCAL PILOT VIDEO · {localVideoFormatLabel}</b>
              <small>{localVideoStatusCopy}</small>
            </span>
            <strong>{localVideoRecording.state === "recording"
              ? `● REC ${formatSessionDuration(localVideoRecording.elapsedMs)}`
              : localVideoRecording.state === "stopping"
                ? "FINALIZING"
                : localVideoRecording.state === "saved"
                  ? "SAVED"
                  : localVideoRecording.state === "error"
                    ? "VIDEO ERROR"
                    : localVideoRecording.state === "starting"
                      ? "准备录像…"
                      : recordPilotVideo
                        ? canStartDashboardRecording ? "已就绪" : "待准备"
                        : "OFF"}</strong>
          </div>
        </div>

        <TrainingStorageIntegrityNotice integrity={trainingSession.storageIntegrity} />

        <div className="session-stats">
          <span>独立样本<b>{trainingSession.uniqueSampleCount.toLocaleString()}</b></span>
          <span>持续时间<b>{formatSessionDuration(trainingSession.elapsedMs)}</b></span>
          <span>估算采样率<b>{sessionRate === null ? "—" : `${sessionRate.toFixed(1)} Hz`}</b></span>
          <span>数据来源<b>{sessionSources}</b></span>
        </div>

        {trainingSession.isRecording ? (
          <div className={`session-progress ${progress.thresholdReached ? "session-progress--ready" : ""}`} role="status">
            <b>{progress.thresholdReached ? "有效门槛已达到" : "有效门槛进度"}</b>
            <span>{progress.thresholdReached
              ? "停止后仍会校验真实来源、严格单调、代号与中断状态"
              : `距离 60 秒还差 ${Math.ceil(progress.remainingDurationMs / 1_000)} 秒 · 距离 300 个独立样本还差 ${progress.remainingUniqueSamples} 个`}</span>
          </div>
        ) : null}

        <div className="marker-panel">
          <div className="marker-kind-list" aria-label="人工标记标签">
            {markerKinds.map((kind) => (
              <button
                key={kind}
                className={selectedMarkerKind === kind ? "is-selected" : ""}
                type="button"
                aria-pressed={selectedMarkerKind === kind}
                onClick={() => setSelectedMarkerKind(kind)}
              >{TRAINING_MARKER_LABELS[kind]}</button>
            ))}
          </div>
          <button
            className="marker-button"
            type="button"
            disabled={!trainingSession.isRecording}
            onClick={() => void trainingSession.addMarker(selectedMarkerKind)}
          >
            <span>{singleKeyShortcutsEnabled ? "MARK / M" : "MARK"}</span>
            <b>{TRAINING_MARKER_LABELS[selectedMarkerKind]}</b>
          </button>
          <p>已记 {trainingSession.markerCount} 条 · 人工定位 DVR，不是自动计圈或正式计时</p>
        </div>

        <div className="session-note">
          <div>
            {trainingSession.isRecording || sessionIsFinalizing ? <p role="status">已采集 {trainingSession.sampleCount.toLocaleString()} 帧 · 已保存 {trainingSession.persistedSampleCount.toLocaleString()} 帧（至 {formatSessionDuration(trainingSession.persistedElapsedMs)}）</p> : null}
            <p>切换页面会继续录制；结束前请保持浏览器打开。{recordPilotVideo ? "录像和原始打杆数据保存在同一文件夹。" : ""}</p>
            <p>记录会自动暂存，结束后保存在本机。若页面意外关闭，下次打开可恢复最近暂存的记录，并标记为中断。</p>
            {lastSessionValidity && !trainingSession.isRecording && !sessionIsFinalizing ? (
              <>
                <p className={trainingSession.lastSession?.validity.valid ? "validity-copy validity-copy--valid" : "validity-copy validity-copy--invalid"}>{lastSessionValidity}</p>
                <p className={lastSessionAttemptCandidate?.candidate ? "validity-copy validity-copy--valid" : "validity-copy validity-copy--invalid"}>
                  {lastSessionAttemptCandidate?.candidate
                    ? "80% 验收候选：技术有效且已有非空复盘备注；仍需外部台账确认"
                    : "尚不是 80% 验收候选：需同时满足技术有效并保存非空复盘备注"}
                </p>
              </>
            ) : null}
          </div>
          {!trainingSession.isRecording && trainingSession.lastSession ? <p role="status">{sessionMediaStatusText(trainingSession.lastSession, trainingSession.mediaPhase === "finishing")}</p> : null}
          {trainingSession.mediaAssociationError ? <div role="status"><p>{trainingSession.mediaAssociationError}</p><button className="button button--export" type="button" onClick={() => void trainingSession.retryMediaAssociation()}>重试关联视频收据</button></div> : null}
          {!trainingSession.hasPendingSave && trainingSession.storageError && trainingSession.storageReady ? <button className="button button--export" type="button" onClick={() => void trainingSession.retryPendingSave()}>重试刷新记录</button> : null}
          {trainingSession.hasPendingSave && !trainingSession.isFinishing ? (
            <button className="button button--export" type="button" onClick={() => void trainingSession.retryPendingSave()}>{trainingSession.pendingTerminationSessionId ? "重试保存终止状态" : "重试保存 Session"}</button>
          ) : null}
        </div>
      </section>)}

      </div>

      </div>

      <div className="workspace-view workspace-view--experiments" hidden={workspaceView !== "experiments"}>
        <div className="experiment-heading">
          <p>离开此页会停止识别，视频和打杆录制继续。已有门档案与计时记录保留。</p>
          <button className="button button--quiet" type="button" onClick={() => navigateWorkspace("live")}><Icon name="arrow-left" size={16} />回到工作台</button>
        </div>
        {experimentsOpened ? (
          <LiveGatePanel
            active={workspaceView === "experiments"}
            stream={activeSource ? videoCapture.getSourceStream(activeSource.id) : null}
            sourceId={activeSource?.id ?? null}
            sourceLabel={activeSource ? videoSourceDisplayName(videoWorkspace.sources, activeSource) : "当前视频输入"}
            pilotChannelId={activeChannel?.id ?? null}
            pilotName={athleteCode}
            crop={liveVisionCrop}
            profileId={activeChannel?.gateProfileId ?? null}
            trainingSessionId={trainingSession.isRecording ? trainingSession.sessionId : null}
            configurationLocked={controlsLocked}
            startBlockReason={tabStartBlockReason}
            onProfileChange={setPilotGateProfile}
          />
        ) : null}
      </div>

      <div className="workspace-view workspace-view--records" hidden={workspaceView !== "records"}>
        <TrainingStorageIntegrityNotice integrity={trainingSession.storageIntegrity} />
        <SessionLibrary
          sessions={librarySessions}
          loadSession={trainingSession.loadSession}
          selectedSessionId={selectedSessionId}
          revealSessionId={revealSessionId}
          onSelectSession={setSelectedSessionId}
          onExport={(session) => trainingSession.exportSession(session.id, session.notes ?? "")}
          onUpdateNotes={trainingSession.updateSessionNotes}
          onGoToLive={() => navigateWorkspace("live")}
          isRecording={trainingSession.isRecording}
          storageState={!trainingSession.storageReady ? trainingSession.storageError ? "error" : "loading" : trainingSession.hasPendingSave && trainingSession.storageError ? "error" : "ready"}
          saveState={trainingSession.isFinishing ? "saving" : trainingSession.hasPendingSave ? "error" : "saved"}
          pendingMediaSessionId={trainingSession.hasPendingMedia ? trainingSession.lastSession?.id : undefined}
          pendingTerminationSessionId={trainingSession.pendingTerminationSessionId ?? undefined}
          unsavedSessionIds={trainingSession.hasPendingSave && trainingSession.lastSession && trainingSession.rcConfirmedSessionId !== trainingSession.lastSession.id ? [trainingSession.lastSession.id] : []}
        />
        <SessionReportLoader loadSessions={trainingSession.loadSessionsForReport} revision={trainingSession.allSessions} />
        <details className="review-tool"><summary>检查导出文件 <small>重新校验 JSON 的完整性与有效条件</small></summary><TrainingSessionFileValidator /></details>
      </div>
      <div className="workspace-view workspace-view--settings" hidden={workspaceView !== "settings"}>
        <section className="experimental-entry" aria-label="实验功能">
          <div><h2>实验功能</h2><p>尝试过门识别或分析已有录像，结果需要人工复核。</p></div>
          <div className="experimental-entry-actions">
            <a className="button button--quiet" href="/vision-lab" target="_blank" rel="noopener noreferrer">录像视觉实验台<Icon name="arrow-right" size={15} /></a>
            <button className="button button--quiet" type="button" onClick={() => navigateWorkspace("experiments")}>实时过门实验<Icon name="arrow-right" size={15} /></button>
          </div>
        </section>
        <section className="connection-guide">
          <div><span>GET READY</span><h2>三步，准备好下一次训练</h2><p>真实训练需要地面接收机、桥接飞控与浏览器串口连接。视频可独立接入。</p></div>
          <ol><li><b>连接输入</b><p>遥控器 → 地面接收机 → Betaflight 桥接飞控 → USB。点击上方「连接桥接飞控」，等待 RX 正常。</p></li><li><b>选择画面与选手</b><p>在工作台展开「输入与选手设置」，连接采集卡；单画面、四分屏与每位选手的独立裁切都保留在本机。</p></li><li><b>开始与复盘</b><p>填写选手代号后开始。训练中可标记片段，结束后保存备注并导出 JSON；开启视频录制前先选择保存文件夹。</p></li></ol>
          <button className="button button--primary" type="button" onClick={() => navigateWorkspace("live")}>回到工作台 <Icon name="arrow-right" size={16} /></button>
        </section>
      <WorkstationShortcutToggle
        enabled={singleKeyShortcutsEnabled}
        onChange={updateSingleKeyShortcuts}
      />
      <section className="diagnostics-card" aria-label="本机诊断工具">
        <div>
          <span>LOCAL DIAGNOSTICS</span>
          <h2>本机诊断 · 不自动上传</h2>
          <p>诊断 JSON 只含构建号、浏览器能力和最近 200 次枚举状态变化；不含画面、选手代号、备注、设备名称或原始 RC 样本。</p>
        </div>
        <div className="diagnostics-actions">
          <button
            className="mini-button mini-button--active"
            type="button"
            onClick={() => {
              const bundle = buildLocalDiagnosticBundle({
                build: PUBLIC_APP_BUILD,
                environment: localDiagnosticEnvironment(),
                transitions: diagnosticTransitionsRef.current,
              });
              downloadLocalDiagnosticBundle(bundle);
              setDiagnosticNotice("诊断 JSON 已交给浏览器下载；应用不会上传该文件。");
            }}
          >下载诊断 JSON</button>

          {telemetryControl.rawCapture.state === "idle" ? (
            <button
              className="mini-button"
              type="button"
              disabled={!bridgeIsLive}
              onClick={() => {
                setDiagnosticNotice(null);
                const started = telemetryControl.startRawCapture();
                if (!started) setDiagnosticNotice("请先连接桥接飞控并等待真实 MSP_RC 在线。");
              }}
            >录制 60 秒原始串口夹具</button>
          ) : telemetryControl.rawCapture.state === "capturing" ? (
            <button className="mini-button" type="button" onClick={telemetryControl.cancelRawCapture}>
              取消原始夹具 · {Math.ceil(telemetryControl.rawCapture.remainingMs / 1_000)} 秒 · {telemetryControl.rawCapture.byteLength} B
            </button>
          ) : (
            <>
              <button
                className="mini-button mini-button--active"
                type="button"
                disabled={telemetryControl.rawCapture.byteLength === 0}
                onClick={() => {
                  const downloaded = telemetryControl.downloadRawCapture();
                  setDiagnosticNotice(downloaded
                    ? "原始 .bin 已交给浏览器下载；文件只保留在本机。"
                    : "没有可下载的原始串口字节。");
                }}
              >下载原始 .bin · {telemetryControl.rawCapture.byteLength} B</button>
              <button
                className="mini-button"
                type="button"
                onClick={() => {
                  telemetryControl.cancelRawCapture();
                  setDiagnosticNotice(null);
                }}
              >清除内存夹具</button>
            </>
          )}
        </div>
        <small>原始 .bin 可能包含完整 MSP 响应，只在你主动点击后采集；它不进入诊断 JSON、Session 或统计事件。</small>
        {telemetryControl.rawCapture.state === "capturing" ? (
          <small role="status">正在本机内存录制原始串口字节；断线或达到 8 MiB 会提前结束。</small>
        ) : telemetryControl.rawCapture.state === "ready" && telemetryControl.rawCapture.stopReason ? (
          <small role="status">{rawCaptureStopCopy[telemetryControl.rawCapture.stopReason]}</small>
        ) : null}
        {diagnosticNotice ? <small role="status">{diagnosticNotice}</small> : null}
      </section>

      <section className="analytics-card" aria-label="本机统计设置">
        <div>
          <span>PRIVACY-FIRST ANALYTICS</span>
          <h2>本机统计 · {analyticsStatusLabel}</h2>
          <p>{analyticsStatusCopy}</p>
        </div>
        {analytics.status.state === "waiting_token" ? (
          <div className="analytics-provisioning">
            <AnalyticsWorkstationId workstationId={analytics.status.workstationId} />
            <form
              className="analytics-install-form"
              onSubmit={(event) => {
                event.preventDefault();
                const installed = analytics.installToken(analyticsTokenDraft.trim());
                setAnalyticsTokenDraft("");
                setAnalyticsInstallMessage(installed ? "工作站令牌已安装，统计已开启。" : "令牌格式无效或本机仍处于关闭状态。");
              }}
            >
              <label htmlFor="analytics-workstation-token">
                {analytics.status.reason === "missing_token" ? "一次性安装工作站令牌" : "替换工作站令牌"}
              </label>
              <div>
                <input
                  id="analytics-workstation-token"
                  type="password"
                  value={analyticsTokenDraft}
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder="由俱乐部管理员粘贴"
                  onChange={(event) => setAnalyticsTokenDraft(event.target.value)}
                />
                <button className="mini-button mini-button--active" type="submit" disabled={!analyticsTokenDraft.trim()}>安装并开启</button>
              </div>
            </form>
          </div>
        ) : null}
        {analytics.status.reason === "opted_out" ? (
          <button
            className="mini-button"
            type="button"
            onClick={() => {
              const prepared = analytics.prepareReactivation();
              setAnalyticsInstallMessage(prepared ? "已允许重新安装；仍需输入新的工作站令牌。" : "当前发布不可重新开启统计。");
            }}
          >明确重新启用统计</button>
        ) : null}
        {analytics.status.state === "enabled" ? (
          <div className="analytics-enabled-actions">
            <AnalyticsTokenReplacementAction
              onReplace={() => {
                const result = prepareAnalyticsTokenReplacementAction(analytics);
                setAnalyticsTokenDraft("");
                setAnalyticsInstallMessage(result.message);
              }}
            />
            <button
              className="mini-button"
              type="button"
              onClick={() => {
                analytics.optOut();
                setAnalyticsTokenDraft("");
                setAnalyticsInstallMessage("已关闭并清除本机统计数据。");
              }}
            >关闭并清除本机统计数据</button>
          </div>
        ) : null}
        {analyticsInstallMessage ? <small role="status">{analyticsInstallMessage}</small> : null}
      </section>

      </div>

      <footer className="dashboard-footer">
        <p><i className={`footer-light footer-light--${connection}`} />{source === "demo" ? "当前为演示数据，未连接真实飞控" : bridgeIsLive ? "只读 MSP 轮询，不写入 Betaflight 配置" : "桥接飞控当前没有实时 RC 数据"}</p>
        <p>地面桥电压仅用于采集桥诊断，不代表飞行器电池</p>
        <p>FPVHelper v{version.currentVersion}</p>
      </footer>
    </main>
    </div>
  );
}
