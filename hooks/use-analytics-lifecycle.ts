"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  analyticsClient,
  flushAnalyticsWithBeacon,
  getAnalyticsLocalStatus,
  initializeAnalytics,
  optOutAnalytics,
  prepareAnalyticsReactivation,
  setAnalyticsIngestToken,
  trackAnalytics,
  type AnalyticsLocalStatus,
} from "@/lib/analytics/client";
import {
  classifySerialHardwareErrorCode,
  classifyStorageError,
  classifyUnknownError,
  classifyVideoHardwareErrorCode,
} from "@/lib/analytics/error-codes";
import type {
  AnalyticsConnectionState,
  AnalyticsOverlayMode,
  AnalyticsVideoState,
  PhaseOneEventProps,
} from "@/lib/analytics/events";
import {
  analyticsConnectionTransition,
  analyticsInterruptedSessionIsLost,
  analyticsObservedRcFrameDelta,
  analyticsSerialLifecycleMetrics,
  analyticsSerialWasLost,
  analyticsVideoWasLost,
  createAnalyticsEventDeduper,
} from "@/lib/analytics/lifecycle";
import type { SerialErrorCode, VideoCaptureErrorCode } from "@/lib/hardware-errors";
import type { MspParserStats, TelemetrySource } from "@/lib/telemetry";
import type { TrainingSessionExportReceipt } from "@/hooks/use-training-session";
import type { TrainingSession } from "@/lib/training-session";
import type { LocalVideoCaptureSettings } from "@/lib/video-capture";

const MAX_ANALYTICS_DURATION_MS = 31_536_000_000;

export type AnalyticsErrorSurface =
  | { kind: "serial"; code: SerialErrorCode }
  | { kind: "video"; code: VideoCaptureErrorCode }
  | { kind: "storage"; message: string };

interface UseAnalyticsLifecycleOptions {
  connection: AnalyticsConnectionState;
  source: TelemetrySource;
  videoState: AnalyticsVideoState;
  telemetrySequence: number;
  isRecording: boolean;
  sessionId: string | null;
  lastSession: TrainingSession | null;
  lastExport: TrainingSessionExportReceipt | null;
  unexportedValidCount: number;
  hasPendingSave: boolean;
  athleteSet: boolean;
  overlayMode: AnalyticsOverlayMode;
  serialSupported: boolean;
  mediaSupported: boolean;
  serialErrorCode: SerialErrorCode | null;
  videoErrorCode: VideoCaptureErrorCode | null;
  parserStats: MspParserStats;
  captureSettings: LocalVideoCaptureSettings | null;
  errorSurface: AnalyticsErrorSurface | null;
}

interface AnalyticsLifecycleController {
  status: AnalyticsLocalStatus;
  beginSerialConnect: () => void;
  beginVideoConnect: () => void;
  markVideoDisconnectIntentional: () => void;
  markDemoReturnIntentional: () => void;
  trackOverlayModeChange: (from: AnalyticsOverlayMode, to: AnalyticsOverlayMode) => void;
  trackOverlayLayoutReset: (wasDefault: boolean) => void;
  installToken: (token: string) => boolean;
  optOut: () => void;
  prepareReactivation: () => boolean;
}

interface PendingAttempt {
  index: number;
  startedAt: number;
}

interface LatestSnapshot {
  connection: AnalyticsConnectionState;
  source: TelemetrySource;
  videoState: AnalyticsVideoState;
  isRecording: boolean;
  sessionId: string | null;
  hasUnexportedSession: boolean;
  overlayMode: AnalyticsOverlayMode;
}

function safeDuration(value: number) {
  return Math.min(MAX_ANALYTICS_DURATION_MS, Math.max(0, Number.isFinite(value) ? value : 0));
}

