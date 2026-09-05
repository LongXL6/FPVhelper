import type { TrainingSession } from "./training-session";

/** List entries deliberately exclude high-frequency samples. */
export type TrainingSessionSummary = Omit<TrainingSession, "samples">;

export function toTrainingSessionSummary(session: TrainingSession): TrainingSessionSummary {
  const { samples: _samples, ...summary } = session;
  void _samples;
  return summary;
}
