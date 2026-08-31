import type { FlightTelemetry, TelemetrySource } from "./telemetry";
import { isWorkstationId } from "./workstation-id";

export const TRAINING_SESSION_SCHEMA_VERSION = 2;
export const MINIMUM_VALID_SESSION_DURATION_MS = 60_000;
export const MINIMUM_VALID_SESSION_SAMPLES = 300;

export type RecordedTelemetrySource = "demo" | "ground_rc";
export type TrainingSessionMarkerKind = "manual" | "crash" | "gate_hit" | "clean" | "throttle";
export type TrainingSessionInterruptionReason = "rx_link_lost" | "telemetry_unavailable" | "page_closed";
export type TrainingSessionInvalidReason =
  | "source_not_ground_rc"
  | "mixed_sources"
  | "too_short"
  | "too_few_unique_samples"
  | "non_monotonic"
  | "no_athlete_code"
  | "rx_link_lost"
  | "interrupted";
export type TrainingAttemptCandidateReason = "technically_invalid" | "missing_notes";

export interface TrainingSessionMarker {
  id: string;
  kind: TrainingSessionMarkerKind;
  elapsedMs: number;
  wallClockAt: string;
}

export interface TrainingSessionSample {
  elapsedMs: number;
  sequence: number;
  source: RecordedTelemetrySource;
  channelsUs: number[];
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
  schemaVersion: typeof TRAINING_SESSION_SCHEMA_VERSION;
  id: string;
  workstationId: string | null;
  build: string | null;
  athleteCode: string;
  startedAt: string;
  wallClockStartedAt: string;
  startedMonotonicMs: number;
  initialSource: RecordedTelemetrySource;
  markers: TrainingSessionMarker[];
  samples: TrainingSessionSample[];
}

export interface TrainingSessionAssessment {
  valid: boolean;
  reasons: TrainingSessionInvalidReason[];
}

export interface TrainingAttemptCandidateAssessment {
  candidate: boolean;
  reasons: TrainingAttemptCandidateReason[];
}

export interface TrainingSession {
  schemaVersion: typeof TRAINING_SESSION_SCHEMA_VERSION;
  migratedFromSchemaVersion?: 1;
  id: string;
  workstationId: string | null;
  build: string | null;
  athleteCode: string | null;
  notes: string | null;
  exportedAt: string | null;
  exportCount: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  initialSource: RecordedTelemetrySource;
  dataSources: RecordedTelemetrySource[];
  sampleCount: number;
  estimatedRcSampleRateHz: number | null;
  interrupted: boolean;
  interruptionReason: TrainingSessionInterruptionReason | null;
  validity: TrainingSessionAssessment;
  timing: {
    clock: "performance.now";
    wallClockStartedAt: string;
    videoOffsetCalibrated: false;
  };
  video: {
    recorded: false;
    synchronized: false;
  };
  markers: TrainingSessionMarker[];
  samples: TrainingSessionSample[];
}

export interface TrainingSessionTermination {
  interrupted: boolean;
  interruptionReason: TrainingSessionInterruptionReason | null;
}

interface FinalizeTrainingSessionOptions {
  interrupted?: boolean;
  interruptionReason?: TrainingSessionInterruptionReason;
}

type AssessableTrainingSession = Omit<TrainingSession, "validity">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string) {
  if (!isRecord(value)) throw new Error(`${field} 必须是对象`);
  return value;
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} 必须是非空字符串`);
  return value;
}

function requireFiniteNumber(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} 必须是有限数字`);
  return value;
}

function requireNullableFiniteNumber(value: unknown, field: string) {
  if (value === null) return null;
  return requireFiniteNumber(value, field);
}

function requireRecordedSource(value: unknown, field: string): RecordedTelemetrySource {
  if (value !== "demo" && value !== "ground_rc") throw new Error(`${field} 不是支持的数据源`);
  return value;
}

