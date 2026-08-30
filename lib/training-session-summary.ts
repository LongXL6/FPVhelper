import {
  MINIMUM_VALID_SESSION_DURATION_MS,
  MINIMUM_VALID_SESSION_SAMPLES,
  toLocalWallClockTimestamp,
  type TrainingSession,
  type TrainingSessionMarkerKind,
  type TrainingSessionSample,
} from "./training-session";

export const TRAINING_MARKER_LABELS: Record<Exclude<TrainingSessionMarkerKind, "manual">, string> = {
  crash: "炸机",
  gate_hit: "撞门",
  clean: "漂亮",
  throttle: "油门过猛",
};

export function countUniqueTrainingSamples(samples: TrainingSessionSample[]) {
  return new Set(samples.map((sample) => sample.sequence)).size;
}

export function trainingSessionProgress(elapsedMs: number, uniqueSampleCount: number) {
  const remainingDurationMs = Math.max(0, MINIMUM_VALID_SESSION_DURATION_MS - Math.max(0, elapsedMs));
  const remainingUniqueSamples = Math.max(0, MINIMUM_VALID_SESSION_SAMPLES - Math.max(0, uniqueSampleCount));
  return {
    remainingDurationMs,
    remainingUniqueSamples,
    thresholdReached: remainingDurationMs === 0 && remainingUniqueSamples === 0,
  };
}

export function shouldWarnBeforeTrainingExit(options: {
  isRecording: boolean;
  hasPendingSave: boolean;
  unexportedValidCount: number;
}) {
  return options.isRecording || options.hasPendingSave || options.unexportedValidCount > 0;
}

export function sessionsStartedOnLocalDay(sessions: TrainingSession[], epochMs: number) {
  const localDay = toLocalWallClockTimestamp(epochMs).slice(0, 10);
  return sessions.filter((session) => session.timing.wallClockStartedAt.slice(0, 10) === localDay);
}

function formatElapsed(elapsedMs: number) {
  const safeElapsedMs = Math.max(0, elapsedMs);
  const minutes = Math.floor(safeElapsedMs / 60_000);
  const seconds = Math.floor((safeElapsedMs % 60_000) / 1_000);
  const milliseconds = Math.floor(safeElapsedMs % 1_000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

export function formatDvrReviewChecklist(session: TrainingSession) {
  const header = `DVR 复盘清单 · ${session.athleteCode ?? "未填写代号"}\n人工标记，仅用于定位画面；不是自动计圈或正式计时。`;
  if (session.markers.length === 0) return `${header}\n- [ ] 无人工标记`;

  const items = session.markers.map((marker) => {
    const label = marker.kind === "manual" ? "人工标记" : TRAINING_MARKER_LABELS[marker.kind];
    const localWallClock = marker.wallClockAt.slice(11, 23);
    return `- [ ] ${formatElapsed(marker.elapsedMs)} · ${label} · 本地 ${localWallClock}`;
  });
  return `${header}\n${items.join("\n")}`;
}
