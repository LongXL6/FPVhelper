import type { AnalyticsConnectionState, AnalyticsVideoState } from "./events";
import type { MspParserStats, TelemetrySource } from "../telemetry";

const MAX_EFFECTIVE_HZ = 1_000;

function counterDelta(start: number, end: number) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round(end) - Math.round(start));
}

export function analyticsObservedRcFrameDelta(previousSequence: number | null, currentSequence: number) {
  if (previousSequence === null || !Number.isFinite(currentSequence)) return 0;
  return Math.max(0, Math.round(currentSequence) - Math.round(previousSequence));
}

export function analyticsSerialLifecycleMetrics(options: {
  start: MspParserStats;
  end: MspParserStats;
  rcFrames: number;
  liveMs: number;
}) {
  const rcFrames = Math.max(0, Math.round(options.rcFrames));
  const checksumValidFrames = counterDelta(
    options.start.checksumValidFrames,
    options.end.checksumValidFrames,
  );
  const errorFrames = counterDelta(options.start.protocolErrors, options.end.protocolErrors);
  const checksumErrors = counterDelta(options.start.checksumErrors, options.end.checksumErrors);
  const nonErrorFrames = Math.max(0, checksumValidFrames - errorFrames);
  const liveMs = Math.max(0, Number.isFinite(options.liveMs) ? options.liveMs : 0);

  return {
    rc_frames: rcFrames,
    analog_frames: Math.max(0, nonErrorFrames - rcFrames),
    checksum_errors: checksumErrors,
    error_frames: errorFrames,
    effective_hz: liveMs > 0 ? Math.min(MAX_EFFECTIVE_HZ, rcFrames / (liveMs / 1_000)) : 0,
  };
}

export function analyticsConnectionTransition(
  previous: AnalyticsConnectionState,
  current: AnalyticsConnectionState,
  source: TelemetrySource,
) {
  if (source !== "serial") return null;
  if (previous === "live" && current === "stale") return "stalled" as const;
  if (previous === "stale" && current === "live") return "resumed" as const;
  return null;
}

export function analyticsVideoWasLost(
  previous: AnalyticsVideoState,
  current: AnalyticsVideoState,
  intentional: boolean,
) {
  return previous === "live" && current !== "live" && !intentional;
}

export function analyticsSerialWasLost(options: {
  previousSource: TelemetrySource;
  previousConnection: AnalyticsConnectionState;
  currentSource: TelemetrySource;
  currentConnection: AnalyticsConnectionState;
}) {
  const previouslyConnected = options.previousSource === "serial"
    && (options.previousConnection === "live" || options.previousConnection === "stale");
  if (!previouslyConnected) return false;
  if (options.currentSource === "serial" && (options.currentConnection === "live" || options.currentConnection === "stale")) return false;
  return options.currentSource === "demo" || options.currentConnection === "error";
}

export function createAnalyticsEventDeduper() {
  const lastSeen = new Map<string, number>();
  return {
    shouldEmit(key: string, now: number, quietWindowMs = 0) {
      const previous = lastSeen.get(key);
      if (previous !== undefined && now - previous <= quietWindowMs) return false;
      lastSeen.set(key, now);
      return true;
    },
  };
}