function optionalInterruptionReason(value: unknown): TrainingSessionInterruptionReason | null {
  if (value === null || value === undefined) return null;
  if (value === "rx_link_lost" || value === "telemetry_unavailable" || value === "page_closed") return value;
  throw new Error("interruptionReason 不是支持的中断原因");
}

function normalizedAthleteCode(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("athleteCode 必须是字符串或 null");
  const normalized = value.trim().replaceAll(/\s+/g, " ").slice(0, 40);
  return normalized || null;
}

function parsedWorkstationId(value: unknown) {
  return isWorkstationId(value) ? value : null;
}

function parsedPublicBuild(value: unknown) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}$/.test(value) ? value : null;
}

function requireWorkstationId(value: unknown) {
  const workstationId = parsedWorkstationId(value);
  if (!workstationId) throw new Error("workstationId 必须是 UUID");
  return workstationId;
}

function requirePublicBuild(value: unknown) {
  const build = parsedPublicBuild(value);
  if (!build) throw new Error("build 必须是可信的公开构建标识");
  return build;
}

export function normalizeAthleteCode(value: string) {
  return normalizedAthleteCode(value) ?? "";
}

export function normalizeSessionNotes(value: string) {
  const normalized = value.trim().replaceAll(/\r\n?/g, "\n").slice(0, 2_000);
  return normalized || null;
}

function pad(value: number, length = 2) {
  return value.toString().padStart(length, "0");
}

