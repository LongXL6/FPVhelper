import { describe, expect, it } from "vitest";
import { canStartTrainingSession } from "./training-session-start-guard";

describe("useTrainingSession start guard", () => {
  it("keeps new training available when unreadable records are quarantined", () => {
    expect(canStartTrainingSession({
      storageReady: true,
      storageError: null,
      storageIntegrity: {
        readableDraftCount: 0,
        readableSessionCount: 4,
        quarantinedDraftCount: 1,
        quarantinedSessionCount: 2,
      },
      hasPendingSave: false,
      isRecording: false,
      isStarting: false,
      isFinishing: false,
      source: "serial",
      connection: "live",
      athleteCode: "PILOT-07",
    })).toBe(true);
  });

  it("still blocks actual storage failures", () => {
    expect(canStartTrainingSession({
      storageReady: true,
      storageError: "IndexedDB transaction failed",
      storageIntegrity: {
        readableDraftCount: 0,
        readableSessionCount: 0,
        quarantinedDraftCount: 0,
        quarantinedSessionCount: 0,
      },
      hasPendingSave: false,
      isRecording: false,
      isStarting: false,
      isFinishing: false,
      source: "serial",
      connection: "live",
      athleteCode: "PILOT-07",
    })).toBe(false);
  });
});
