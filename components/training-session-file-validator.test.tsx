import { describe, expect, it } from "vitest";
import { EMPTY_TELEMETRY } from "../lib/telemetry";
import {
  appendTrainingSessionSample,
  createTrainingSessionDraft,
  finishTrainingSession,
  serializeTrainingSession,
  withTrainingSessionNotes,
} from "../lib/training-session";
import { inspectTrainingSessionJson } from "./training-session-file-validator";

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
  it("shows technical validity separately from pilot-ledger completeness", () => {
    const withoutReview = inspectTrainingSessionJson(validSessionJson());
    expect(withoutReview.technicalValidityLabel).toBe("有效");
    expect(withoutReview.pilotLedgerLabel).toBe("不完整");

    const reviewed = inspectTrainingSessionJson(validSessionJson("练习目标和复盘结论"));
    expect(reviewed.technicalValidityLabel).toBe("有效");
    expect(reviewed.pilotLedgerLabel).toBe("完整");
  });

  it("uses parseTrainingSession validation and rejects unrelated JSON", () => {
    expect(() => inspectTrainingSessionJson('{"schemaVersion":2,"id":"not-a-session"}')).toThrow("samples 必须是数组");
  });
});
