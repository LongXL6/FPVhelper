"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  DraggableStickOverlay,
  storeStickOverlayLayout,
} from "@/components/draggable-stick-overlay";
import { DemoTelemetryWatermark } from "@/components/demo-telemetry-watermark";
import { OnboardingChecklist } from "@/components/onboarding-checklist";
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
import { TrainingWeeklyReport } from "@/components/training-weekly-report";
import { useBetaflightTelemetry } from "@/hooks/use-betaflight-telemetry";
import { useAnalyticsLifecycle, type AnalyticsErrorSurface } from "@/hooks/use-analytics-lifecycle";
import { useTrainingSession } from "@/hooks/use-training-session";
import { useVideoCapture } from "@/hooks/use-video-capture";
import { useVersionCheck } from "@/hooks/use-version-check";
import { useWorkstationRuntime } from "@/hooks/use-workstation-runtime";
import { PUBLIC_APP_BUILD } from "@/lib/app-version";
import {
  appendDiagnosticTransition,
  buildLocalDiagnosticBundle,
  downloadLocalDiagnosticBundle,
  type LocalDiagnosticTransition,
} from "@/lib/local-diagnostics";
import { clamp } from "@/lib/telemetry";
import {
  DEFAULT_TRAINING_SESSION_PREFERENCES,
  loadTrainingSessionPreferences,
  saveTrainingSessionPreferences,
  TRAINING_SESSION_PREFERENCES_KEY,
  type TrainingSessionPreferences,
} from "@/lib/training-session-preferences";
import {
  formatDvrReviewChecklist,
  TRAINING_MARKER_LABELS,
  trainingSessionProgress,
} from "@/lib/training-session-summary";
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

