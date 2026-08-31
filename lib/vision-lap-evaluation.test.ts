import { describe, expect, it } from "vitest";
import {
  evaluateVisionLapRun,
  validateVisionDatasetManifest,
  type VisionLapEvaluationInput,
} from "./vision-lap-evaluation";

function input(truthCount = 300): VisionLapEvaluationInput {
  const truth = Array.from({ length: truthCount }, (_, index) => ({
    id: `truth-${index}`,
    sessionId: `session-${Math.floor(index / 20)}`,
    gateId: "start-gate",
    direction: "forward" as const,
    timestampMs: index * 2_000,
  }));
  return {
    schemaVersion: 1,
    runId: "run-2026-08-31-a",
    datasetVersion: "dataset-v1",
    modelVersion: "model-v1-sha256",
    split: "test",
    frozenAt: "2026-08-30T00:00:00.000Z",
    testOpenedAt: "2026-08-31T00:00:00.000Z",
    confidenceThreshold: 0.8,
    matchWindowMs: 250,
    duplicateWindowMs: 800,
    truth,
    predictions: truth.map((entry, index) => ({ ...entry, id: `prediction-${index}`, timestampMs: entry.timestampMs + 40, confidence: 0.95 })),
  };
}

describe("vision lap experiment evaluator", () => {
  it("passes only a frozen independent test run meeting every published threshold", () => {
    const report = evaluateVisionLapRun(input());
    expect(report).toMatchObject({
      truthCount: 300,
      matchedCount: 300,
      falsePositiveCount: 0,
      duplicateCount: 0,
      recall: 1,
      falseOrDuplicateRate: 0,
      timingErrorP95Ms: 40,
      passedTrainingAidThreshold: true,
      disclaimer: "实验圈数，不作为正式成绩或赛事计时",
    });
  });

  it("separates duplicate passes, false positives and reviewable low-confidence predictions", () => {
    const run = input();
    run.predictions.push(
      { ...run.truth[0], id: "duplicate", timestampMs: 100, confidence: 0.99 },
      { ...run.truth[0], id: "false-positive", gateId: "other-gate", timestampMs: 100, confidence: 0.99 },
      { ...run.truth[0], id: "low-confidence", timestampMs: 120, confidence: 0.5 },
    );
    const report = evaluateVisionLapRun(run);
    expect(report).toMatchObject({ duplicateCount: 1, falsePositiveCount: 1, passedTrainingAidThreshold: true });
    expect(report.lowConfidencePredictionIds).toEqual(["low-confidence"]);
  });

  it("does not pass with too little truth or when thresholds were frozen after opening test", () => {
    const tooSmall = evaluateVisionLapRun(input(299));
    expect(tooSmall.gates.enoughIndependentTruth).toBe(false);
    expect(tooSmall.passedTrainingAidThreshold).toBe(false);

    const leaked = input();
    leaked.frozenAt = "2026-09-01T00:00:00.000Z";
    expect(evaluateVisionLapRun(leaked).gates.configurationFrozenBeforeTest).toBe(false);
  });

  it("rejects non-test evaluation files and duplicate IDs", () => {
    const run = { ...input(), split: "validation" };
    expect(() => evaluateVisionLapRun(run)).toThrow(/test split/);

    const duplicate = input();
    duplicate.predictions[1].id = duplicate.predictions[0].id;
    expect(() => evaluateVisionLapRun(duplicate)).toThrow(/重复 id/);
  });

  it("rejects a Session repeated across dataset splits", () => {
    const session = {
      sessionId: "session-a",
      split: "train",
      fileSha256: "a".repeat(64),
      truthCount: 10,
      consentReference: "consent-record-001",
      deleteAfter: "2026-12-01T00:00:00.000Z",
    };
    expect(() => validateVisionDatasetManifest({
      schemaVersion: 1,
      datasetVersion: "dataset-v1",
      sessions: [session, { ...session, split: "test" }],
    })).toThrow(/禁止跨 split/);
  });
});
