import type { SerialErrorCode, VideoCaptureErrorCode } from "@/lib/hardware-errors";
import type {
  ConnectionState,
  LinkState,
  MspParserQuality,
  TelemetrySource,
} from "@/lib/telemetry";

export const LOCAL_DIAGNOSTIC_SCHEMA_VERSION = 1;
export const MAX_DIAGNOSTIC_TRANSITIONS = 200;
export const RAW_SERIAL_CAPTURE_DURATION_MS = 60_000;
export const RAW_SERIAL_CAPTURE_MAX_BYTES = 8 * 1024 * 1024;

export type DiagnosticVideoState = "idle" | "connecting" | "live" | "error";

export interface LocalDiagnosticSnapshot {
  connection: ConnectionState;
  source: TelemetrySource;
  linkState: LinkState;
  videoState: DiagnosticVideoState;
  isRecording: boolean;
  parserQuality: MspParserQuality;
  serialErrorCode: SerialErrorCode | null;
  videoErrorCode: VideoCaptureErrorCode | null;
  storageReady: boolean;
  storageHasError: boolean;
}

export interface LocalDiagnosticTransition extends LocalDiagnosticSnapshot {
  at: string;
}

export interface LocalDiagnosticEnvironment {
  secureContext: boolean;
  online: boolean;
  serialSupported: boolean;
  mediaSupported: boolean;
  indexedDbSupported: boolean;
  directoryPickerSupported: boolean;
  fullscreenSupported: boolean;
  wakeLockSupported: boolean;
}

export interface LocalDiagnosticBundle {
  schemaVersion: typeof LOCAL_DIAGNOSTIC_SCHEMA_VERSION;
  createdAt: string;
  build: string;
  privacy: {
    localOnly: true;
    includesRawSerialBytes: false;
    excludes: readonly ["video", "athlete_code", "session_notes", "raw_rc_samples", "device_names"];
  };
  environment: LocalDiagnosticEnvironment;
  transitions: LocalDiagnosticTransition[];
}

export interface RawSerialCaptureBuffer {
  startedAt: string;
  chunks: Uint8Array[];
  byteLength: number;
  truncated: boolean;
}

function snapshotKey(snapshot: LocalDiagnosticSnapshot) {
  return JSON.stringify({
    connection: snapshot.connection,
    source: snapshot.source,
    linkState: snapshot.linkState,
    videoState: snapshot.videoState,
    isRecording: snapshot.isRecording,
    parserQuality: snapshot.parserQuality,
    serialErrorCode: snapshot.serialErrorCode,
    videoErrorCode: snapshot.videoErrorCode,
    storageReady: snapshot.storageReady,
    storageHasError: snapshot.storageHasError,
  });
}

export function appendDiagnosticTransition(
  current: readonly LocalDiagnosticTransition[],
  snapshot: LocalDiagnosticSnapshot,
  at = new Date().toISOString(),
) {
  const previous = current.at(-1);
  if (previous && snapshotKey(previous) === snapshotKey(snapshot)) return [...current];
  return [...current, { ...snapshot, at }].slice(-MAX_DIAGNOSTIC_TRANSITIONS);
}

export function buildLocalDiagnosticBundle(options: {
  createdAt?: string;
  build: string;
  environment: LocalDiagnosticEnvironment;
  transitions: readonly LocalDiagnosticTransition[];
}): LocalDiagnosticBundle {
  return {
    schemaVersion: LOCAL_DIAGNOSTIC_SCHEMA_VERSION,
    createdAt: options.createdAt ?? new Date().toISOString(),
    build: options.build,
    privacy: {
      localOnly: true,
      includesRawSerialBytes: false,
      excludes: ["video", "athlete_code", "session_notes", "raw_rc_samples", "device_names"],
    },
    environment: { ...options.environment },
    transitions: options.transitions.slice(-MAX_DIAGNOSTIC_TRANSITIONS).map((transition) => ({ ...transition })),
  };
}

function safeTimestamp(isoTimestamp: string) {
  return isoTimestamp.replace(/[:.]/g, "-");
}

export function diagnosticBundleFilename(createdAt: string) {
  return `fpvhelper-diagnostics-${safeTimestamp(createdAt)}.json`;
}

export function rawSerialCaptureFilename(startedAt: string) {
  return `fpvhelper-msp-raw-${safeTimestamp(startedAt)}.bin`;
}

export function createRawSerialCaptureBuffer(startedAt = new Date().toISOString()): RawSerialCaptureBuffer {
  return { startedAt, chunks: [], byteLength: 0, truncated: false };
}

export function appendRawSerialCaptureChunk(
  capture: RawSerialCaptureBuffer,
  chunk: Uint8Array,
  maximumBytes = RAW_SERIAL_CAPTURE_MAX_BYTES,
) {
  if (capture.truncated || capture.byteLength >= maximumBytes || chunk.byteLength === 0) return capture;
  const remaining = maximumBytes - capture.byteLength;
  const accepted = chunk.slice(0, remaining);
  return {
    ...capture,
    chunks: [...capture.chunks, accepted],
    byteLength: capture.byteLength + accepted.byteLength,
    truncated: accepted.byteLength < chunk.byteLength || accepted.byteLength === remaining,
  };
}

export function createRawSerialCaptureBlob(capture: RawSerialCaptureBuffer) {
  return new Blob(capture.chunks.map((chunk) => chunk.slice().buffer), {
    type: "application/octet-stream",
  });
}

export function downloadLocalFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export function downloadLocalDiagnosticBundle(bundle: LocalDiagnosticBundle) {
  downloadLocalFile(
    new Blob([`${JSON.stringify(bundle, null, 2)}\n`], { type: "application/json" }),
    diagnosticBundleFilename(bundle.createdAt),
  );
}
