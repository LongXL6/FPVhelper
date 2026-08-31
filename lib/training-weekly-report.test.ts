import { describe, expect, it } from "vitest";
import { parseTrainingSession, type TrainingSession, type TrainingSessionInvalidReason } from "./training-session";
import {
  buildTrainingWeeklyReport,
  formatTrainingWeeklyReportMarkdown,
  MAX_REPORT_FILE_BYTES,
  MAX_REPORT_FILES,
  MAX_REPORT_TOTAL_BYTES,
  mergeTrainingSessions,
  trainingReportWindowEndEpochMs,
  type TrainingWeeklyReportSessionInput,
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

function reportInput(
  value: TrainingSession,
  source: TrainingWeeklyReportSessionInput["source"] = "browser-local",
): TrainingWeeklyReportSessionInput {
  return { session: value, source };
}

function build(
  sessions: TrainingWeeklyReportSessionInput[],
  intendedRecordings?: number,
  windowStartedAtEpochMs = WINDOW_START,
) {
  return buildTrainingWeeklyReport({ sessions, intendedRecordings, windowStartedAtEpochMs });
}

describe("training weekly report", () => {
  it("keeps commercial coverage unavailable when the independent intent ledger is missing", () => {
    const invalidReason: TrainingSessionInvalidReason = "too_short";
    const report = build([
      reportInput(session({ id: "valid", markers: [{ id: "m1", kind: "clean", elapsedMs: 1_000, wallClockAt: "2026-08-31T08:00:01.000+08:00" }] })),
      reportInput(session({
        id: "invalid",
        workstationId: "20000000-0000-4000-8000-000000000002",
        athleteCode: "PILOT-02",
        notes: null,
        exportedAt: null,
        exportCount: 0,
        durationMs: 20_000,
        validity: { valid: false, reasons: [invalidReason] },
      })),
    ]);

    expect(report).toMatchObject({
      workstationCount: 2,
      athleteCount: 2,
      intendedRecordings: null,
      completedSessionCount: 2,
      validCount: 1,
      validCoveragePercent: null,
      confirmedFileCount: 1,
      exportCoveragePercent: null,
      attemptCandidateCount: 1,
      markerCount: 1,
    });
    expect(report.invalidReasonCounts.too_short).toBe(1);
    expect(report.markerCounts.clean).toBe(1);
    expect(formatTrainingWeeklyReportMarkdown(report)).toContain("— 待台账");
  });

  it("uses intended recordings, including failed attempts without a completed session, as the denominator", () => {
    const report = build([
      reportInput(session({ id: "valid" })),
      reportInput(session({ id: "invalid", validity: { valid: false, reasons: ["too_short"] }, exportedAt: null, exportCount: 0 })),
    ], 3);

    expect(report.completedSessionCount).toBe(2);
    expect(report.validCoveragePercent).toBe(33.3);
    expect(report.exportCoveragePercent).toBe(33.3);
  });

  it("deduplicates identical IDs, preserves imported-file evidence and excludes conflicting payloads", () => {
    const original = session({ id: "same" });
    const duplicate = mergeTrainingSessions([
      reportInput(original),
      reportInput(original, "imported-file"),
    ]);
    expect(duplicate).toMatchObject({ duplicateCount: 1, conflictingSessionIds: [] });
    expect(duplicate.sessions[0].source).toBe("imported-file");

    const merged = mergeTrainingSessions([
      reportInput(original),
      reportInput(session({ id: "same", notes: "另一份内容" }), "imported-file"),
    ]);
    expect(merged.sessions).toEqual([]);
    expect(merged.conflictingSessionIds).toEqual(["same"]);
  });

  it("uses imported files as reparse evidence and only trusts consistent browser self-reporting", () => {
    const report = build([
      reportInput(session({ id: "imported-fallback", exportedAt: null, exportCount: 0 }), "imported-file"),
      reportInput(session({ id: "browser-confirmed" })),
      reportInput(session({ id: "browser-unconfirmed", exportedAt: null, exportCount: 0 })),
      reportInput(session({ id: "browser-inconsistent", exportedAt: null, exportCount: 2 })),
    ], 4);

    expect(report.confirmedFileCount).toBe(2);
    expect(report.exportCoveragePercent).toBe(50);
  });

  it("counts reparsed schema-v1 and fallback-download imports as confirmed file evidence", () => {
    const migratedV1 = parseTrainingSession({
      schemaVersion: 1,
      id: "legacy-import",
      startedAt: new Date(WINDOW_START).toISOString(),
      endedAt: new Date(WINDOW_START + 1_000).toISOString(),
      durationMs: 1_000,
      initialSource: "ground_rc",
      samples: [{
        elapsedMs: 100,
        sequence: 1,
        source: "ground_rc",
        rc: { rollStickPercent: 0, pitchStickPercent: 0, yawStickPercent: 0, throttleStickPercent: 50, throttleUs: 1500 },
        groundBridge: { mspRssiPercent: null, voltage: null },
      }],
    });
    const fallbackV2 = session({ id: "fallback-import", exportedAt: null, exportCount: 0 });

    const report = build([
      reportInput(migratedV1, "imported-file"),
      reportInput(fallbackV2, "imported-file"),
    ], 2);

    expect(migratedV1).toMatchObject({ migratedFromSchemaVersion: 1, exportedAt: null, exportCount: 0 });
    expect(report.confirmedFileCount).toBe(2);
    expect(report.exportCoveragePercent).toBe(100);
  });

  it("uses a half-open local-calendar week and excludes demo records", () => {
    const windowEnd = trainingReportWindowEndEpochMs(WINDOW_START);
    const report = build([
      reportInput(session({ id: "inside", startedAt: new Date(WINDOW_START).toISOString() })),
      reportInput(session({ id: "outside", startedAt: new Date(windowEnd).toISOString() })),
      reportInput(session({ id: "demo", initialSource: "demo", dataSources: ["demo"] })),
    ]);

    expect(report.completedSessionCount).toBe(1);
  });

  it("filters to the week before duplicate and conflict accounting", () => {
    const report = build([
      reportInput(session({ id: "reused-id", startedAt: new Date(WINDOW_START).toISOString() })),
      reportInput(session({
        id: "reused-id",
        notes: "下一周内容不同",
        startedAt: new Date(trainingReportWindowEndEpochMs(WINDOW_START)).toISOString(),
      }), "imported-file"),
    ]);

    expect(report.completedSessionCount).toBe(1);
    expect(report.duplicateCount).toBe(0);
    expect(report.conflictingSessionIds).toEqual([]);
  });

  it("uses local calendar arithmetic and emits local offsets across DST", () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const localStart = new Date(2026, 2, 2, 0, 0, 0, 0).getTime();
      const report = build([], undefined, localStart);
      const markdown = formatTrainingWeeklyReportMarkdown(report);

      expect(Date.parse(report.windowEndedAt) - Date.parse(report.windowStartedAt)).toBe(167 * 60 * 60 * 1_000);
      expect(report.windowStartedAt).toBe("2026-03-02T00:00:00.000-05:00");
      expect(report.windowEndedAt).toBe("2026-03-09T00:00:00.000-04:00");
      expect(markdown).toContain("2026-03-02T00:00:00.000-05:00 至 2026-03-09T00:00:00.000-04:00");
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it("states the evidence boundary and fixes bounded import limits", () => {
    const markdown = formatTrainingWeeklyReportMarkdown(build([]));
    expect(markdown).toContain("不证明运动员能力提升");
    expect(markdown).toContain("不等于商业尝试分母");
    expect(MAX_REPORT_FILES).toBe(20);
    expect(MAX_REPORT_FILE_BYTES).toBe(5 * 1_024 * 1_024);
    expect(MAX_REPORT_TOTAL_BYTES).toBe(20 * 1_024 * 1_024);
  });
});
