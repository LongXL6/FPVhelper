import type { AnalyticsConnectionState, AnalyticsVideoState } from "./events";
import type { TelemetrySource } from "../telemetry";

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

export function analyticsInterruptedSessionIsLost(options: {
  interrupted: boolean;
  exportedAt: string | null;
  alreadyTracked: boolean;
}) {
  return options.interrupted && options.exportedAt === null && !options.alreadyTracked;
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
