import type { TrainingSessionStorageIntegrity } from "../lib/training-session-store";
import { normalizeAthleteCode } from "../lib/training-session";
import type { ConnectionState, LinkState, TelemetrySource } from "../lib/telemetry";

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
  linkState: LinkState;
  athleteCode: string;
}

export function canStartTrainingSession({
  storageReady,
  storageError,
  storageIntegrity,
  hasPendingSave,
  isRecording,
  isStarting,
  isFinishing,
  source,
  connection,
  linkState,
  athleteCode,
}: TrainingSessionStartState) {
  return storageReady &&
    storageError === null &&
    !storageIntegrity.migrationWarning &&
    !hasPendingSave &&
    !isRecording &&
    !isStarting &&
    !isFinishing &&
    source === "serial" &&
    connection === "live" &&
    linkState === "ok" &&
    normalizeAthleteCode(athleteCode).length > 0;
}