function browserIdentity(userAgent: string) {
  const matchMajor = (pattern: RegExp) => Number.parseInt(userAgent.match(pattern)?.[1] ?? "0", 10) || 0;
  if (/MicroMessenger/i.test(userAgent)) return { family: "wechat" as const, major: matchMajor(/MicroMessenger\/(\d+)/i) };
  if (/Edg\//i.test(userAgent)) return { family: "edge" as const, major: matchMajor(/Edg\/(\d+)/i) };
  if (/Firefox\//i.test(userAgent)) return { family: "firefox" as const, major: matchMajor(/Firefox\/(\d+)/i) };
  if (/Chrome\//i.test(userAgent)) return { family: "chrome" as const, major: matchMajor(/Chrome\/(\d+)/i) };
  if (/Safari\//i.test(userAgent) && /Version\//i.test(userAgent)) {
    return { family: "safari" as const, major: matchMajor(/Version\/(\d+)/i) };
  }
  return { family: userAgent ? "other" as const : "unknown" as const, major: 0 };
}

function osFamily(userAgent: string): PhaseOneEventProps["app_opened"]["os_family"] {
  if (/CrOS/i.test(userAgent)) return "chromeos";
  if (/Android/i.test(userAgent)) return "android";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  if (/Windows/i.test(userAgent)) return "windows";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "macos";
  if (/Linux/i.test(userAgent)) return "linux";
  return userAgent ? "other" : "unknown";
}

function safeReferrerHost(referrer: string) {
  if (!referrer) return "";
  try {
    const hostname = new URL(referrer).hostname.toLowerCase();
    return hostname.includes(":") ? "" : hostname;
  } catch {
    return "";
  }
}

export function createAppOpenedProps(): PhaseOneEventProps["app_opened"] {
  const userAgent = navigator.userAgent ?? "";
  const browser = browserIdentity(userAgent);
  const standaloneNavigator = navigator as Navigator & { standalone?: boolean };
  return {
    browser_family: browser.family,
    browser_major: browser.major,
    os_family: osFamily(userAgent),
    serial_supported: Boolean(navigator.serial),
    secure_context: window.isSecureContext,
    media_supported: Boolean(navigator.mediaDevices?.getUserMedia),
    viewport_w: Math.max(0, Math.round(window.innerWidth)),
    viewport_h: Math.max(0, Math.round(window.innerHeight)),
    dpr: Math.min(10, Math.max(0.1, window.devicePixelRatio || 1)),
    is_wechat: /MicroMessenger/i.test(userAgent),
    is_standalone: Boolean(standaloneNavigator.standalone) || window.matchMedia?.("(display-mode: standalone)").matches === true,
    referrer_host: safeReferrerHost(document.referrer),
  };
}

function errorLike(name: string, message: string) {
  return { name, message };
}

function classifyErrorSurface(surface: AnalyticsErrorSurface) {
  if (surface.kind === "serial") return classifySerialHardwareErrorCode(surface.code);
  if (surface.kind === "video") return classifyVideoHardwareErrorCode(surface.code);
  return classifyStorageError(errorLike("Error", surface.message), "storage_write");
}

function serialFailureProps(code: SerialErrorCode) {
  const classified = classifySerialHardwareErrorCode(code);
  const reason: PhaseOneEventProps["serial_connect_result"]["reason"] =
    classified.code === "serial_unsupported" ? "web_serial_unsupported"
      : classified.code === "serial_picker_cancelled" ? "picker_cancelled"
        : classified.code === "serial_port_busy" ? "port_busy"
          : classified.code === "serial_open_failed" ? "open_failed"
            : classified.code === "serial_not_readable" ? "not_readable"
              : classified.code === "serial_not_writable" ? "not_writable"
                : classified.code === "serial_first_frame_timeout" ? "first_frame_timeout"
                  : classified.code === "serial_device_lost" ? "device_lost"
                    : "unknown";
  const stage: PhaseOneEventProps["serial_connect_result"]["stage"] =
    classified.stage === "unsupported" ? "unsupported"
      : classified.stage === "picker" ? "picker"
        : classified.stage === "handshake" ? "handshake"
          : "open";
  return { reason, stage };
}

function videoFailureReason(hardwareCode: VideoCaptureErrorCode): NonNullable<PhaseOneEventProps["video_connect_result"]["reason"]> {
  const code = classifyVideoHardwareErrorCode(hardwareCode).code;
  if (code === "video_unsupported") return "unsupported";
  if (code === "video_insecure_context") return "insecure_context";
  if (code === "video_permission_denied") return "permission_denied";
  if (code === "video_device_not_found") return "device_not_found";
  if (code === "video_device_busy") return "device_busy";
  if (code === "video_constraint_failed") return "constraint_failed";
  if (code === "video_aborted") return "aborted";
  return "unknown";
}

export function maxTrainingSampleGap(session: TrainingSession) {
  let maxGapMs = 0;
  for (let index = 1; index < session.samples.length; index += 1) {
    maxGapMs = Math.max(maxGapMs, session.samples[index].elapsedMs - session.samples[index - 1].elapsedMs);
  }
  return safeDuration(maxGapMs);
}

export function useAnalyticsLifecycle(options: UseAnalyticsLifecycleOptions): AnalyticsLifecycleController {
  const [status, setStatus] = useState<AnalyticsLocalStatus>({ state: "off", reason: "configuration" });
  const pageStartedAtRef = useRef<number | null>(null);
  const appOpenedRef = useRef(false);
  const pendingSerialRef = useRef<PendingAttempt | null>(null);
  const pendingVideoRef = useRef<PendingAttempt | null>(null);
  const serialAttemptIndexRef = useRef(0);
  const videoAttemptIndexRef = useRef(0);
  const serialLiveStartedAtRef = useRef<number | null>(null);
  const serialLiveMsTotalRef = useRef(0);
  const serialConnectionStartedAtRef = useRef<number | null>(null);
  const serialConnectionRcFrameStartRef = useRef(0);
  const serialConnectionParserStartRef = useRef(options.parserStats);
  const serialConnectionParserLatestRef = useRef(options.parserStats);
  const videoLiveStartedAtRef = useRef<number | null>(null);
  const videoLiveMsTotalRef = useRef(0);
  const videoConnectionStartedAtRef = useRef<number | null>(null);
  const stallStartedAtRef = useRef<number | null>(null);
  const recordingStallCountRef = useRef(0);
  const observedRcFramesRef = useRef(0);
  const previousTelemetrySequenceRef = useRef<number | null>(null);
  const recordingHiddenMsRef = useRef(0);
  const recordingHiddenStartedAtRef = useRef<number | null>(null);
  const pageHiddenStartedAtRef = useRef<number | null>(null);
  const activeRecordingIdRef = useRef<string | null>(null);
  const pendingStoppedRecordingIdRef = useRef<string | null>(null);
  const previousConnectionRef = useRef(options.connection);
  const previousSourceRef = useRef(options.source);
  const previousVideoStateRef = useRef(options.videoState);
  const videoDisconnectIntentionalRef = useRef(false);
  const demoReturnRef = useRef<{
    wasRecording: boolean;
    previousConnection: AnalyticsConnectionState;
    serialLiveMs: number;
  } | null>(null);
  const lastExportReceiptRef = useRef<string | null>(null);
  const lostSessionIdsRef = useRef(new Set<string>());
  const previousErrorFingerprintRef = useRef<string | null>(null);
  const shownErrorIndexRef = useRef(0);
  const deduperRef = useRef(createAnalyticsEventDeduper());
  const statsRef = useRef({
    maxFunnelStep: 1,
    recordingsStarted: 0,
    recordingsStopped: 0,
    sessionsExported: 0,
    errorCount: 0,
  });
  const latestRef = useRef<LatestSnapshot>({
    connection: options.connection,
    source: options.source,
    videoState: options.videoState,
    isRecording: options.isRecording,
    sessionId: options.sessionId,
    hasUnexportedSession: options.unexportedValidCount > 0 || options.hasPendingSave,
    overlayMode: options.overlayMode,
  });
  const updateClientContext = useCallback(() => {
    const latest = latestRef.current;
    analyticsClient.setContext({
      recordingId: latest.isRecording ? latest.sessionId : null,
      connection: latest.connection,
      videoState: latest.videoState,
      isRecording: latest.isRecording,
      overlayMode: latest.overlayMode,
      telemetrySource: latest.source === "serial" ? "serial" : "demo",
    });
  }, []);

  const emitAppOpened = useCallback(() => {
    if (appOpenedRef.current || typeof window === "undefined") return;
    updateClientContext();
    const eventId = trackAnalytics("app_opened", createAppOpenedProps());
    if (eventId) appOpenedRef.current = true;
  }, [updateClientContext]);

  const resetAnalyticsWindow = useCallback(() => {
    const now = performance.now();
    pageStartedAtRef.current = now;
    statsRef.current = {
      maxFunnelStep: 1,
      recordingsStarted: 0,
      recordingsStopped: 0,
      sessionsExported: 0,
      errorCount: 0,
    };
    serialLiveMsTotalRef.current = 0;
    videoLiveMsTotalRef.current = 0;
    serialLiveStartedAtRef.current = latestRef.current.source === "serial" && latestRef.current.connection === "live" ? now : null;
    serialConnectionStartedAtRef.current = latestRef.current.source === "serial"
      && (latestRef.current.connection === "live" || latestRef.current.connection === "stale") ? now : null;
    serialConnectionRcFrameStartRef.current = observedRcFramesRef.current;
    serialConnectionParserStartRef.current = serialConnectionParserLatestRef.current;
    videoLiveStartedAtRef.current = latestRef.current.videoState === "live" ? now : null;
    videoConnectionStartedAtRef.current = latestRef.current.videoState === "live" ? now : null;
    stallStartedAtRef.current = latestRef.current.connection === "stale" ? now : null;
    recordingHiddenMsRef.current = 0;
    recordingHiddenStartedAtRef.current = latestRef.current.isRecording && document.visibilityState === "hidden" ? now : null;
    recordingStallCountRef.current = 0;
    pageHiddenStartedAtRef.current = document.visibilityState === "hidden" ? now : null;
    shownErrorIndexRef.current = 0;
    lostSessionIdsRef.current.clear();
    pendingSerialRef.current = null;
    pendingVideoRef.current = null;
    demoReturnRef.current = null;
    activeRecordingIdRef.current = null;
    pendingStoppedRecordingIdRef.current = null;
    appOpenedRef.current = false;
  }, []);

  const emitSerialLost = useCallback((reason: PhaseOneEventProps["serial_lost"]["reason"], now: number) => {
    const startedAt = serialConnectionStartedAtRef.current;
    if (startedAt === null) return false;
    const liveMs = safeDuration(now - startedAt);
    const rcFrames = Math.max(0, observedRcFramesRef.current - serialConnectionRcFrameStartRef.current);
    const parserMetrics = analyticsSerialLifecycleMetrics({
      start: serialConnectionParserStartRef.current,
      end: serialConnectionParserLatestRef.current,
      rcFrames,
      liveMs,
    });
    trackAnalytics("serial_lost", {
      reason,
      live_ms: liveMs,
      was_recording: latestRef.current.isRecording,
      ...parserMetrics,
    });
    serialConnectionStartedAtRef.current = null;
    serialConnectionRcFrameStartRef.current = observedRcFramesRef.current;
    serialConnectionParserStartRef.current = serialConnectionParserLatestRef.current;
    stallStartedAtRef.current = null;
    return true;
  }, []);

  useEffect(() => {
    latestRef.current = {
      connection: options.connection,
      source: options.source,
      videoState: options.videoState,
      isRecording: options.isRecording,
      sessionId: options.sessionId,
      hasUnexportedSession: options.unexportedValidCount > 0 || options.hasPendingSave,
      overlayMode: options.overlayMode,
    };
  }, [
    options.connection,
    options.hasPendingSave,
    options.isRecording,
    options.overlayMode,
    options.sessionId,
    options.source,
    options.unexportedValidCount,
    options.videoState,
  ]);

  useEffect(() => {
    let cancelled = false;
    pageStartedAtRef.current ??= performance.now();
    initializeAnalytics();
    updateClientContext();
    emitAppOpened();
    queueMicrotask(() => {
      if (!cancelled) setStatus(getAnalyticsLocalStatus());
    });
    return () => {
      cancelled = true;
    };
  }, [emitAppOpened, updateClientContext]);

  useEffect(() => {
    updateClientContext();
  }, [options.connection, options.isRecording, options.overlayMode, options.sessionId, options.source, options.videoState, updateClientContext]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      const now = performance.now();
      const latest = latestRef.current;
      if (document.visibilityState === "hidden") {
        if (pageHiddenStartedAtRef.current !== null) return;
        pageHiddenStartedAtRef.current = now;
        if (latest.isRecording) recordingHiddenStartedAtRef.current = now;
        trackAnalytics("page_hidden", {
          was_recording: latest.isRecording,
          connection: latest.connection,
          video_state: latest.videoState,
        });
        return;
      }
      const hiddenAt = pageHiddenStartedAtRef.current;
      if (hiddenAt === null) return;
      const hiddenMs = safeDuration(now - hiddenAt);
      pageHiddenStartedAtRef.current = null;
      if (recordingHiddenStartedAtRef.current !== null) {
        recordingHiddenMsRef.current += now - recordingHiddenStartedAtRef.current;
        recordingHiddenStartedAtRef.current = null;
      }
      trackAnalytics("page_visible", {
        was_recording: latest.isRecording,
        hidden_ms: hiddenMs,
        connection: latest.connection,
        video_state: latest.videoState,
      });
    };

    const handlePageHide = () => {
      const now = performance.now();
      if (!deduperRef.current.shouldEmit("page_unloaded", now, 60_000)) return;
      const latest = latestRef.current;
      if (latest.source === "serial" && (latest.connection === "live" || latest.connection === "stale")) {
        emitSerialLost("unmount", now);
      }
      const stats = statsRef.current;
      const serialLiveMsTotal = serialLiveMsTotalRef.current + (serialLiveStartedAtRef.current === null ? 0 : now - serialLiveStartedAtRef.current);
      const videoLiveMsTotal = videoLiveMsTotalRef.current + (videoLiveStartedAtRef.current === null ? 0 : now - videoLiveStartedAtRef.current);
      trackAnalytics("page_unloaded", {
        page_duration_ms: safeDuration(now - (pageStartedAtRef.current ?? now)),
        is_recording: latest.isRecording,
        has_unexported_session: latest.hasUnexportedSession,
        max_funnel_step: Math.min(6, Math.max(1, stats.maxFunnelStep)),
        recordings_started: stats.recordingsStarted,
        recordings_stopped: stats.recordingsStopped,
        sessions_exported: stats.sessionsExported,
        error_count: stats.errorCount,
        serial_live_ms_total: safeDuration(serialLiveMsTotal),
        video_live_ms_total: safeDuration(videoLiveMsTotal),
      }, { urgent: true });
      void flushAnalyticsWithBeacon();
    };

    const handleWindowError = (event: ErrorEvent) => {
      const classified = classifyUnknownError(event.error, "runtime");
      if (!deduperRef.current.shouldEmit(`js:${classified.fingerprint}`, performance.now(), 5_000)) return;
      const eventId = trackAnalytics("js_error", {
        code: "unexpected_exception",
        stage: classified.stage,
        fingerprint: classified.fingerprint,
      }, { urgent: true });
      if (eventId) statsRef.current.errorCount += 1;
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const classified = classifyUnknownError(event.reason, "runtime");
      if (!deduperRef.current.shouldEmit(`js:${classified.fingerprint}`, performance.now(), 5_000)) return;
      const eventId = trackAnalytics("js_error", {
        code: "unexpected_exception",
        stage: classified.stage,
        fingerprint: classified.fingerprint,
      }, { urgent: true });
      if (eventId) statsRef.current.errorCount += 1;
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, [emitSerialLost]);

  useEffect(() => {
    if (options.source !== "serial") {
      previousTelemetrySequenceRef.current = null;
      return;
    }
    if (previousTelemetrySequenceRef.current === options.telemetrySequence) return;
    observedRcFramesRef.current += analyticsObservedRcFrameDelta(
      previousTelemetrySequenceRef.current,
      options.telemetrySequence,
    );
    previousTelemetrySequenceRef.current = options.telemetrySequence;
  }, [options.source, options.telemetrySequence]);

  useEffect(() => {
    const current = serialConnectionParserLatestRef.current;
    const isMonotonicFinalSnapshot = serialConnectionStartedAtRef.current !== null
      && options.parserStats.bytesReceived >= current.bytesReceived;
    if (options.source === "serial" || isMonotonicFinalSnapshot) {
      serialConnectionParserLatestRef.current = options.parserStats;
    }
  }, [options.parserStats, options.source]);

  useEffect(() => {
    const now = performance.now();
    const previous = previousConnectionRef.current;
    const previousSource = previousSourceRef.current;
    const transition = analyticsConnectionTransition(previous, options.connection, options.source);

    if (options.source === "serial" && options.connection === "live") {
      if (serialLiveStartedAtRef.current === null) serialLiveStartedAtRef.current = now;
      if (serialConnectionStartedAtRef.current === null) {
        serialConnectionStartedAtRef.current = now;
        serialConnectionRcFrameStartRef.current = observedRcFramesRef.current;
        serialConnectionParserStartRef.current = serialConnectionParserLatestRef.current;
      }
      statsRef.current.maxFunnelStep = Math.max(statsRef.current.maxFunnelStep, 3);
    } else if (serialLiveStartedAtRef.current !== null) {
      serialLiveMsTotalRef.current += now - serialLiveStartedAtRef.current;
      serialLiveStartedAtRef.current = null;
    }

    if (transition === "stalled") {
      stallStartedAtRef.current = now;
      if (options.isRecording) recordingStallCountRef.current += 1;
      trackAnalytics("telemetry_stalled", {
        was_recording: options.isRecording,
        tab_hidden: document.visibilityState === "hidden",
        rc_frames_before: observedRcFramesRef.current,
      });
    } else if (transition === "resumed" && stallStartedAtRef.current !== null) {
      trackAnalytics("telemetry_resumed", {
        stall_ms: safeDuration(now - stallStartedAtRef.current),
        was_recording: options.isRecording,
        tab_hidden: document.visibilityState === "hidden",
        rc_frames_before: observedRcFramesRef.current,
      });
      stallStartedAtRef.current = null;
    }

    const pending = pendingSerialRef.current;
    if (pending && options.source === "serial" && options.connection === "live") {
      trackAnalytics("serial_connect_result", {
        ok: true,
        stage: "handshake",
        ms_to_first_frame: safeDuration(now - pending.startedAt),
        attempt_index: pending.index,
      });
      pendingSerialRef.current = null;
    } else if (pending && options.serialErrorCode && (options.connection === "error" || options.connection === "demo")) {
      const failure = serialFailureProps(options.serialErrorCode);
      trackAnalytics("serial_connect_result", {
        ok: false,
        reason: failure.reason,
        stage: failure.stage,
        attempt_index: pending.index,
      });
      pendingSerialRef.current = null;
    }

    const demoReturn = demoReturnRef.current;
    if (demoReturn && options.source === "demo" && options.connection === "demo") {
      trackAnalytics("demo_returned", {
        was_recording: demoReturn.wasRecording,
        previous_connection: demoReturn.previousConnection,
        serial_live_ms: safeDuration(demoReturn.serialLiveMs),
      });
      demoReturnRef.current = null;
    }

    if (analyticsSerialWasLost({
      previousSource,
      previousConnection: previous,
      currentSource: options.source,
      currentConnection: options.connection,
    })) {
      const reason = demoReturn ? "user_demo"
        : options.serialErrorCode === "serial_write_failed" || options.serialErrorCode === "serial_not_writable"
          ? "write_error"
          : options.serialErrorCode === "serial_read_failed" || options.serialErrorCode === "serial_not_readable"
            ? "read_error"
          : "device_disconnect";
      emitSerialLost(reason, now);
    }
    previousConnectionRef.current = options.connection;
    previousSourceRef.current = options.source;
  }, [emitSerialLost, options.connection, options.isRecording, options.serialErrorCode, options.source]);

  useEffect(() => {
    const now = performance.now();
    const previous = previousVideoStateRef.current;
    if (options.videoState === "live") {
      if (videoLiveStartedAtRef.current === null) videoLiveStartedAtRef.current = now;
      if (videoConnectionStartedAtRef.current === null) videoConnectionStartedAtRef.current = now;
      statsRef.current.maxFunnelStep = Math.max(statsRef.current.maxFunnelStep, 2);
    } else if (videoLiveStartedAtRef.current !== null) {
      videoLiveMsTotalRef.current += now - videoLiveStartedAtRef.current;
      videoLiveStartedAtRef.current = null;
    }

    const pending = pendingVideoRef.current;
    if (pending && options.videoState === "live") {
      const videoMetrics = options.captureSettings;
      trackAnalytics("video_connect_result", {
        ok: true,
        device_kind: "unknown",
        ...(videoMetrics?.width && videoMetrics.width > 0 ? { width: Math.round(videoMetrics.width) } : {}),
        ...(videoMetrics?.height && videoMetrics.height > 0 ? { height: Math.round(videoMetrics.height) } : {}),
        ...(videoMetrics?.frameRate && videoMetrics.frameRate > 0 ? { frame_rate: videoMetrics.frameRate } : {}),
        latency_ms: safeDuration(now - pending.startedAt),
        attempt_index: pending.index,
      });
      pendingVideoRef.current = null;
    } else if (pending && options.videoState === "error" && options.videoErrorCode) {
      trackAnalytics("video_connect_result", {
        ok: false,
        reason: videoFailureReason(options.videoErrorCode),
        device_kind: "unknown",
        latency_ms: safeDuration(now - pending.startedAt),
        attempt_index: pending.index,
      });
      pendingVideoRef.current = null;
    }

    const intentional = videoDisconnectIntentionalRef.current;
    if (analyticsVideoWasLost(previous, options.videoState, intentional)) {
      trackAnalytics("video_lost", {
        live_ms: safeDuration(videoConnectionStartedAtRef.current === null ? 0 : now - videoConnectionStartedAtRef.current),
        was_recording: options.isRecording,
        device_kind: "unknown",
      });
    }
    if (previous === "live" && options.videoState !== "live") {
      videoDisconnectIntentionalRef.current = false;
      videoConnectionStartedAtRef.current = null;
    }
    previousVideoStateRef.current = options.videoState;
  }, [options.captureSettings, options.isRecording, options.videoErrorCode, options.videoState]);

  useEffect(() => {
    if (options.isRecording && !activeRecordingIdRef.current && options.sessionId) {
      activeRecordingIdRef.current = options.sessionId;
      pendingStoppedRecordingIdRef.current = null;
      recordingHiddenMsRef.current = 0;
      recordingHiddenStartedAtRef.current = document.visibilityState === "hidden" ? performance.now() : null;
      recordingStallCountRef.current = 0;
      statsRef.current.recordingsStarted += 1;
      statsRef.current.maxFunnelStep = Math.max(statsRef.current.maxFunnelStep, 4);
      updateClientContext();
      trackAnalytics("recording_started", {
        recording_id: options.sessionId,
        connection_at_start: options.connection,
        source_at_start: options.source === "serial" ? "serial" : "demo",
        video_state: options.videoState,
        athlete_set: options.athleteSet,
        prev_unexported: options.unexportedValidCount > 0,
        recording_index: statsRef.current.recordingsStarted,
        ms_since_serial_live: safeDuration(serialLiveStartedAtRef.current === null ? 0 : performance.now() - serialLiveStartedAtRef.current),
      });
    }

    if (!options.isRecording && activeRecordingIdRef.current) {
      pendingStoppedRecordingIdRef.current = activeRecordingIdRef.current;
    }

    const stoppedId = pendingStoppedRecordingIdRef.current;
    const session = options.lastSession;
    if (!options.isRecording && stoppedId && session?.id === stoppedId) {
      const now = performance.now();
      const hiddenMs = recordingHiddenMsRef.current + (
        recordingHiddenStartedAtRef.current === null ? 0 : now - recordingHiddenStartedAtRef.current
      );
      const dataSources = session.dataSources.length > 0 ? session.dataSources : [session.initialSource];
      updateClientContext();
      trackAnalytics("recording_stopped", {
        recording_id: session.id,
        duration_ms: safeDuration(session.durationMs),
        sample_count: session.sampleCount,
        hz: session.estimatedRcSampleRateHz ?? 0,
        data_sources: dataSources,
        valid: session.validity.valid,
        invalid_reasons: session.validity.reasons,
        max_gap_ms: maxTrainingSampleGap(session),
        hidden_ms: safeDuration(hiddenMs),
        stall_count: recordingStallCountRef.current,
        athlete_set: Boolean(session.athleteCode),
      });
      statsRef.current.recordingsStopped += 1;
      if (session.validity.valid) statsRef.current.maxFunnelStep = Math.max(statsRef.current.maxFunnelStep, 5);
      activeRecordingIdRef.current = null;
      pendingStoppedRecordingIdRef.current = null;
      recordingHiddenStartedAtRef.current = null;
      recordingHiddenMsRef.current = 0;
      recordingStallCountRef.current = 0;
    }
  }, [
    options.athleteSet,
    options.connection,
    options.isRecording,
    options.lastSession,
    options.sessionId,
    options.source,
    options.unexportedValidCount,
    options.videoState,
    updateClientContext,
  ]);

  useEffect(() => {
    const receipt = options.lastExport;
    if (!receipt || lastExportReceiptRef.current === receipt.receiptId) return;
    lastExportReceiptRef.current = receipt.receiptId;
    const session = receipt.session;
    trackAnalytics("session_exported", {
      recording_id: session.id,
      valid: session.validity.valid,
      ms_since_stop: safeDuration(receipt.exportedAtEpochMs - Date.parse(session.endedAt)),
      bytes: Math.max(0, Math.round(receipt.bytes)),
      export_index: session.exportCount,
      method: receipt.method,
    });
    statsRef.current.sessionsExported += 1;
    statsRef.current.maxFunnelStep = Math.max(statsRef.current.maxFunnelStep, 6);
  }, [options.lastExport]);

  useEffect(() => {
    const session = options.lastSession;
    if (!session || !analyticsInterruptedSessionIsLost({
      interrupted: session.interrupted,
      exportedAt: session.exportedAt,
      alreadyTracked: lostSessionIdsRef.current.has(session.id),
    })) return;
    lostSessionIdsRef.current.add(session.id);
    trackAnalytics("session_lost", {
      reason: "recording_interrupted",
      recording_id: session.id,
      valid: session.validity.valid,
      duration_ms: safeDuration(session.durationMs),
      sample_count: session.sampleCount,
      ms_since_stop: safeDuration(Date.now() - Date.parse(session.endedAt)),
    });
  }, [options.lastSession]);

  useEffect(() => {
    const surface = options.errorSurface;
    if (!surface) {
      previousErrorFingerprintRef.current = null;
      return;
    }
    const classified = classifyErrorSurface(surface);
    if (previousErrorFingerprintRef.current === classified.fingerprint) return;
    previousErrorFingerprintRef.current = classified.fingerprint;
    shownErrorIndexRef.current += 1;
    const eventId = trackAnalytics("error_shown", {
      domain: classified.domain,
      code: classified.code,
      stage: classified.stage,
      fingerprint: classified.fingerprint,
      masked_other: classified.code.endsWith("_unknown") || classified.code === "unexpected_exception",
      shown_index: shownErrorIndexRef.current,
      is_recording: options.isRecording,
    });
    if (eventId) statsRef.current.errorCount += 1;
  }, [options.errorSurface, options.isRecording]);

  const beginSerialConnect = useCallback(() => {
    serialAttemptIndexRef.current += 1;
    const attempt = { index: serialAttemptIndexRef.current, startedAt: performance.now() };
    if (!options.serialSupported) {
      trackAnalytics("serial_connect_result", {
        ok: false,
        reason: "web_serial_unsupported",
        stage: "unsupported",
        attempt_index: attempt.index,
      });
      pendingSerialRef.current = null;
      return;
    }
    pendingSerialRef.current = attempt;
  }, [options.serialSupported]);

  const beginVideoConnect = useCallback(() => {
    videoAttemptIndexRef.current += 1;
    const attempt = { index: videoAttemptIndexRef.current, startedAt: performance.now() };
    if (!options.mediaSupported) {
      trackAnalytics("video_connect_result", {
        ok: false,
        reason: "unsupported",
        device_kind: "unknown",
        latency_ms: 0,
        attempt_index: attempt.index,
      });
      pendingVideoRef.current = null;
      return;
    }
    pendingVideoRef.current = attempt;
  }, [options.mediaSupported]);

  const markVideoDisconnectIntentional = useCallback(() => {
    videoDisconnectIntentionalRef.current = true;
  }, []);

  const markDemoReturnIntentional = useCallback(() => {
    const now = performance.now();
    demoReturnRef.current = {
      wasRecording: latestRef.current.isRecording,
      previousConnection: latestRef.current.connection,
      serialLiveMs: serialConnectionStartedAtRef.current === null ? 0 : now - serialConnectionStartedAtRef.current,
    };
  }, []);

  const trackOverlayModeChange = useCallback((from: AnalyticsOverlayMode, to: AnalyticsOverlayMode) => {
    if (from === to) return;
    trackAnalytics("overlay_mode_changed", { from, to, is_recording: latestRef.current.isRecording });
  }, []);

  const trackOverlayLayoutReset = useCallback((wasDefault: boolean) => {
    trackAnalytics("overlay_layout_reset", {
      overlay_mode: latestRef.current.overlayMode,
      was_default: wasDefault,
    });
  }, []);

  const installToken = useCallback((token: string) => {
    const installed = setAnalyticsIngestToken(token);
    if (installed) resetAnalyticsWindow();
    updateClientContext();
    emitAppOpened();
    setStatus(getAnalyticsLocalStatus());
    return installed;
  }, [emitAppOpened, resetAnalyticsWindow, updateClientContext]);

  const optOut = useCallback(() => {
    optOutAnalytics();
    resetAnalyticsWindow();
    setStatus(getAnalyticsLocalStatus());
  }, [resetAnalyticsWindow]);

  const prepareReactivation = useCallback(() => {
    const prepared = prepareAnalyticsReactivation();
    if (prepared) resetAnalyticsWindow();
    setStatus(getAnalyticsLocalStatus());
    return prepared;
  }, [resetAnalyticsWindow]);

  return {
    status,
    beginSerialConnect,
    beginVideoConnect,
    markVideoDisconnectIntentional,
    markDemoReturnIntentional,
    trackOverlayModeChange,
    trackOverlayLayoutReset,
    installToken,
    optOut,
    prepareReactivation,
  };
}
