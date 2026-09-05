import { describe, expect, it } from "vitest";
import { parseTrainingSession, type TrainingSession, type TrainingSessionInvalidReason } from "./training-session";
import {
  buildTrainingWeeklyReport,
  formatTrainingWeeklyReportMarkdown,
  MAX_INTENDED_RECORDINGS,
  MAX_REPORT_FILE_BYTES,
  MAX_REPORT_FILES,
  MAX_REPORT_TOTAL_BYTES,
  mergeTrainingSessions,
  trainingReportWindowEndEpochMs,
  type TrainingWeeklyReportSessionInput,
} from "./training-weekly-report";

const WINDOW_START = new Date(2026, 7, 31, 0, 0, 0, 0).getTime();

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
    interruptionReason: null,
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
  it("counts RX link loss as a finite invalid reason and includes it in the report", () => {
    const report = build([
      reportInput(session({
        id: "rx-link-lost",
        interrupted: true,
        interruptionReason: "rx_link_lost",
        validity: { valid: false, reasons: ["rx_link_lost"] },
      })),
    ]);

    expect(report.invalidReasonCounts.rx_link_lost).toBe(1);
    expect(report.invalidReasonCounts.interrupted).toBe(0);
    expect(Object.values(report.invalidReasonCounts).every(Number.isFinite)).toBe(true);
    expect(formatTrainingWeeklyReportMarkdown(report)).toContain("遥控链路丢失：1");
  });

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
      intentLedgerStatus: "missing",
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

  it("returns null coverage when an intent ledger of 1 is smaller than 2 completed sessions", () => {
    const report = build([
      reportInput(session({ id: "completed-1" })),
      reportInput(session({ id: "completed-2" })),
    ], 1);
    const markdown = formatTrainingWeeklyReportMarkdown(report);

    expect(report).toMatchObject({
      intendedRecordings: 1,
      completedSessionCount: 2,
      intentLedgerStatus: "session-count-mismatch",
      validCoveragePercent: null,
      exportCoveragePercent: null,
    });
    expect(markdown).toContain("台账与 Session 范围不一致，待核对");
    expect(markdown).not.toMatch(/1\d{2}\.\d%/);
  });

  it("returns null coverage when a zero intent ledger conflicts with completed sessions", () => {
    const report = build([reportInput(session({ id: "completed" }))], 0);

    expect(report).toMatchObject({
      intendedRecordings: 0,
      completedSessionCount: 1,
      intentLedgerStatus: "session-count-mismatch",
      validCoveragePercent: null,
      exportCoveragePercent: null,
    });
  });

  it("rejects huge, unsafe and fractional intended recording counts", () => {
    expect(() => build([], MAX_INTENDED_RECORDINGS + 1)).toThrow("0…1,000,000");
    expect(() => build([], Number.MAX_SAFE_INTEGER + 1)).toThrow("0…1,000,000");
    expect(() => build([], 1.5)).toThrow("0…1,000,000");
  });

  it("rejects a week boundary that is not local Monday midnight", () => {
    const localTuesday = new Date(2026, 8, 1, 0, 0, 0, 0).getTime();
    const localMondayNoon = new Date(2026, 7, 31, 12, 0, 0, 0).getTime();

    expect(() => build([], undefined, localTuesday)).toThrow("本地周一 00:00");
    expect(() => build([], undefined, localMondayNoon)).toThrow("本地周一 00:00");
  });

  it("calculates bounded coverage when the ledger equals or exceeds completed sessions", () => {
    const sessions = [
      reportInput(session({ id: "completed-1" })),
      reportInput(session({ id: "completed-2" })),
    ];
    const equal = build(sessions, 2);
    const greater = build(sessions, 4);

    expect(equal).toMatchObject({ intentLedgerStatus: "valid", validCoveragePercent: 100, exportCoveragePercent: 100 });
    expect(greater).toMatchObject({ intentLedgerStatus: "valid", validCoveragePercent: 50, exportCoveragePercent: 50 });
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
    expect(markdown).toContain("不是最终 80% 业务验收率");
    expect(MAX_REPORT_FILES).toBe(20);
    expect(MAX_REPORT_FILE_BYTES).toBe(5 * 1_024 * 1_024);
    expect(MAX_REPORT_TOTAL_BYTES).toBe(20 * 1_024 * 1_024);
  });
});