export function toLocalWallClockTimestamp(epochMs: number) {
  const date = new Date(epochMs);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${offset}`;
}

export function toRecordedTelemetrySource(source: TelemetrySource): RecordedTelemetrySource {
  return source === "serial" ? "ground_rc" : "demo";
}

export function createTrainingSessionDraft(options: {
  id: string;
  workstationId: string;
  build: string;
  athleteCode: string;
  source: TelemetrySource;
  startedAtEpochMs: number;
  startedMonotonicMs: number;
}): TrainingSessionDraft {
  return {
    schemaVersion: TRAINING_SESSION_SCHEMA_VERSION,
    id: options.id,
    workstationId: requireWorkstationId(options.workstationId),
    build: requirePublicBuild(options.build),
    athleteCode: normalizeAthleteCode(options.athleteCode),
    startedAt: new Date(options.startedAtEpochMs).toISOString(),
    wallClockStartedAt: toLocalWallClockTimestamp(options.startedAtEpochMs),
    startedMonotonicMs: options.startedMonotonicMs,
    initialSource: toRecordedTelemetrySource(options.source),
    markers: [],
    samples: [],
  };
}

export function appendTrainingSessionSample(
  draft: TrainingSessionDraft,
  telemetry: FlightTelemetry,
  source: TelemetrySource,
) {
  const previous = draft.samples.at(-1);
  const recordedSource = toRecordedTelemetrySource(source);
  if (previous?.sequence === telemetry.sequence && previous.source === recordedSource) return false;

  draft.samples.push({
    elapsedMs: Number((telemetry.monotonicTimestampMs - draft.startedMonotonicMs).toFixed(3)),
    sequence: telemetry.sequence,
    source: recordedSource,
    channelsUs: [...telemetry.rcChannelsUs],
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

export function appendTrainingSessionMarker(
  draft: TrainingSessionDraft,
  options: {
    id: string;
    kind: Exclude<TrainingSessionMarkerKind, "manual">;
    wallClockEpochMs: number;
    monotonicMs: number;
  },
) {
  const marker: TrainingSessionMarker = {
    id: options.id,
    kind: options.kind,
    elapsedMs: Number(Math.max(0, options.monotonicMs - draft.startedMonotonicMs).toFixed(3)),
    wallClockAt: toLocalWallClockTimestamp(options.wallClockEpochMs),
  };
  draft.markers.push(marker);
  return marker;
}

function estimateSampleRate(samples: TrainingSessionSample[]) {
  if (samples.length < 2) return null;
  const elapsedMs = samples.at(-1)!.elapsedMs - samples[0].elapsedMs;
  if (elapsedMs <= 0) return null;
  return Number((((samples.length - 1) * 1000) / elapsedMs).toFixed(2));
}

function finalizeTrainingSession(
  draft: TrainingSessionDraft,
  endedAtEpochMs: number,
  durationMs: number,
  options: FinalizeTrainingSessionOptions,
): TrainingSession {
  const samples = [...draft.samples];
  const sessionWithoutValidity: AssessableTrainingSession = {
    schemaVersion: TRAINING_SESSION_SCHEMA_VERSION,
    id: draft.id,
    workstationId: draft.workstationId,
    build: draft.build,
    athleteCode: normalizeAthleteCode(draft.athleteCode) || null,
    notes: null,
    exportedAt: null,
    exportCount: 0,
    startedAt: draft.startedAt,
    endedAt: new Date(endedAtEpochMs).toISOString(),
    durationMs: Number(Math.max(0, durationMs).toFixed(3)),
    initialSource: draft.initialSource,
    dataSources: [...new Set(samples.map((sample) => sample.source))],
    sampleCount: samples.length,
    estimatedRcSampleRateHz: estimateSampleRate(samples),
    interrupted: options.interrupted ?? options.interruptionReason !== undefined,
    interruptionReason: options.interruptionReason ?? null,
    timing: {
      clock: "performance.now",
      wallClockStartedAt: draft.wallClockStartedAt,
      videoOffsetCalibrated: false,
    },
    video: {
      recorded: false,
      synchronized: false,
    },
    markers: [...draft.markers],
    samples,
  };

  return {
    ...sessionWithoutValidity,
    validity: assessTrainingSession(sessionWithoutValidity),
  };
}

export function finishTrainingSession(
  draft: TrainingSessionDraft,
  endedAtEpochMs: number,
  endedMonotonicMs: number,
  options: FinalizeTrainingSessionOptions = {},
) {
  return finalizeTrainingSession(draft, endedAtEpochMs, endedMonotonicMs - draft.startedMonotonicMs, options);
}

export function recoverInterruptedTrainingSession(draft: TrainingSessionDraft) {
  const durationMs = Math.max(0, draft.samples.at(-1)?.elapsedMs ?? 0);
  const startedAtEpochMs = Date.parse(draft.startedAt);
  return finalizeTrainingSession(draft, startedAtEpochMs + durationMs, durationMs, {
    interrupted: true,
    interruptionReason: "page_closed",
  });
}

export function withTrainingSessionNotes(session: TrainingSession, notes: string): TrainingSession {
  return { ...session, notes: normalizeSessionNotes(notes) };
}

export function markTrainingSessionExported(session: TrainingSession, exportedAtEpochMs: number): TrainingSession {
  return {
    ...session,
    exportedAt: new Date(exportedAtEpochMs).toISOString(),
    exportCount: session.exportCount + 1,
  };
}

function terminationPriority(termination: TrainingSessionTermination) {
  if (termination.interruptionReason === "rx_link_lost") return 3;
  if (termination.interruptionReason !== null || termination.interrupted) return 2;
  return 1;
}

export function resolveTrainingSessionTermination(
  current: TrainingSessionTermination | null,
  next: TrainingSessionTermination,
): TrainingSessionTermination {
  if (!current || terminationPriority(next) > terminationPriority(current)) return next;
  return current;
}

export function withTrainingSessionTermination(
  session: TrainingSession,
  termination: TrainingSessionTermination,
): TrainingSession {
  const resolved = resolveTrainingSessionTermination({
    interrupted: session.interrupted,
    interruptionReason: session.interruptionReason,
  }, termination);
  if (
    resolved.interrupted === session.interrupted &&
    resolved.interruptionReason === session.interruptionReason
  ) {
    return session;
  }
  const updated = {
    ...session,
    interrupted: resolved.interrupted,
    interruptionReason: resolved.interruptionReason,
  };
  return { ...updated, validity: assessTrainingSession(updated) };
}

export function assessTrainingSession(session: AssessableTrainingSession | TrainingSession): TrainingSessionAssessment {
  const reasons: TrainingSessionInvalidReason[] = [];
  const sources = new Set(session.samples.map((sample) => sample.source));
  const uniqueSequences = new Set(session.samples.map((sample) => sample.sequence));
  const timestampsAreStrictlyMonotonic = session.samples.every(
    (sample, index) => index === 0 ? sample.elapsedMs >= 0 : sample.elapsedMs > session.samples[index - 1].elapsedMs,
  );

  if (
    session.initialSource !== "ground_rc" ||
    sources.size === 0 ||
    [...sources].some((source) => source !== "ground_rc")
  ) {
    reasons.push("source_not_ground_rc");
  }
  if (sources.size > 1) reasons.push("mixed_sources");
  if (session.durationMs < MINIMUM_VALID_SESSION_DURATION_MS) reasons.push("too_short");
  if (uniqueSequences.size < MINIMUM_VALID_SESSION_SAMPLES) reasons.push("too_few_unique_samples");
  if (!timestampsAreStrictlyMonotonic) reasons.push("non_monotonic");
  if (!normalizeAthleteCode(session.athleteCode ?? "")) reasons.push("no_athlete_code");
  if (session.interruptionReason === "rx_link_lost") reasons.push("rx_link_lost");
  else if (session.interrupted) reasons.push("interrupted");

  return { valid: reasons.length === 0, reasons };
}

export function assessTrainingAttemptCandidate(session: TrainingSession): TrainingAttemptCandidateAssessment {
  const reasons: TrainingAttemptCandidateReason[] = [];
  if (!session.validity.valid) reasons.push("technically_invalid");
  if (!normalizeSessionNotes(session.notes ?? "")) reasons.push("missing_notes");
  return { candidate: reasons.length === 0, reasons };
}

function channelsFromLegacyRc(rc: TrainingSessionSample["rc"]) {
  return [
    Math.round(1500 + rc.rollStickPercent * 5),
    Math.round(1500 + rc.pitchStickPercent * 5),
    Math.round(1500 + rc.yawStickPercent * 5),
    Math.round(rc.throttleUs),
  ];
}

function parseChannels(value: unknown, field: string) {
  if (!Array.isArray(value) || value.length < 4) throw new Error(`${field} 必须至少包含 4 个通道`);
  return value.map((channel, index) => requireFiniteNumber(channel, `${field}[${index}]`));
}

function parseSample(value: unknown, index: number, legacy: boolean): TrainingSessionSample {
  const sample = requireRecord(value, `samples[${index}]`);
  const rc = requireRecord(sample.rc, `samples[${index}].rc`);
  const groundBridge = requireRecord(sample.groundBridge, `samples[${index}].groundBridge`);
  const parsedRc = {
    rollStickPercent: requireFiniteNumber(rc.rollStickPercent, `samples[${index}].rc.rollStickPercent`),
    pitchStickPercent: requireFiniteNumber(rc.pitchStickPercent, `samples[${index}].rc.pitchStickPercent`),
    yawStickPercent: requireFiniteNumber(rc.yawStickPercent, `samples[${index}].rc.yawStickPercent`),
    throttleStickPercent: requireFiniteNumber(rc.throttleStickPercent, `samples[${index}].rc.throttleStickPercent`),
    throttleUs: requireFiniteNumber(rc.throttleUs, `samples[${index}].rc.throttleUs`),
  };

  return {
    elapsedMs: requireFiniteNumber(sample.elapsedMs, `samples[${index}].elapsedMs`),
    sequence: requireFiniteNumber(sample.sequence, `samples[${index}].sequence`),
    source: requireRecordedSource(sample.source, `samples[${index}].source`),
    channelsUs: legacy ? channelsFromLegacyRc(parsedRc) : parseChannels(sample.channelsUs, `samples[${index}].channelsUs`),
    rc: parsedRc,
    groundBridge: {
      mspRssiPercent: requireNullableFiniteNumber(groundBridge.mspRssiPercent, `samples[${index}].groundBridge.mspRssiPercent`),
      voltage: requireNullableFiniteNumber(groundBridge.voltage, `samples[${index}].groundBridge.voltage`),
    },
  };
}

function parseMarker(value: unknown, index: number): TrainingSessionMarker {
  const marker = requireRecord(value, `markers[${index}]`);
  const kind = marker.kind;
  if (kind !== "manual" && kind !== "crash" && kind !== "gate_hit" && kind !== "clean" && kind !== "throttle") {
    throw new Error(`markers[${index}].kind 不是支持的标记类型`);
  }
  const wallClockAt = requireString(marker.wallClockAt, `markers[${index}].wallClockAt`);
  if (!Number.isFinite(Date.parse(wallClockAt))) throw new Error(`markers[${index}].wallClockAt 不是有效日期`);
  return {
    id: requireString(marker.id, `markers[${index}].id`),
    kind,
    elapsedMs: requireFiniteNumber(marker.elapsedMs, `markers[${index}].elapsedMs`),
    wallClockAt,
  };
}

export function parseTrainingSessionDraft(input: string | unknown): TrainingSessionDraft {
  const parsed = typeof input === "string" ? JSON.parse(input) : input;
  const raw = requireRecord(parsed, "draft");
  if (raw.schemaVersion !== TRAINING_SESSION_SCHEMA_VERSION) {
    throw new Error(`不支持的草稿 schemaVersion: ${String(raw.schemaVersion)}`);
  }
  if (!Array.isArray(raw.samples)) throw new Error("samples 必须是数组");
  if (!Array.isArray(raw.markers)) throw new Error("markers 必须是数组");
  const startedAt = requireString(raw.startedAt, "startedAt");
  const wallClockStartedAt = requireString(raw.wallClockStartedAt, "wallClockStartedAt");
  if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(wallClockStartedAt))) {
    throw new Error("草稿时间字段不是有效日期");
  }

  return {
    schemaVersion: TRAINING_SESSION_SCHEMA_VERSION,
    id: requireString(raw.id, "id"),
    workstationId: parsedWorkstationId(raw.workstationId),
    build: parsedPublicBuild(raw.build),
    athleteCode: normalizeAthleteCode(requireString(raw.athleteCode, "athleteCode")),
    startedAt,
    wallClockStartedAt,
    startedMonotonicMs: requireFiniteNumber(raw.startedMonotonicMs, "startedMonotonicMs"),
    initialSource: requireRecordedSource(raw.initialSource, "initialSource"),
    markers: raw.markers.map(parseMarker),
    samples: raw.samples.map((sample, index) => parseSample(sample, index, false)),
  };
}

export function parseTrainingSession(input: string | unknown): TrainingSession {
  const parsed = typeof input === "string" ? JSON.parse(input) : input;
  const raw = requireRecord(parsed, "session");
  const schemaVersion = requireFiniteNumber(raw.schemaVersion, "schemaVersion");
  if (schemaVersion !== 1 && schemaVersion !== TRAINING_SESSION_SCHEMA_VERSION) {
    throw new Error(`不支持的 Session schemaVersion: ${schemaVersion}`);
  }
  if (!Array.isArray(raw.samples)) throw new Error("samples 必须是数组");

  const samples = raw.samples.map((sample, index) => parseSample(sample, index, schemaVersion === 1));
  const startedAt = requireString(raw.startedAt, "startedAt");
  const endedAt = requireString(raw.endedAt, "endedAt");
  if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(endedAt))) {
    throw new Error("Session 时间字段不是有效日期");
  }

  const timing = schemaVersion === 1 ? null : requireRecord(raw.timing, "timing");
  const wallClockStartedAt = schemaVersion === 1
    ? toLocalWallClockTimestamp(Date.parse(startedAt))
    : requireString(timing!.wallClockStartedAt, "timing.wallClockStartedAt");
  if (!Number.isFinite(Date.parse(wallClockStartedAt))) {
    throw new Error("timing.wallClockStartedAt 不是有效日期");
  }

  const markers = schemaVersion === 1
    ? []
    : Array.isArray(raw.markers)
      ? raw.markers.map(parseMarker)
      : (() => { throw new Error("markers 必须是数组"); })();
  const athleteCode = schemaVersion === 1 ? null : normalizedAthleteCode(raw.athleteCode);
  const notes = schemaVersion === 1 || raw.notes === null || raw.notes === undefined
    ? null
    : normalizeSessionNotes(requireString(raw.notes, "notes"));
  const exportedAt = schemaVersion === 1 || raw.exportedAt === null || raw.exportedAt === undefined
    ? null
    : requireString(raw.exportedAt, "exportedAt");
  if (exportedAt !== null && !Number.isFinite(Date.parse(exportedAt))) {
    throw new Error("exportedAt 不是有效日期");
  }
  const exportCount = schemaVersion === 1 || raw.exportCount === undefined
    ? 0
    : requireFiniteNumber(raw.exportCount, "exportCount");
  if (!Number.isInteger(exportCount) || exportCount < 0) throw new Error("exportCount 必须是非负整数");
  const interruptionReason = schemaVersion === 1 ? null : optionalInterruptionReason(raw.interruptionReason);
  if ((exportedAt === null) !== (exportCount === 0)) {
    throw new Error("exportedAt 与 exportCount 不一致");
  }
  const sessionWithoutValidity: AssessableTrainingSession = {
    schemaVersion: TRAINING_SESSION_SCHEMA_VERSION,
    ...(schemaVersion === 1 || raw.migratedFromSchemaVersion === 1 ? { migratedFromSchemaVersion: 1 as const } : {}),
    id: requireString(raw.id, "id"),
    workstationId: schemaVersion === 1 ? null : parsedWorkstationId(raw.workstationId),
    build: schemaVersion === 1 ? null : parsedPublicBuild(raw.build),
    athleteCode,
    notes,
    exportedAt,
    exportCount,
    startedAt,
    endedAt,
    durationMs: Math.max(0, requireFiniteNumber(raw.durationMs, "durationMs")),
    initialSource: requireRecordedSource(raw.initialSource, "initialSource"),
    dataSources: [...new Set(samples.map((sample) => sample.source))],
    sampleCount: samples.length,
    estimatedRcSampleRateHz: estimateSampleRate(samples),
    interrupted: schemaVersion === 1 ? false : raw.interrupted === true || interruptionReason !== null,
    interruptionReason,
    timing: {
      clock: "performance.now",
      wallClockStartedAt,
      videoOffsetCalibrated: false,
    },
    video: {
      recorded: false,
      synchronized: false,
    },
    markers,
    samples,
  };

  return {
    ...sessionWithoutValidity,
    validity: assessTrainingSession(sessionWithoutValidity),
  };
}

export function serializeTrainingSession(session: TrainingSession) {
  return `${JSON.stringify(session)}\n`;
}

function safeFilenameSegment(value: string) {
  return value.trim().replaceAll(/[\\/:*?"<>|\s]+/g, "-").replaceAll(/^-+|-+$/g, "").slice(0, 40) || "unknown-pilot";
}

export function trainingSessionFilename(session: TrainingSession) {
  const timestamp = new Date(session.startedAt);
  const localTimestamp = `${timestamp.getFullYear()}${pad(timestamp.getMonth() + 1)}${pad(timestamp.getDate())}-${pad(timestamp.getHours())}${pad(timestamp.getMinutes())}${pad(timestamp.getSeconds())}`;
  const shortId = session.id.startsWith("session-") ? session.id.slice(8, 16) : session.id.slice(0, 8);
  const prefix = session.initialSource === "demo" ? "demo-session" : "fpv-session";
  return `${prefix}-${localTimestamp}-${safeFilenameSegment(session.athleteCode ?? "")}-${shortId}.json`;
}
