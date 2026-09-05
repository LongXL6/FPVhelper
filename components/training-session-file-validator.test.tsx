import { describe, expect, it } from "vitest";
import { EMPTY_TELEMETRY } from "../lib/telemetry";
import {
  appendTrainingSessionSample,
  createTrainingSessionDraft,
  finishTrainingSession,
  serializeTrainingSession,
  withTrainingSessionNotes,
} from "../lib/training-session";
import {
  inspectTrainingSessionJson,
  MAX_TRAINING_SESSION_FILE_BYTES,
  trainingSessionFileSizeError,
} from "./training-session-file-validator";

function validSessionJson(notes = "") {
  const draft = createTrainingSessionDraft({
    id: "session-file-check",
    workstationId: "10000000-0000-4000-8000-000000000001",
    build: "0.2.0+1234567",
    athleteCode: "PILOT-31",
    source: "serial",
    startedAtEpochMs: 1_700_000_000_000,
    startedMonotonicMs: 1_000,
  });
  for (let sequence = 1; sequence <= 300; sequence += 1) {
    appendTrainingSessionSample(draft, {
      ...EMPTY_TELEMETRY,
      monotonicTimestampMs: 1_000 + sequence * 200,
      sequence,
      rcChannelsUs: [1500, 1500, 1500, 1200],
    }, "serial");
  }
  const session = finishTrainingSession(draft, 1_700_000_060_000, 61_000);
  return serializeTrainingSession(notes ? withTrainingSessionNotes(session, notes) : session);
}

describe("read-only Session JSON inspection", () => {
  it("shows technical validity separately from the 80 percent attempt candidate", () => {
    const withoutReview = inspectTrainingSessionJson(validSessionJson());
    expect(withoutReview.technicalValidityLabel).toBe("有效");
    expect(withoutReview.attemptCandidateLabel).toBe("不满足");

    const reviewed = inspectTrainingSessionJson(validSessionJson("练习目标和复盘结论"));
    expect(reviewed.technicalValidityLabel).toBe("有效");
    expect(reviewed.attemptCandidateLabel).toBe("满足基础条件");
  });

  it("rejects oversized files before reading their text", () => {
    expect(trainingSessionFileSizeError(MAX_TRAINING_SESSION_FILE_BYTES)).toBeNull();
    expect(trainingSessionFileSizeError(MAX_TRAINING_SESSION_FILE_BYTES + 1)).toContain("超过 16 MB");
  });

  it("uses parseTrainingSession validation and rejects unrelated JSON", () => {
    expect(() => inspectTrainingSessionJson('{"schemaVersion":2,"id":"not-a-session"}')).toThrow("samples 必须是数组");
  });
});
