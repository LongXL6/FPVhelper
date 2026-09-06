import { clamp, type FlightTelemetry, type TelemetrySource } from "./telemetry";
import { CAPTURE_GAP_THRESHOLD_MS } from "./training-capture-quality";

export const LIVE_THROTTLE_WINDOW_MS = 3_000;
export const LIVE_THROTTLE_MAX_POINTS = 512;

export interface LiveThrottleSample {
  monotonicTimestampMs: number;
  throttleStickPercent: number;
  source: TelemetrySource;
  breakBefore: boolean;
}

// Observe every raw interval before display decimation. A 50 ms display stride
// (or a longer stride at a slower input rate) is not a raw receive gap.
export function createLiveThrottleHistory() {
  let history: LiveThrottleSample[] = [];
  let previous: { time: number; source: TelemetrySource } | null = null;
  let pendingBreak = false;

  return {
    reset() {
      history = [];
      previous = null;
      pendingBreak = false;
    },
    observe(
      sample: Pick<FlightTelemetry, "monotonicTimestampMs" | "throttleStickPercent">,
      source: TelemetrySource,
      append: boolean,
    ): LiveThrottleSample[] | null {
      const time = sample.monotonicTimestampMs;
      if (!Number.isFinite(time) || time < 0 || !Number.isFinite(sample.throttleStickPercent)) {
        previous = null;
        pendingBreak = true;
        return null;
      }
      if (previous && (previous.source !== source || time < previous.time)) {
        history = [];
        pendingBreak = true;
      }
      if (previous) {
        const interval = time - previous.time;
        pendingBreak ||= interval <= 0 || interval > CAPTURE_GAP_THRESHOLD_MS;
      }
      previous = { time, source };
      if (!append) return null;
      history = [
        ...history.filter((point) => point.monotonicTimestampMs >= time - LIVE_THROTTLE_WINDOW_MS)
          .slice(-(LIVE_THROTTLE_MAX_POINTS - 1)),
        { monotonicTimestampMs: time, throttleStickPercent: sample.throttleStickPercent, source, breakBefore: pendingBreak },
      ];
      pendingBreak = false;
      return history;
    },
  };
}

export function liveThrottleSegments(samples: readonly LiveThrottleSample[], nowMs: number) {
  const segments: Array<Array<{ x: number; y: number }>> = [];
  if (!Number.isFinite(nowMs) || nowMs < 0) return segments;
  const start = nowMs - LIVE_THROTTLE_WINDOW_MS;
  let previous: LiveThrottleSample | null = null;
  for (const sample of samples) {
    const time = sample.monotonicTimestampMs;
    if (!Number.isFinite(time) || !Number.isFinite(sample.throttleStickPercent) || time < start || time > nowMs) {
      previous = null;
      continue;
    }
    if (!previous || sample.breakBefore || sample.source !== previous.source || time <= previous.monotonicTimestampMs) {
      segments.push([]);
    }
    segments.at(-1)!.push({
      x: (time - start) / LIVE_THROTTLE_WINDOW_MS * 640,
      y: 96 - clamp(sample.throttleStickPercent, 0, 100) * 0.84,
    });
    previous = sample;
  }
  return segments;
}