const statusCopy = {
  demo: "演示数据",
  connecting: "正在连接",
  live: "数据桥在线",
  stale: "数据已停滞",
  error: "需要检查",
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

function formatSigned(value: number) {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function formatSessionDuration(durationMs: number) {
  const totalSeconds = Math.max(0, durationMs) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(1).padStart(4, "0");
  return `${String(minutes).padStart(2, "0")}:${seconds}`;
}

function formatLocalTimecode(timestamp: number) {
  if (!timestamp) return "--:--:--.---";
  const date = new Date(timestamp);
  const pad = (value: number, length = 2) => value.toString().padStart(length, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function formatSessionStart(wallClockStartedAt: string) {
  return `${wallClockStartedAt.slice(0, 10)} ${wallClockStartedAt.slice(11, 19)}`;
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

function overlayLayoutsWereDefault(entries: Array<{ storageKey: string; defaultLayout: { xPercent: number; yPercent: number; size: number } }>) {
  try {
    return entries.every(({ storageKey, defaultLayout }) => {
      const stored = window.localStorage.getItem(storageKey);
      return stored === null || stored === JSON.stringify(defaultLayout);
    });
  } catch {
    return false;
  }
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
        <b>{formatSigned(x)}</b>
      </div>
      <div className="stick-field" aria-label={`${eyebrow}，${xLabel} ${Math.round(x)}，${yLabel} ${Math.round(y)}`}>
        <span className="axis axis-x" />
        <span className="axis axis-y" />
        <span className="stick-trace" style={{ left, top }} />
        <span className="stick-dot" style={{ left, top }} />
        <small className="axis-label axis-label-x">{xLabel}</small>
        <small className="axis-label axis-label-y">{yLabel}</small>
      </div>
      <div className="stick-values">
        <span><i />{xLabel}<b>{Math.round(x)}</b></span>
        <span><i />{yLabel}<b>{Math.round(y)}</b></span>
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

function ThrottleTimeline({ samples }: { samples: number[] }) {
  const points = useMemo(() => {
    if (samples.length < 2) return "0,80 640,80";
    return samples
      .map((value, index) => `${(index / (samples.length - 1)) * 640},${96 - clamp(value, 0, 100) * 0.84}`)
      .join(" ");
  }, [samples]);

  return (
    <div className="timeline-plot" aria-label="最近三秒的油门曲线">
      <svg viewBox="0 0 640 104" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1="24" x2="640" y2="24" />
        <line x1="0" y1="60" x2="640" y2="60" />
        <line x1="0" y1="96" x2="640" y2="96" />
        <polyline points={points} />
      </svg>
      <div className="timeline-labels"><span>-3.0 s</span><span>现在</span></div>
    </div>
  );
}

export function FlightDashboard() {
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
  const { autoExport, showStickOverlays, stickOverlayMode } = loadedPreferences.preferences;
  const [preferenceWriteError, setPreferenceWriteError] = useState<string | null>(null);
  const [coachMode, setCoachMode] = useState(false);
  const [selectedMarkerKind, setSelectedMarkerKind] = useState<Exclude<TrainingSessionMarkerKind, "manual">>("clean");
  const [athleteCode, setAthleteCode] = useState("");
  const [notesDraft, setNotesDraft] = useState("");
  const [notesDraftSessionId, setNotesDraftSessionId] = useState<string | null>(null);
  const [notesSaving, setNotesSaving] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [analyticsTokenDraft, setAnalyticsTokenDraft] = useState("");
  const [analyticsInstallMessage, setAnalyticsInstallMessage] = useState<string | null>(null);
  const [diagnosticNotice, setDiagnosticNotice] = useState<string | null>(null);
  const [workstationNotice, setWorkstationNotice] = useState<string | null>(null);
  const exportShortcutInFlightRef = useRef(false);
  const diagnosticTransitionsRef = useRef<LocalDiagnosticTransition[]>([]);
  const telemetryControl = useBetaflightTelemetry();
  const {
    videoRef,
    devices: videoDevices,
    selectedDeviceId,
    captureSettings,
    state: videoState,
    error: videoError,
    errorCode: videoErrorCode,
    setSelectedDeviceId,
    connect: connectVideo,
    disconnect: disconnectVideo,
  } = useVideoCapture();
  const { telemetry, throttleHistory, stickMotion, connection, source, error, linkState } = telemetryControl;
  const version = useVersionCheck();
  const trainingSession = useTrainingSession({ telemetry, source, connection, linkState, athleteCode, autoExport });
  const workstation = useWorkstationRuntime({ keepAwake: trainingSession.isRecording });
  const visibleSessionNotes = notesDraftSessionId === trainingSession.lastSession?.id
    ? notesDraft
    : trainingSession.lastSession?.notes ?? "";

  useEffect(() => {
    if (!workstationNotice) return;
    const timer = window.setTimeout(() => setWorkstationNotice(null), WORKSTATION_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [workstationNotice]);

  const updateTrainingPreferences = useCallback((preferences: TrainingSessionPreferences) => {
    try {
      const saveError = saveTrainingSessionPreferences(window.localStorage, preferences);
      setPreferenceWriteError(saveError);
      if (!saveError) window.dispatchEvent(new Event(TRAINING_PREFERENCES_EVENT));
      return saveError === null;
    } catch (saveError) {
      setPreferenceWriteError(saveError instanceof Error ? saveError.message : "无法保存本机界面偏好");
      return false;
    }
  }, []);

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
  const preferenceError = preferenceWriteError || loadedPreferences.error;
  const controlsLocked = trainingSession.isRecording || trainingSession.isStarting || trainingSession.isFinishing;
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
  const bridgeSourceLabel = source === "demo" ? "DEMO" : "GROUND_BRIDGE";
  const timecode = formatLocalTimecode(telemetry.timestamp);
  const sessionRate = trainingSession.isRecording
    ? trainingSession.sampleCount > 1 && trainingSession.elapsedMs > 0
      ? (trainingSession.sampleCount - 1) / (trainingSession.elapsedMs / 1000)
      : null
    : trainingSession.lastSession?.estimatedRcSampleRateHz ?? null;
  const sessionSources = trainingSession.isRecording
    ? rcSourceLabel
    : trainingSession.lastSession?.dataSources.map((dataSource) => dataSource === "ground_rc" ? "GROUND_RC" : "DEMO").join(" + ") ?? "—";
  const visibleSessionId = trainingSession.sessionId?.slice(0, 8).toUpperCase() ?? "READY";
  const quarantinedRecordCount = quarantinedTrainingRecordCount(trainingSession.storageIntegrity);
  const startRequirement = tabStartBlockReason
    ? tabStartBlockReason
    : !trainingSession.storageReady
      ? "正在准备浏览器本地存储"
      : trainingSession.storageError
        ? "本地存储异常，暂不能开始"
        : !normalizeAthleteCode(athleteCode)
          ? "先填写选手代号"
          : !bridgeIsLive
            ? "连接桥接飞控并等待 MSP_RC 数据在线"
            : linkState === "lost"
              ? "遥控链路已丢失，不能开始记录"
              : linkState === "unknown"
                ? "等待 MSP_STATUS_EX 确认遥控链路"
                : "已满足开始条件";
  const exportDirectoryCopy = trainingSession.exportDirectoryState === "ready"
    ? `自动保存目录：${trainingSession.exportDirectoryName}`
    : trainingSession.exportDirectoryState === "permission_required"
      ? `需要重新授权：${trainingSession.exportDirectoryName ?? "已保存的目录"}`
      : trainingSession.exportDirectoryState === "unsupported"
        ? "当前浏览器不支持目录自动保存，将退回普通下载"
        : trainingSession.exportDirectoryState === "loading"
          ? "正在检查自动保存目录"
          : trainingSession.exportDirectoryState === "error"
            ? trainingSession.exportDirectoryName
              ? "目录访问失败，可重新授权或更换文件夹"
              : "目录设置读取失败，可重新选择"
            : "尚未选择自动保存目录，将退回普通下载";
  const lastSessionValidity = trainingSession.lastSession
    ? trainingSession.lastSession.validity.valid
      ? "技术有效：真实 GROUND_RC、≥60 秒、≥300 个不重复样本、时间戳严格单调且已关联代号"
      : `技术无效：${trainingSession.lastSession.validity.reasons.map((reason) => invalidReasonCopy[reason]).join("；")}`
    : null;
  const lastSessionAttemptCandidate = trainingSession.lastSession
    ? assessTrainingAttemptCandidate(trainingSession.lastSession)
    : null;
  const progress = trainingSessionProgress(trainingSession.elapsedMs, trainingSession.uniqueSampleCount);
  const dvrChecklist = trainingSession.lastSession ? formatDvrReviewChecklist(trainingSession.lastSession) : "";
  const visibleError = trainingSession.storageError || preferenceError || error || videoError;
  const analyticsErrorSurface = useMemo<AnalyticsErrorSurface | null>(() => {
    if (trainingSession.storageError || preferenceError) {
      return { kind: "storage", message: trainingSession.storageError || preferenceError || "本机存储异常" };
    }
    if (telemetryControl.errorCode) return { kind: "serial", code: telemetryControl.errorCode };
    if (videoErrorCode) return { kind: "video", code: videoErrorCode };
    return null;
  }, [preferenceError, telemetryControl.errorCode, trainingSession.storageError, videoErrorCode]);
  const leftStickTrail = useMemo(() => stickMotion.samples.map((sample) => sample.left), [stickMotion.samples]);
  const rightStickTrail = useMemo(() => stickMotion.samples.map((sample) => sample.right), [stickMotion.samples]);
  const leftStickLayout = coachMode ? COACH_LEFT_STICK_LAYOUT : stickOverlayMode === "trail" ? TRAIL_LEFT_STICK_LAYOUT : SIMPLE_LEFT_STICK_LAYOUT;
  const rightStickLayout = coachMode ? COACH_RIGHT_STICK_LAYOUT : stickOverlayMode === "trail" ? TRAIL_RIGHT_STICK_LAYOUT : SIMPLE_RIGHT_STICK_LAYOUT;
  const overlayLayoutScope = coachMode ? `coach.${stickOverlayMode}` : stickOverlayMode;
  const leftStickStorageKey = `fpvhelper.overlay.${overlayLayoutScope}.left-stick.v1`;
  const rightStickStorageKey = `fpvhelper.overlay.${overlayLayoutScope}.right-stick.v1`;
  const analytics = useAnalyticsLifecycle({
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

  const executeWorkstationShortcut = useEffectEvent((shortcut: ReturnType<typeof classifyWorkstationShortcut>) => {
    if (!shortcut) return;
    if (shortcut === "toggle_fullscreen") {
      void toggleCoachMode();
    } else if (shortcut === "record_hold") {
      const action = workstationRecordHoldAction({
        isRecording: trainingSession.isRecording,
        isStarting: trainingSession.isStarting,
        isFinishing: trainingSession.isFinishing,
        canStart: trainingSession.canStart,
        tabAllowsStart,
      });
      if (action === "stop") {
        setWorkstationNotice("空格长按：正在结束并保存记录");
        void trainingSession.stopRecording();
      } else if (action === "start") {
        setWorkstationNotice("空格长按：正在开始记录");
        void trainingSession.startRecording();
      } else {
        setWorkstationNotice("当前尚未满足开始记录条件");
      }
    } else if (shortcut === "add_marker" && trainingSession.isRecording) {
      void trainingSession.addMarker(selectedMarkerKind);
    } else if (shortcut === "export_latest" && !controlsLocked && trainingSession.lastSession) {
      if (exportShortcutInFlightRef.current) return;
      exportShortcutInFlightRef.current = true;
      void trainingSession.exportSession(trainingSession.lastSession.id)
        .finally(() => {
          exportShortcutInFlightRef.current = false;
        });
    } else if (shortcut === "cancel_connection" && !document.fullscreenElement) {
      if (coachMode) {
        setCoachMode(false);
        setWorkstationNotice("Esc：已退出页面内大屏模式");
      } else if (!controlsLocked && (source === "serial" || connection === "connecting")) {
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
        if (document.fullscreenElement) return;
        executeWorkstationShortcut(shortcut);
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
  return (
    <main className={`dashboard-shell ${coachMode ? "dashboard-shell--coach" : ""}`}>
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div>
            <p>FPV / CONTROL ROOM</p>
            <h1>飞行操控台</h1>
          </div>
        </div>

        <div className="session-strip">
          <span className={`status-chip status-chip--${connection}`}><i />{statusCopy[connection]}</span>
          <span className="session-meta">SESSION <b>{trainingSession.isRecording ? `REC / ${visibleSessionId}` : "LOCAL / READY"}</b></span>
          <span className="session-meta">RATE <b>{source === "demo"
            ? "20 HZ"
            : !bridgeIsLive
              ? "MSP WAIT"
              : linkState === "ok"
                ? "RX OK"
                : linkState === "lost"
                  ? "RX LOST"
                  : "RX UNKNOWN"}</b></span>
        </div>

        <div className="top-actions">
          <OnboardingChecklist />
          <button
            className={`button button--quiet button--coach ${coachMode ? "button--coach-active" : ""}`}
            type="button"
            aria-pressed={coachMode}
            title={singleKeyShortcutsEnabled ? "F 键切换全屏教练大屏；Esc 退出" : "点击切换教练大屏；页面内大屏可按 Esc 退出"}
            onClick={() => void toggleCoachMode()}
          >{coachMode ? "退出大屏" : "教练大屏"}{singleKeyShortcutsEnabled ? " (F)" : ""}</button>
          <button
            className={`button button--record ${trainingSession.isRecording ? "button--recording" : ""}`}
            type="button"
            aria-pressed={trainingSession.isRecording}
            disabled={trainingSession.isRecording ? trainingSession.isFinishing : !trainingSession.canStart || !tabAllowsStart}
            title={trainingSession.isRecording ? "结束并保存当前 Session" : startRequirement}
            onClick={() => void (trainingSession.isRecording ? trainingSession.stopRecording() : trainingSession.startRecording())}
          >
            {trainingSession.isFinishing ? "保存记录…" : trainingSession.isStarting ? "准备记录…" : trainingSession.isRecording ? "■ 结束记录" : "● 开始记录"}
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

      <WorkstationShortcutToggle
        enabled={singleKeyShortcutsEnabled}
        onChange={updateSingleKeyShortcuts}
      />

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
          {trainingSession.hasPendingSave ? (
            <button className="mini-button mini-button--active" type="button" onClick={() => void trainingSession.retryPendingSave()}>重试保存</button>
          ) : null}
        </aside>
      )}

      <TrainingExportNotice
        notice={trainingSession.exportNotice}
        warning={trainingSession.exportWarning}
      />

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

      <div className="workspace-grid">
        <section className="video-console">
          <div className="section-bar">
            <div>
              <span className={`live-dot ${videoState === "live" ? "is-live" : ""}`} />
              <b>HDMI IN / MAIN FEED</b>
              <small>{videoFormatLabel ? `${videoLabel} · ${videoFormatLabel}` : videoLabel}</small>
            </div>
            <div className="video-controls">
              <label>
                <span className="sr-only">视频采集设备</span>
                <select value={selectedDeviceId} onChange={(event) => setSelectedDeviceId(event.target.value)}>
                  {videoDevices.length === 0 ? <option value="">自动选择采集卡</option> : null}
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
                    disconnectVideo();
                  }}
                >断开画面</button>
              ) : (
                <button
                  className="mini-button mini-button--active"
                  disabled={!tabAllowsStart || videoState === "connecting"}
                  title={tabAllowsStart ? "打开视频采集画面" : tabStartBlockReason ?? undefined}
                  onClick={() => {
                    analytics.beginVideoConnect();
                    void connectVideo();
                  }}
                >{videoState === "connecting" ? "正在打开" : "打开画面"}</button>
              )}
              <button
                className={`mini-button ${showStickOverlays ? "mini-button--active" : ""}`}
                type="button"
                aria-pressed={showStickOverlays}
                onClick={() => updateTrainingPreferences({ autoExport, showStickOverlays: !showStickOverlays, stickOverlayMode })}
              >{showStickOverlays ? "叠层开启" : "叠层关闭"}</button>
              {showStickOverlays || coachMode ? (
                <>
                  <button
                    className={`mini-button ${stickOverlayMode === "trail" ? "mini-button--active" : ""}`}
                    type="button"
                    aria-pressed={stickOverlayMode === "trail"}
                    onClick={() => {
                      if (updateTrainingPreferences({ autoExport, showStickOverlays, stickOverlayMode: "trail" })) {
                        analytics.trackOverlayModeChange(stickOverlayMode, "trail");
                      }
                    }}
                  >动态轨迹</button>
                  <button
                    className={`mini-button ${stickOverlayMode === "simple" ? "mini-button--active" : ""}`}
                    type="button"
                    aria-pressed={stickOverlayMode === "simple"}
                    onClick={() => {
                      if (updateTrainingPreferences({ autoExport, showStickOverlays, stickOverlayMode: "simple" })) {
                        analytics.trackOverlayModeChange(stickOverlayMode, "simple");
                      }
                    }}
                  >简洁模式</button>
                  <button
                    className="mini-button"
                    type="button"
                    onClick={() => {
                      const wasDefault = overlayLayoutsWereDefault([
                        { storageKey: leftStickStorageKey, defaultLayout: leftStickLayout },
                        { storageKey: rightStickStorageKey, defaultLayout: rightStickLayout },
                      ]);
                      storeStickOverlayLayout(leftStickStorageKey, leftStickLayout);
                      storeStickOverlayLayout(rightStickStorageKey, rightStickLayout);
                      analytics.trackOverlayLayoutReset(wasDefault);
                    }}
                  >重置叠层</button>
                </>
              ) : null}
            </div>
          </div>

          <div className={`video-stage ${videoState === "live" ? "has-video" : ""}`}>
            <video ref={videoRef} muted playsInline />
            <div className="video-idle">
              <div className="flight-gate" aria-hidden="true"><span /><span /></div>
              <p>选择 HDMI 采集卡后打开画面</p>
              <small>浏览器读取 UVC 视频设备 · 不录制 · 不上传</small>
            </div>

            <DemoTelemetryWatermark source={source} />

            <div className="hud hud-top-left">
              <span>{source === "demo" ? "SIM" : "MSP"}</span>
              <b>{source === "demo" ? "演示遥测" : "桥接飞控"}</b>
            </div>
            <div className="hud hud-top-right">
              <b>{telemetry.groundBridgeVoltage === null ? "—" : telemetry.groundBridgeVoltage.toFixed(1)} V</b>
              <span>{source === "demo" ? "DEMO BRIDGE VOLTAGE" : "GROUND BRIDGE VOLTAGE"}</span>
            </div>
            <div className={`coach-status coach-status--${connection}`}>
              <span><i />{statusCopy[connection]} · {source === "demo" ? "DEMO" : "真实 GROUND_RC"}</span>
              <b>{trainingSession.isRecording ? `● REC ${formatSessionDuration(trainingSession.elapsedMs)}` : "REC 待命"}</b>
              <strong>THR {Math.round(telemetry.throttleStickPercent)}%</strong>
            </div>
            {showStickOverlays || coachMode ? (
              <>
                <DraggableStickOverlay
                  storageKey={leftStickStorageKey}
                  label="左摇杆"
                  xLabel="YAW"
                  yLabel="THR"
                  x={telemetry.yawStickPercent}
                  y={telemetry.throttleStickPercent * 2 - 100}
                  tone="orange"
                  mode={stickOverlayMode}
                  trail={leftStickTrail}
                  peak={stickMotion.leftPeak}
                  defaultLayout={leftStickLayout}
                />
                <DraggableStickOverlay
                  storageKey={rightStickStorageKey}
                  label="右摇杆"
                  xLabel="ROLL"
                  yLabel="PITCH"
                  x={telemetry.rollStickPercent}
                  y={telemetry.pitchStickPercent}
                  tone="blue"
                  mode={stickOverlayMode}
                  trail={rightStickTrail}
                  peak={stickMotion.rightPeak}
                  defaultLayout={rightStickLayout}
                />
              </>
            ) : null}
            <div className="hud hud-bottom-left">
              <span>ROLL STICK <b>{formatSigned(telemetry.rollStickPercent)}</b></span>
              <span>PITCH STICK <b>{formatSigned(telemetry.pitchStickPercent)}</b></span>
              <span>YAW STICK <b>{formatSigned(telemetry.yawStickPercent)}</b></span>
            </div>
            <div className="throttle-ladder">
              <span>THR STICK</span>
              <div><i style={{ height: `${telemetry.throttleStickPercent}%` }} /></div>
              <b>{Math.round(telemetry.throttleStickPercent)}%</b>
            </div>
          </div>

          <div className="video-footer">
            <span><SignalMark active={videoState === "live"} />{videoState === "live" ? "UVC 采集正常" : "未接入采集卡"}</span>
            <span>画面与遥测在浏览器本地合成</span>
            <span className="timecode">TC {timecode}</span>
          </div>
        </section>

        <aside className="telemetry-rail">
          <div className="rail-heading">
            <div><span>CONTROL INPUT</span><h2>遥控输入</h2></div>
            <span className={`source-badge source-badge--${source}`}>{rcSourceLabel}</span>
          </div>

          <div className="stick-grid">
            <StickPlot eyebrow={`左摇杆 · ${rcSourceLabel}`} xLabel="YAW" yLabel="THR" x={telemetry.yawStickPercent} y={telemetry.throttleStickPercent * 2 - 100} tone="orange" />
            <StickPlot eyebrow={`右摇杆 · ${rcSourceLabel}`} xLabel="ROLL" yLabel="PITCH" x={telemetry.rollStickPercent} y={telemetry.pitchStickPercent} tone="blue" />
          </div>

          <div className="gauge-grid gauge-grid--primary">
            <Gauge label="遥控油门指令" value={telemetry.throttleStickPercent} detail={`${Math.round(telemetry.rcThrottleUs)} μs · ${rcSourceLabel}${source === "serial" ? " / MSP_RC" : ""}`} accent="orange" />
          </div>

          <details className="telemetry-details">
            <summary>桥接诊断字段（非机上 LQ）</summary>
            <div className="gauge-grid">
              <Gauge label="地面桥 RSSI 字段" value={telemetry.groundMspRssiPercent} detail={`${bridgeSourceLabel} · MSP legacy RSSI · 明确不是机上 LQ`} />
            </div>
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
              <p>只读 MSP_RC + MSP_ANALOG + MSP_STATUS_EX；电压与 legacy RSSI 只属于地面桥，不代表飞行器。</p>
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
              <p>真实机上 LQ、电池和姿态尚未接入，不从 legacy RSSI 推断。</p>
            </section>
          </details>
        </aside>
      </div>

      <section className="timeline-card">
        <div className="timeline-heading">
          <div><span>LIVE TRACE</span><h2>油门时间轴</h2></div>
          <div className="legend"><span><i className="legend-rc" />遥控油门指令 · {rcSourceLabel}</span><b>{Math.round(telemetry.throttleStickPercent)}%</b></div>
        </div>
        <ThrottleTimeline samples={throttleHistory} />
      </section>

      <section className={`session-card ${trainingSession.isRecording ? "session-card--recording" : ""}`}>
        <div className="session-heading">
          <div>
            <span>LOCAL SESSION RECORDER</span>
            <h2>{trainingSession.isRecording ? `正在记录 ${normalizeAthleteCode(athleteCode)}` : trainingSession.hasPendingSave ? "记录待重试保存" : trainingSession.lastSession ? "最近记录已保存在本机" : "等待开始训练记录"}</h2>
          </div>
          <span className={`session-state ${trainingSession.isRecording ? "session-state--recording" : sessionIsFinalizing ? "" : trainingSession.lastSession?.validity.valid ? "session-state--valid" : trainingSession.lastSession ? "session-state--invalid" : ""}`}>
            <i />{trainingSession.isRecording ? "REC" : sessionIsFinalizing ? "SAVING" : trainingSession.lastSession?.validity.valid ? "VALID" : trainingSession.lastSession ? "INVALID" : "IDLE"}
          </span>
        </div>

        <div className="session-identity">
          <label>
            <span>选手代号</span>
            <input
              type="text"
              value={athleteCode}
              maxLength={40}
              disabled={controlsLocked}
              placeholder="例如 PILOT-07"
              autoComplete="off"
              onChange={(event) => setAthleteCode(event.target.value)}
            />
          </label>
          <div>
            <b>{startRequirement}</b>
            <small>{trainingSession.storageReady
              ? `IndexedDB 已就绪 · 本机 ${trainingSession.recentSessionCount} 条可读记录${quarantinedRecordCount > 0 ? ` · 隔离 ${quarantinedRecordCount} 条` : ""}`
              : "正在检查草稿与历史记录"}</small>
          </div>
          <label className="session-toggle">
            <input
              type="checkbox"
              checked={autoExport}
              onChange={(event) => updateTrainingPreferences({
                autoExport: event.target.checked,
                showStickOverlays,
                stickOverlayMode,
              })}
            />
            <span>结束成功后自动保存 JSON</span>
          </label>
          <div className="session-export-directory">
            <span>
              <b>自动保存文件夹</b>
              <small>{exportDirectoryCopy}</small>
              {trainingSession.exportDirectoryName
                ? <small>再次自动导出同一 Session 会覆盖该文件夹内的同名 JSON。</small>
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
            <p>草稿保存在浏览器 IndexedDB：开始即写、每 5 秒更新、结束即保存；刷新残留草稿会恢复为 interrupted，不会静默丢弃。</p>
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
          {trainingSession.hasPendingSave ? (
            <button className="button button--export" type="button" onClick={() => void trainingSession.retryPendingSave()}>重试保存 Session</button>
          ) : null}
        </div>
      </section>

      {trainingSession.lastSession && !trainingSession.isRecording ? (
        <section className="session-summary-card">
          <div className="session-heading">
            <div><span>POST-FLIGHT REVIEW</span><h2>停止后小结</h2></div>
            <span>{trainingSession.lastSession.markers.length} 条人工标记</span>
          </div>
          <div className="summary-grid">
            <div className="summary-notes">
              <label htmlFor="session-notes">训练备注</label>
              <textarea
                id="session-notes"
                value={visibleSessionNotes}
                maxLength={2_000}
                disabled={trainingSession.hasPendingSave}
                placeholder="记录练习目标、失误与下一轮调整"
                onChange={(event) => {
                  setNotesDraftSessionId(trainingSession.lastSession?.id ?? null);
                  setNotesDraft(event.target.value);
                }}
              />
              <button
                className="mini-button mini-button--active"
                type="button"
                disabled={notesSaving || trainingSession.hasPendingSave}
                onClick={() => {
                  setNotesSaving(true);
                  void trainingSession.updateLastSessionNotes(visibleSessionNotes).finally(() => setNotesSaving(false));
                }}
              >{notesSaving ? "保存中…" : "保存备注到本机"}</button>
            </div>
            <div className="dvr-checklist">
              <label htmlFor="dvr-checklist">可复制 DVR 复盘清单</label>
              <textarea id="dvr-checklist" readOnly value={dvrChecklist} />
              <button
                className="mini-button"
                type="button"
                onClick={() => {
                  void (async () => {
                    try {
                      if (!navigator.clipboard) throw new Error("当前浏览器未提供剪贴板权限");
                      await navigator.clipboard.writeText(dvrChecklist);
                      setCopyStatus("已复制 DVR 清单");
                    } catch {
                      setCopyStatus("复制失败，请在清单中手动全选复制");
                    }
                  })();
                }}
              >复制清单</button>
              {copyStatus ? <small role="status">{copyStatus}</small> : null}
            </div>
          </div>
        </section>
      ) : null}

      <TrainingSessionFileValidator />

      <TrainingWeeklyReport localSessions={trainingSession.allSessions} />

      <section className="today-records-card">
        <div className="session-heading">
          <div><span>LOCAL INDEXEDDB</span><h2>全部历史 Session</h2></div>
          <span>共 {trainingSession.allSessions.length} 条 · 未导出 {trainingSession.unexportedCount} 条（技术有效 {trainingSession.unexportedValidCount} 条）</span>
        </div>
        {trainingSession.allSessions.length === 0 ? (
          <p className="empty-records">本机还没有已完成的训练记录。</p>
        ) : (
          <div className="today-records-list">
            {trainingSession.allSessions.map((session) => {
              const attemptCandidate = assessTrainingAttemptCandidate(session);
              const sessionLabel = `${session.athleteCode ?? "未填写代号"} ${formatSessionStart(session.timing.wallClockStartedAt)}`;
              return (
                <article key={session.id} aria-label={`训练 Session：${sessionLabel}`}>
                  <div><span>代号</span><b>{session.athleteCode ?? "—"}</b></div>
                  <div><span>开始（本地）</span><b>{formatSessionStart(session.timing.wallClockStartedAt)}</b></div>
                  <div><span>时长</span><b>{formatSessionDuration(session.durationMs)}</b></div>
                  <div className={session.validity.valid ? "record-valid" : "record-invalid"}>
                    <span>技术有效</span>
                    <b>{session.validity.valid ? "有效" : session.validity.reasons.map((reason) => invalidReasonCopy[reason]).join("；")}</b>
                  </div>
                  <div className={attemptCandidate.candidate ? "record-valid" : "record-invalid"}>
                    <span>80% 验收候选</span>
                    <b>{attemptCandidate.candidate ? "满足基础条件（仍需外部台账）" : "不满足（需技术有效 + 非空备注）"}</b>
                  </div>
                  <div><span>导出状态</span><b>{session.exportedAt ? `已导出 ${session.exportCount} 次` : "未导出"}</b></div>
                  <button
                    className="mini-button mini-button--active"
                    type="button"
                    aria-label={`${session.exportedAt ? "再次导出" : "导出 JSON"}：${sessionLabel}`}
                    onClick={() => void trainingSession.exportSession(session.id)}
                  >
                    {session.exportedAt ? "再次导出" : "导出 JSON"}
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </section>

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

          {telemetryControl.rawCapture.state === "capturing" ? (
            <button className="mini-button" type="button" onClick={telemetryControl.cancelRawCapture}>
              取消原始夹具 · {Math.ceil(telemetryControl.rawCapture.remainingMs / 1_000)} 秒 · {telemetryControl.rawCapture.byteLength} B
            </button>
          ) : (
            <button
              className="mini-button"
              type="button"
              disabled={!bridgeIsLive}
              onClick={() => {
                const started = telemetryControl.startRawCapture();
                setDiagnosticNotice(started
                  ? "正在本机内存录制 60 秒串口原始字节；断线或达到 8 MiB 会提前结束。"
                  : "请先连接桥接飞控并等待真实 MSP_RC 在线。");
              }}
            >录制 60 秒原始串口夹具</button>
          )}

          {telemetryControl.rawCapture.state === "ready" ? (
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
              <button className="mini-button" type="button" onClick={telemetryControl.cancelRawCapture}>清除内存夹具</button>
            </>
          ) : null}
        </div>
        <small>原始 .bin 可能包含完整 MSP 响应，只在你主动点击后采集；它不进入诊断 JSON、Session 或统计事件。</small>
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

      <footer className="dashboard-footer">
        <p><i className={`footer-light footer-light--${connection}`} />{source === "demo" ? "当前为演示数据，未连接真实飞控" : bridgeIsLive ? "只读 MSP 轮询，不写入 Betaflight 配置" : "桥接飞控当前没有实时 RC 数据"}</p>
        <p>地面桥 MSP RSSI 字段 ≠ 机上 ELRS LQ；地面桥电压 ≠ 飞行器电池</p>
        <p>FPVHelper v{version.currentVersion}</p>
      </footer>
    </main>
  );
}
