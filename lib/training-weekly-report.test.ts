import { describe, expect, it } from "vitest";
import type { TrainingSession, TrainingSessionInvalidReason } from "./training-session";
import {
  buildTrainingWeeklyReport,
  formatTrainingWeeklyReportMarkdown,
  mergeTrainingSessions,
  TRAINING_REPORT_WINDOW_MS,
} from "./training-weekly-report";

const WINDOW_START = Date.parse("2026-08-31T00:00:00.000Z");

function session(overrides: Partial<TrainingSession> & Pick<TrainingSession, "id">): TrainingSession {
  const reasons = overrides.validity?.reasons ?? [];
  const { id, ...rest } = overrides;
  return {
    schemaVersion: 2,
    id,
    workstationId: "10000000-0000-4000-8000-000000000001",
    build: "test",
    athleteCode: "PILOT-01",
    notes: "复盘完成",
    exportedAt: "2026-08-31T00:02:00.000Z",
    exportCount: 1,
    startedAt: "2026-08-31T00:00:00.000Z",
    endedAt: "2026-08-31T00:01:00.000Z",
    durationMs: 60_000,
    initialSource: "ground_rc",
    dataSources: ["ground_rc"],
    sampleCount: 300,
    estimatedRcSampleRateHz: 5,
    interrupted: false,
    validity: { valid: reasons.length === 0, reasons },
    timing: { clock: "performance.now", wallClockStartedAt: "2026-08-31T08:00:00.000+08:00", videoOffsetCalibrated: false },
    video: { recorded: false, synchronized: false },
    markers: [],
    samples: [],
    ...rest,
  };
}

describe("training weekly report", () => {
  it("merges two workstations and reports acceptance coverage", () => {
    const invalidReason: TrainingSessionInvalidReason = "too_short";
    const report = buildTrainingWeeklyReport([
      session({ id: "valid", markers: [{ id: "m1", kind: "clean", elapsedMs: 1_000, wallClockAt: "2026-08-31T08:00:01.000+08:00" }] }),
      session({
        id: "invalid",
        workstationId: "20000000-0000-4000-8000-000000000002",
        athleteCode: "PILOT-02",
        notes: null,
        exportedAt: null,
        exportCount: 0,
        durationMs: 20_000,
        validity: { valid: false, reasons: [invalidReason] },
      }),
    ], WINDOW_START);

    expect(report).toMatchObject({
      workstationCount: 2,
      athleteCount: 2,
      attemptCount: 2,
      validCount: 1,
      validCoveragePercent: 50,
      exportedCount: 1,
      exportCoveragePercent: 50,
      attemptCandidateCount: 1,
      markerCount: 1,
    });
    expect(report.invalidReasonCounts.too_short).toBe(1);
    expect(report.markerCounts.clean).toBe(1);
  });

  it("deduplicates identical IDs and excludes conflicting payloads", () => {
    const original = session({ id: "same" });
    expect(mergeTrainingSessions([original, original])).toMatchObject({ duplicateCount: 1, conflictingSessionIds: [] });

    const merged = mergeTrainingSessions([original, session({ id: "same", notes: "另一份内容" })]);
    expect(merged.sessions).toEqual([]);
    expect(merged.conflictingSessionIds).toEqual(["same"]);
  });

  it("uses a half-open seven-day window and excludes demo records", () => {
    const report = buildTrainingWeeklyReport([
      session({ id: "inside", startedAt: new Date(WINDOW_START).toISOString() }),
      session({ id: "outside", startedAt: new Date(WINDOW_START + TRAINING_REPORT_WINDOW_MS).toISOString() }),
      session({ id: "demo", initialSource: "demo", dataSources: ["demo"] }),
    ], WINDOW_START);

    expect(report.attemptCount).toBe(1);
  });

  it("states that operational evidence is not athlete improvement", () => {
    const markdown = formatTrainingWeeklyReportMarkdown(buildTrainingWeeklyReport([], WINDOW_START));
    expect(markdown).toContain("不证明运动员能力提升");
    expect(markdown).toContain("—（无尝试）");
  });
});
