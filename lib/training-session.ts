import type { FlightTelemetry, TelemetrySource } from "./telemetry";

export const TRAINING_SESSION_SCHEMA_VERSION = 1;

export type RecordedTelemetrySource = "demo" | "ground_rc";

export interface TrainingSessionSample {
  elapsedMs: number;
  sequence: number;
  source: RecordedTelemetrySource;
  rc: {
    rollStickPercent: number;
    pitchStickPercent: number;
    yawStickPercent: number;
    throttleStickPercent: number;
    throttleUs: number;
  };
  groundBridge: {
    mspRssiPercent: number | null;
    voltage: number | null;
  };
}

export interface TrainingSessionDraft {
  id: string;
  startedAt: string;
  startedMonotonicMs: number;
  initialSource: RecordedTelemetrySource;
  samples: TrainingSessionSample[];
}

export interface TrainingSession {
  schemaVersion: typeof TRAINING_SESSION_SCHEMA_VERSION;
  id: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  initialSource: RecordedTelemetrySource;
  dataSources: RecordedTelemetrySource[];
  sampleCount: number;
  estimatedRcSampleRateHz: number | null;
  timing: {
    clock: "performance.now";
    videoOffsetCalibrated: false;
  };
  video: {
    recorded: false;
    synchronized: false;
  };
  samples: TrainingSessionSample[];
}

export function toRecordedTelemetrySource(source: TelemetrySource): RecordedTelemetrySource {
  return source === "serial" ? "ground_rc" : "demo";
}

export function createTrainingSessionDraft(
  id: string,
  source: TelemetrySource,
  startedAtEpochMs: number,
  startedMonotonicMs: number,
): TrainingSessionDraft {
  return {
    id,
    startedAt: new Date(startedAtEpochMs).toISOString(),
    startedMonotonicMs,
    initialSource: toRecordedTelemetrySource(source),
    samples: [],
  };
}

export function appendTrainingSessionSample(
  draft: TrainingSessionDraft,
  telemetry: FlightTelemetry,
  source: TelemetrySource,
) {
  if (telemetry.sequence <= 0 || telemetry.monotonicTimestampMs < draft.startedMonotonicMs) return false;

  const recordedSource = toRecordedTelemetrySource(source);
  const previous = draft.samples.at(-1);
  if (previous?.sequence === telemetry.sequence) return false;

  draft.samples.push({
    elapsedMs: Number((telemetry.monotonicTimestampMs - draft.startedMonotonicMs).toFixed(3)),
    sequence: telemetry.sequence,
    source: recordedSource,
    rc: {
      rollStickPercent: telemetry.rollStickPercent,
      pitchStickPercent: telemetry.pitchStickPercent,
      yawStickPercent: telemetry.yawStickPercent,
      throttleStickPercent: telemetry.throttleStickPercent,
      throttleUs: telemetry.rcThrottleUs,
    },
    groundBridge: {
      mspRssiPercent: telemetry.groundMspRssiPercent,
      voltage: telemetry.groundBridgeVoltage,
    },
  });
  return true;
}

function estimateSampleRate(samples: TrainingSessionSample[]) {
  if (samples.length < 2) return null;
  const elapsedMs = samples.at(-1)!.elapsedMs - samples[0].elapsedMs;
  if (elapsedMs <= 0) return null;
  return Number((((samples.length - 1) * 1000) / elapsedMs).toFixed(2));
}

export function finishTrainingSession(
  draft: TrainingSessionDraft,
  endedAtEpochMs: number,
  endedMonotonicMs: number,
): TrainingSession {
  const samples = [...draft.samples];
  return {
    schemaVersion: TRAINING_SESSION_SCHEMA_VERSION,
    id: draft.id,
    startedAt: draft.startedAt,
    endedAt: new Date(endedAtEpochMs).toISOString(),
    durationMs: Number(Math.max(0, endedMonotonicMs - draft.startedMonotonicMs).toFixed(3)),
    initialSource: draft.initialSource,
    dataSources: [...new Set(samples.map((sample) => sample.source))],
    sampleCount: samples.length,
    estimatedRcSampleRateHz: estimateSampleRate(samples),
    timing: {
      clock: "performance.now",
      videoOffsetCalibrated: false,
    },
    video: {
      recorded: false,
      synchronized: false,
    },
    samples,
  };
}

export function serializeTrainingSession(session: TrainingSession) {
  return `${JSON.stringify(session, null, 2)}\n`;
}

export function trainingSessionFilename(session: TrainingSession) {
  const timestamp = session.startedAt.replaceAll(":", "-").replace(".000Z", "Z");
  const shortId = session.id.startsWith("session-") ? session.id.slice(8, 16) : session.id.slice(0, 8);
  return `fpv-session-${timestamp}-${shortId}.json`;
}
