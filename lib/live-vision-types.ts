import type { LiveVisionDiagnostics, LiveVisionObservationDiagnostics } from "./live-vision-diagnostics";
import type { VisionCandidate, VisionGap, VisionGateProfile, VisionLap, VisionProfileSummary, VisionRect, VisionResolvedEvent, VisionReview } from "./vision-lab-types";

export const LIVE_VISION_MAX_DURATION_MS = 30 * 60_000;
export const LIVE_VISION_SAMPLE_FPS = 30;
export const LIVE_VISION_MAX_OBSERVATION_GAP_MS = 1500;
export const LIVE_VISION_EXIT_DELAY_MS = 150;
export const LIVE_VISION_MAX_JSON_BYTES = 64 * 1024 ** 2;

export interface LiveVisionOptions {
  stream: MediaStream | null;
  sourceId: string | null;
  pilotChannelId: string | null;
  pilotName: string;
  /** Resolved source crop, normalized from zero to one. */
  crop: VisionRect;
  profileId: string | null;
  trainingSessionId?: string | null;
  similarityThreshold?: number;
  sampleFps?: number;
}

export interface LiveVisionSource {
  sourceId: string;
  pilotChannelId: string;
  pilotName: string;
  streamId: string;
  videoTrackId: string;
  width: number;
  height: number;
  crop: VisionRect;
  trainingSessionId: string | null;
}

export interface LiveVisionObservation {
  timeMs: number;
  hostObservedAtMs: number;
  method: "video_frame_callback" | "current_time_poll";
  callback: {
    mediaTimeSeconds: number | null;
    presentedFrames: number | null;
    presentationTimeMs: number | null;
    expectedDisplayTimeMs: number | null;
  } | null;
  inferenceMs: number;
  diagnostics?: LiveVisionObservationDiagnostics;
}

export interface LiveVisionRun {
  schemaVersion: 1;
  kind: "fpvhelper-live-vision";
  pipelineVersion: "reference-motion-v1" | "reference-motion-v2";
  provenance: "local" | "imported";
  id: string;
  createdAt: string;
  source: LiveVisionSource;
  profile: Omit<VisionGateProfile, "image">;
  model: { id: string; revision: string; weightsSha256: string; backend: string };
  clock: {
    kind: "host_presentation_estimate";
    timeOriginEpochMs: number;
    startedAtPerformanceMs: number;
    startedAtEpochMs: number;
    physicalCaptureTimeKnown: false;
    trainingSynchronized: false;
  };
  settings: { sampleFps: number; similarityThreshold: number; maxDurationMs: number; maxObservationGapMs?: number; exitDelayMs?: number };
  state: "starting" | "monitoring" | "stopped" | "interrupted" | "failed";
  endedAtEpochMs: number | null;
  elapsedMs: number;
  analyzedUntilMs: number;
  stopReason: string | null;
  observations: LiveVisionObservation[];
  candidates: VisionCandidate[];
  reviews: VisionReview[];
  gaps: VisionGap[];
}

export interface LiveVisionRunSummary {
  id: string;
  createdAt: string;
  pilotName: string;
  gateName: string;
  state: LiveVisionRun["state"];
  elapsedMs: number;
}

export interface LiveVisionController {
  state: "idle" | "loading" | "monitoring" | "stopped" | "interrupted" | "error";
  isActive: boolean;
  hasUnsavedChanges: boolean;
  backupAwaitingConfirmation: boolean;
  canStart: boolean;
  elapsedMs: number;
  progress: { analyzedFrames: number; inferenceMs: number | null; message: string };
  diagnostics: LiveVisionDiagnostics | null;
  attachDiagnosticCanvas(canvas: HTMLCanvasElement | null): void;
  exportDiagnostics(): Promise<void>;
  error: string | null;
  notice: string | null;
  profile: VisionGateProfile | null;
  profiles: VisionProfileSummary[];
  run: LiveVisionRun | null;
  events: VisionResolvedEvent[];
  laps: VisionLap[];
  savedRuns: LiveVisionRunSummary[];
  start(): Promise<void>;
  stop(): Promise<void>;
  getCurrentTimeMs(): number;
  acknowledgeBackup(): void;
  reviewEvent(eventId: string, action: "confirm" | "reject" | "adjust", timeMs: number, reason: string): Promise<void>;
  addEvent(timeMs: number, reason: string): Promise<void>;
  refreshProfiles(): Promise<void>;
  saveReference(input: { image: Blob; name: string; rect: VisionRect }): Promise<string>;
  captureReference(): Promise<Blob>;
  importProfile(file: File): Promise<string>;
  saveRun(): Promise<void>;
  loadRun(id: string): Promise<void>;
  exportRun(format: "json" | "csv"): Promise<void>;
  importRun(file: File): Promise<void>;
}
