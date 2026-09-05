import { MSP_RC_TARGET_HZ } from "./telemetry";

export const CAPTURE_QUALITY_VERSION = 1;
export const CAPTURE_GAP_THRESHOLD_MS = 50;

interface CaptureSample {
  elapsedMs: number;
  source: "ground_rc" | "demo";
}

interface CaptureInterval {
  startSampleIndex: number;
  endSampleIndex: number;
  startElapsedMs: number;
  endElapsedMs: number;
  durationMs: number;
}

export interface TrainingCaptureQuality {
  version: typeof CAPTURE_QUALITY_VERSION;
  basis: "stored_host_receive_timestamps";
  targetPollHz: typeof MSP_RC_TARGET_HZ;
  source: "ground_rc" | "demo" | "mixed" | "empty";
  sampleCount: number;
  positiveIntervalCount: number;
  zeroIntervalCount: number;
  negativeIntervalCount: number;
  invalidIntervalCount: number;
  intervalStatsBasis: "positive_adjacent_intervals_only";
  quantileMethod: "linear_interpolation";
  intervalStatsMs: { median: number | null; p95: number | null; p99: number | null; max: number | null };
  gapThresholdMs: typeof CAPTURE_GAP_THRESHOLD_MS;
  gaps: CaptureInterval[];
  usablePeriodDefinition: "same_source_positive_intervals_at_or_below_gap_threshold";
  usablePeriods: (CaptureInterval & { source: CaptureSample["source"] })[];
  rfPacketLossMeasured: false;
}

const CAPTURE_CONTEXT = {
  version: 1,
  timestamp: {
    field: "samples.elapsedMs",
    clock: "performance.now",
    unit: "ms",
    origin: "session_start",
    meaning: "host_rc_frame_decode_time",
    resolution: "browser_dependent",
    batchingPossible: true,
  },
  sequence: { field: "samples.sequence", meaning: "host_generated_frame_counter", airPacketSequence: false },
  channels: { field: "samples.channelsUs", unit: "us", order: "roll_pitch_yaw_throttle_then_aux", origin: "msp_rc_payload_or_demo_generator" },
  normalization: {
    axisMidpointUs: 1500,
    axisHalfRangeUs: 500,
    axisPercentMinimum: -100,
    axisPercentMaximum: 100,
    throttleMinimumUs: 1000,
    throttleMaximumUs: 2000,
    throttlePercentMinimum: 0,
    throttlePercentMaximum: 100,
    clamped: true,
  },
  deviceSampleRateHz: null,
  rfPacketLossMeasured: false,
} as const;

export type TrainingCaptureContext = typeof CAPTURE_CONTEXT;

export function createTrainingCaptureContext(): TrainingCaptureContext {
  return structuredClone(CAPTURE_CONTEXT);
}

function rounded(value: number) {
  return Number(value.toFixed(3));
}

function quantile(sorted: readonly number[], fraction: number) {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return rounded(sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower));
}

export function calculateTrainingCaptureQuality(samples: readonly CaptureSample[]): TrainingCaptureQuality {
  const sources = new Set(samples.map((sample) => sample.source));
  const positiveIntervals: number[] = [];
  const gaps: TrainingCaptureQuality["gaps"] = [];
  const usablePeriods: TrainingCaptureQuality["usablePeriods"] = [];
  let period: TrainingCaptureQuality["usablePeriods"][number] | null = null;
  let zeroIntervalCount = 0;
  let negativeIntervalCount = 0;
  let invalidIntervalCount = 0;

  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const validTimes = [previous.elapsedMs, current.elapsedMs].every((value) => Number.isFinite(value) && value >= 0);
    const durationMs = current.elapsedMs - previous.elapsedMs;
    if (!validTimes) invalidIntervalCount += 1;
    else if (durationMs === 0) zeroIntervalCount += 1;
    else if (durationMs < 0) negativeIntervalCount += 1;
    else positiveIntervals.push(durationMs);

    if (validTimes && durationMs > CAPTURE_GAP_THRESHOLD_MS) {
      gaps.push({
        startSampleIndex: index - 1,
        endSampleIndex: index,
        startElapsedMs: previous.elapsedMs,
        endElapsedMs: current.elapsedMs,
        durationMs: rounded(durationMs),
      });
    }

    if (validTimes && durationMs > 0 && durationMs <= CAPTURE_GAP_THRESHOLD_MS && previous.source === current.source) {
      if (!period) {
        period = {
          source: current.source,
          startSampleIndex: index - 1,
          endSampleIndex: index,
          startElapsedMs: previous.elapsedMs,
          endElapsedMs: current.elapsedMs,
          durationMs: rounded(durationMs),
        };
      } else {
        period.endSampleIndex = index;
        period.endElapsedMs = current.elapsedMs;
        period.durationMs = rounded(current.elapsedMs - period.startElapsedMs);
      }
    } else if (period) {
      usablePeriods.push(period);
      period = null;
    }
  }
  if (period) usablePeriods.push(period);
  positiveIntervals.sort((left, right) => left - right);

  return {
    version: CAPTURE_QUALITY_VERSION,
    basis: "stored_host_receive_timestamps",
    targetPollHz: MSP_RC_TARGET_HZ,
    source: sources.size === 0 ? "empty" : sources.size > 1 ? "mixed" : samples[0].source,
    sampleCount: samples.length,
    positiveIntervalCount: positiveIntervals.length,
    zeroIntervalCount,
    negativeIntervalCount,
    invalidIntervalCount,
    intervalStatsBasis: "positive_adjacent_intervals_only",
    quantileMethod: "linear_interpolation",
    intervalStatsMs: {
      median: quantile(positiveIntervals, 0.5),
      p95: quantile(positiveIntervals, 0.95),
      p99: quantile(positiveIntervals, 0.99),
      max: positiveIntervals.length ? rounded(positiveIntervals[positiveIntervals.length - 1]) : null,
    },
    gapThresholdMs: CAPTURE_GAP_THRESHOLD_MS,
    gaps,
    usablePeriodDefinition: "same_source_positive_intervals_at_or_below_gap_threshold",
    usablePeriods,
    rfPacketLossMeasured: false,
  };
}

function assertMatchingExtension(actual: unknown, expected: unknown, field: string): void {
  if (actual === expected) return;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) throw new Error(`${field} 格式或样本统计不一致`);
    expected.forEach((value, index) => assertMatchingExtension(actual[index], value, `${field}[${index}]`));
    return;
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) throw new Error(`${field} 必须是对象`);
    const record = actual as Record<string, unknown>;
    const entries = Object.entries(expected);
    if (Object.keys(record).length !== entries.length) throw new Error(`${field} 字段不完整或含不支持字段`);
    for (const [key, value] of entries) assertMatchingExtension(record[key], value, `${field}.${key}`);
    return;
  }
  throw new Error(`${field} 格式或样本统计不一致`);
}

export function parseTrainingCaptureQuality(input: unknown, samples: readonly CaptureSample[]): TrainingCaptureQuality {
  const expected = calculateTrainingCaptureQuality(samples);
  assertMatchingExtension(input, expected, "captureQuality");
  return expected;
}

export function parseTrainingCaptureContext(input: unknown): TrainingCaptureContext {
  assertMatchingExtension(input, CAPTURE_CONTEXT, "captureContext");
  return createTrainingCaptureContext();
}
