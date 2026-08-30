import { describe, expect, it } from "vitest";
import {
  appendTrainingSessionMarker,
  createTrainingSessionDraft,
  finishTrainingSession,
} from "./training-session";
import {
  formatDvrReviewChecklist,
  sessionsStartedOnLocalDay,
  shouldWarnBeforeTrainingExit,
  trainingSessionProgress,
} from "./training-session-summary";

function createSession(id: string, startedAtEpochMs: number) {
  const draft = createTrainingSessionDraft({
    id,
    athleteCode: "PILOT-21",
    source: "serial",
    startedAtEpochMs,
    startedMonotonicMs: 1_000,
  });
  return finishTrainingSession(draft, startedAtEpochMs + 1_000, 2_000);
}

describe("training session product summaries", () => {
  it("reports the remaining duration and independent sample thresholds", () => {
    expect(trainingSessionProgress(12_400, 42)).toEqual({
      remainingDurationMs: 47_600,
      remainingUniqueSamples: 258,
      thresholdReached: false,
    });
    expect(trainingSessionProgress(61_000, 301)).toEqual({
      remainingDurationMs: 0,
      remainingUniqueSamples: 0,
      thresholdReached: true,
    });
  });

  it("warns only for active, unsafely saved, or unexported valid work", () => {
    expect(shouldWarnBeforeTrainingExit({ isRecording: false, hasPendingSave: false, unexportedValidCount: 0 })).toBe(false);
    expect(shouldWarnBeforeTrainingExit({ isRecording: true, hasPendingSave: false, unexportedValidCount: 0 })).toBe(true);
    expect(shouldWarnBeforeTrainingExit({ isRecording: false, hasPendingSave: true, unexportedValidCount: 0 })).toBe(true);
    expect(shouldWarnBeforeTrainingExit({ isRecording: false, hasPendingSave: false, unexportedValidCount: 1 })).toBe(true);
  });

  it("filters today's records by the stored local wall-clock day", () => {
    const todayEpochMs = new Date(2026, 7, 31, 12, 0, 0).getTime();
    const todaySession = createSession("today", new Date(2026, 7, 31, 8, 30, 0).getTime());
    const yesterdaySession = createSession("yesterday", new Date(2026, 7, 30, 23, 59, 0).getTime());

    expect(sessionsStartedOnLocalDay([yesterdaySession, todaySession], todayEpochMs).map((session) => session.id)).toEqual(["today"]);
  });

  it("builds a copyable DVR checklist while stating that markers are not automatic timing", () => {
    const startedAtEpochMs = new Date(2026, 7, 31, 9, 0, 0).getTime();
    const draft = createTrainingSessionDraft({
      id: "marked-session",
      athleteCode: "PILOT-21",
      source: "serial",
      startedAtEpochMs,
      startedMonotonicMs: 1_000,
    });
    appendTrainingSessionMarker(draft, {
      id: "marker-clean",
      kind: "clean",
      wallClockEpochMs: startedAtEpochMs + 12_345,
      monotonicMs: 13_345,
    });
    appendTrainingSessionMarker(draft, {
      id: "marker-throttle",
      kind: "throttle",
      wallClockEpochMs: startedAtEpochMs + 45_678,
      monotonicMs: 46_678,
    });
    const checklist = formatDvrReviewChecklist(finishTrainingSession(draft, startedAtEpochMs + 60_000, 61_000));

    expect(checklist).toContain("人工标记，仅用于定位画面；不是自动计圈或正式计时。");
    expect(checklist).toContain("- [ ] 00:12.345 · 漂亮 · 本地");
    expect(checklist).toContain("- [ ] 00:45.678 · 油门过猛 · 本地");
  });
});
