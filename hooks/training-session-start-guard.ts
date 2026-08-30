import type { TrainingSessionStorageIntegrity } from "../lib/training-session-store";
import { normalizeAthleteCode } from "../lib/training-session";
import type { ConnectionState, TelemetrySource } from "../lib/telemetry";

interface TrainingSessionStartState {
  storageReady: boolean;
  storageError: string | null;
  storageIntegrity: TrainingSessionStorageIntegrity;
  hasPendingSave: boolean;
  isRecording: boolean;
  isStarting: boolean;
  isFinishing: boolean;
  source: TelemetrySource;
  connection: ConnectionState;
  athleteCode: string;
}

export function canStartTrainingSession({
  storageReady,
  storageError,
  hasPendingSave,
  isRecording,
  isStarting,
  isFinishing,
  source,
  connection,
  athleteCode,
}: TrainingSessionStartState) {
  return storageReady &&
    storageError === null &&
    !hasPendingSave &&
    !isRecording &&
    !isStarting &&
    !isFinishing &&
    source === "serial" &&
    connection === "live" &&
    normalizeAthleteCode(athleteCode).length > 0;
}
