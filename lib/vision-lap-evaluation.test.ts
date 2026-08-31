import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  evaluateVisionLapRun,
  validateVisionDatasetManifest,
  type VisionDatasetManifest,
  type VisionLapEvaluationInput,
} from "./vision-lap-evaluation";

interface Fixture {
  input: VisionLapEvaluationInput;
  manifest: VisionDatasetManifest;
  manifestRaw: string;
}

function bindManifest(fixture: Fixture) {
  fixture.manifestRaw = JSON.stringify(fixture.manifest);
  fixture.input.manifestSha256 = createHash("sha256").update(fixture.manifestRaw).digest("hex");
  return fixture;
}

function fixture(truthCount = 300): Fixture {
  const firstSessionTruth = Math.ceil(truthCount / 2);
  const truth = Array.from({ length: truthCount }, (_, index) => ({
    id: `truth-${index}`,
    sessionId: index < firstSessionTruth ? "session-indoor" : "session-outdoor",
    gateId: "start-gate",
    direction: "forward" as const,
    timestampMs: index * 2_000,
  }));
  const manifest: VisionDatasetManifest = {
    schemaVersion: 2,
    datasetVersion: "dataset-v2",
    evaluationConfig: {
      modelVersion: "model-v1-sha256",
      frozenAt: "2026-08-30T00:00:00.000Z",
      confidenceThreshold: 0.8,
      matchWindowMs: 250,
      duplicateWindowMs: 800,
    },
    requiredScenarioCoverage: [
      { dimension: "venue", value: "indoor", minimumTruth: 1 },
      { dimension: "venue", value: "outdoor", minimumTruth: 1 },
      { dimension: "lighting", value: "bright", minimumTruth: 1 },
      { dimension: "lighting", value: "dark", minimumTruth: 1 },
      { dimension: "videoSystem", value: "analog", minimumTruth: 1 },
      { dimension: "videoSystem", value: "digital", minimumTruth: 1 },
    ],
    sessions: [
      {
        sessionId: "session-indoor",
        split: "test",
        fileSha256: "a".repeat(64),
        truthCount: firstSessionTruth,
        scenario: { venue: "indoor", lighting: "bright", videoSystem: "analog" },
        consentReference: "consent-record-001",
        deleteAfter: "2026-12-01T00:00:00.000Z",
      },
      {
        sessionId: "session-outdoor",
        split: "test",
        fileSha256: "b".repeat(64),
        truthCount: truthCount - firstSessionTruth,
        scenario: { venue: "outdoor", lighting: "dark", videoSystem: "digital" },
        consentReference: "consent-record-002",
        deleteAfter: "2026-12-01T00:00:00.000Z",
      },
    ],
  };
  const input: VisionLapEvaluationInput = {
    schemaVersion: 2,
    runId: "run-2026-08-31-a",
    datasetVersion: manifest.datasetVersion,
    modelVersion: manifest.evaluationConfig.modelVersion,
    split: "test",
    manifestSha256: "",
    frozenAt: manifest.evaluationConfig.frozenAt,
    testOpenedAt: "2026-08-31T00:00:00.000Z",
    confidenceThreshold: manifest.evaluationConfig.confidenceThreshold,
    matchWindowMs: manifest.evaluationConfig.matchWindowMs,
    duplicateWindowMs: manifest.evaluationConfig.duplicateWindowMs,
    truth,
    predictions: truth.map((entry, index) => ({
      ...entry,
      id: `prediction-${index}`,
      timestampMs: entry.timestampMs + 40,
      confidence: 0.95,
    })),
  };
  return bindManifest({ input, manifest, manifestRaw: "" });
}

function evaluate(value: Fixture) {
  return evaluateVisionLapRun(value.input, value.manifestRaw);
}

function putAllTruthInFirstSession(value: Fixture) {
  value.input.truth.forEach((entry) => {
    entry.sessionId = "session-indoor";
  });
  value.input.predictions.forEach((entry) => {
    entry.sessionId = "session-indoor";
  });
  value.manifest.sessions[0].truthCount = value.input.truth.length;
  value.manifest.sessions[1].truthCount = 0;
  return bindManifest(value);
}

describe("vision lap experiment evaluator", () => {
  it("passes only a manifest-bound frozen test run meeting every published threshold", () => {
    const run = fixture();
    const report = evaluate(run);
    expect(report).toMatchObject({
      schemaVersion: 2,
      manifestSha256: run.input.manifestSha256,
      truthCount: 300,
      matchedCount: 300,
      falsePositiveCount: 0,
      duplicateCount: 0,
      recall: 1,
      falseOrDuplicateRate: 0,
      timingErrorP95Ms: 40,
      gates: { manifestBound: true, testSessionsVerified: true, scenarioCoverage: true },
      passedTrainingAidThreshold: true,
      disclaimer: "实验圈数，不作为正式成绩或赛事计时",
    });
  });

  it("separates duplicates, false positives and low-confidence review items at inclusive boundaries", () => {
    const run = fixture();
    run.input.predictions[0].confidence = run.input.confidenceThreshold;
    run.input.predictions[0].timestampMs = run.input.truth[0].timestampMs + run.input.matchWindowMs;
    run.input.predictions.push(
      { ...run.input.truth[0], id: "duplicate", timestampMs: run.input.truth[0].timestampMs + run.input.duplicateWindowMs, confidence: 0.99 },
      { ...run.input.truth[0], id: "false-positive", gateId: "other-gate", confidence: 0.99 },
      { ...run.input.truth[0], id: "low-confidence", confidence: run.input.confidenceThreshold - Number.EPSILON },
    );
    const report = evaluate(run);
    expect(report).toMatchObject({ duplicateCount: 1, falsePositiveCount: 1, passedTrainingAidThreshold: true });
    expect(report.lowConfidencePredictionIds).toEqual(["low-confidence"]);
    expect(report.matches.find((match) => match.predictionId === "prediction-0")?.errorMs).toBe(run.input.matchWindowMs);
  });

  it("accepts exact recall, error-rate and P95 thresholds and rejects values beyond them", () => {
    const exactRates = fixture();
    exactRates.input.predictions.splice(-6);
    exactRates.input.predictions.push(...Array.from({ length: 3 }, (_, index) => ({
      ...exactRates.input.truth[0],
      id: `false-${index}`,
      gateId: `other-gate-${index}`,
      confidence: 0.95,
    })));
    const exactRateReport = evaluate(exactRates);
    expect(exactRateReport.recall).toBe(0.98);
    expect(exactRateReport.falseOrDuplicateRate).toBe(0.01);
    expect(exactRateReport.passedTrainingAidThreshold).toBe(true);

    const exactP95 = fixture();
    exactP95.input.predictions.forEach((prediction, index) => {
      prediction.timestampMs = exactP95.input.truth[index].timestampMs + 100;
    });
    expect(evaluate(exactP95).gates.timingErrorP95).toBe(true);
    exactP95.input.predictions.slice(-16).forEach((prediction, offset) => {
      const truthIndex = exactP95.input.predictions.length - 16 + offset;
      prediction.timestampMs = exactP95.input.truth[truthIndex].timestampMs + 101;
    });
    expect(evaluate(exactP95).gates.timingErrorP95).toBe(false);
  });

  it("does not pass with zero truth, too little truth, or freeze at/after test opening", () => {
    const empty = fixture(0);
    const emptyReport = evaluate(empty);
    expect(emptyReport).toMatchObject({
      truthCount: 0,
      recall: 0,
      falseOrDuplicateRate: 1,
      timingErrorP95Ms: null,
      passedTrainingAidThreshold: false,
    });
    expect(emptyReport.gates).toMatchObject({ enoughIndependentTruth: false, scenarioCoverage: false, timingErrorP95: false });

    expect(evaluate(fixture(299)).gates.enoughIndependentTruth).toBe(false);

    const equalFreeze = fixture();
    equalFreeze.manifest.evaluationConfig.frozenAt = equalFreeze.input.testOpenedAt;
    equalFreeze.input.frozenAt = equalFreeze.input.testOpenedAt;
    bindManifest(equalFreeze);
    expect(evaluate(equalFreeze).gates.configurationFrozenBeforeTest).toBe(false);

    const laterFreeze = fixture();
    laterFreeze.manifest.evaluationConfig.frozenAt = "2026-09-01T00:00:00.000Z";
    laterFreeze.input.frozenAt = laterFreeze.manifest.evaluationConfig.frozenAt;
    bindManifest(laterFreeze);
    expect(evaluate(laterFreeze).gates.configurationFrozenBeforeTest).toBe(false);
  });

  it("requires the exact validated manifest, every test Session and the frozen configuration", () => {
    const wrongHash = fixture();
    wrongHash.input.manifestSha256 = "f".repeat(64);
    expect(() => evaluate(wrongHash)).toThrow(/实际 manifest 文件不一致/);

    const wrongDataset = fixture();
    wrongDataset.input.datasetVersion = "other-dataset";
    expect(() => evaluate(wrongDataset)).toThrow(/datasetVersion/);

    const missingTruth = fixture();
    missingTruth.manifest.sessions[0].truthCount -= 1;
    bindManifest(missingTruth);
    expect(() => evaluate(missingTruth)).toThrow(/真值数与 manifest 不一致/);

    const leakedPrediction = fixture();
    leakedPrediction.manifest.sessions.push({
      ...leakedPrediction.manifest.sessions[0],
      sessionId: "session-train",
      split: "train",
      fileSha256: "c".repeat(64),
      truthCount: 0,
    });
    leakedPrediction.input.predictions[0].sessionId = "session-train";
    bindManifest(leakedPrediction);
    expect(() => evaluate(leakedPrediction)).toThrow(/不属于 manifest 的 test Session/);

    const changedThreshold = fixture();
    changedThreshold.input.confidenceThreshold = 0.7;
    expect(() => evaluate(changedThreshold)).toThrow(/冻结阈值与 manifest 不一致/);
  });

  it("requires manifest-backed scenario coverage before a run can pass", () => {
    const run = fixture();
    run.manifest.requiredScenarioCoverage.find((entry) => entry.dimension === "lighting" && entry.value === "dark")!.minimumTruth = 10_000;
    bindManifest(run);
    const report = evaluate(run);
    expect(report.gates.scenarioCoverage).toBe(false);
    expect(report.scenarioCoverage.find((entry) => entry.dimension === "lighting" && entry.value === "dark")).toMatchObject({
      observedTruth: 150,
      passed: false,
    });
    expect(report.passedTrainingAidThreshold).toBe(false);
  });

  it("maximizes matched events before minimizing total timing error", () => {
    const maximumCardinality = putAllTruthInFirstSession(fixture(2));
    maximumCardinality.input.truth[0].timestampMs = 100;
    maximumCardinality.input.truth[1].timestampMs = 110;
    maximumCardinality.input.predictions = [
      { ...maximumCardinality.input.truth[0], id: "prediction-early", timestampMs: 91, confidence: 0.95 },
      { ...maximumCardinality.input.truth[0], id: "prediction-middle", timestampMs: 101, confidence: 0.95 },
    ];
    maximumCardinality.input.matchWindowMs = 9;
    maximumCardinality.manifest.evaluationConfig.matchWindowMs = 9;
    bindManifest(maximumCardinality);
    expect(evaluate(maximumCardinality).matches).toEqual([
      { truthId: "truth-0", predictionId: "prediction-early", errorMs: 9 },
      { truthId: "truth-1", predictionId: "prediction-middle", errorMs: 9 },
    ]);

    const minimumError = putAllTruthInFirstSession(fixture(2));
    minimumError.input.truth[0].timestampMs = 100;
    minimumError.input.truth[1].timestampMs = 110;
    minimumError.input.predictions = [
      { ...minimumError.input.truth[0], id: "prediction-far", timestampMs: 91, confidence: 0.95 },
      { ...minimumError.input.truth[0], id: "prediction-near-first", timestampMs: 101, confidence: 0.95 },
      { ...minimumError.input.truth[1], id: "prediction-near-second", timestampMs: 109, confidence: 0.95 },
    ];
    minimumError.input.matchWindowMs = 10;
    minimumError.manifest.evaluationConfig.matchWindowMs = 10;
    bindManifest(minimumError);
    expect(evaluate(minimumError).matches).toEqual([
      { truthId: "truth-0", predictionId: "prediction-near-first", errorMs: 1 },
      { truthId: "truth-1", predictionId: "prediction-near-second", errorMs: 1 },
    ]);
  });

  it("bounds pathological matching ambiguity", () => {
    const run = putAllTruthInFirstSession(fixture(1_414));
    run.input.truth.forEach((entry) => {
      entry.timestampMs = 100;
    });
    run.input.predictions.forEach((entry) => {
      entry.timestampMs = 100;
    });
    expect(() => evaluate(run)).toThrow(/匹配歧义超过/);
  });

  it("rejects non-test runs, duplicate IDs, duplicate Sessions and cross-Session file hashes", () => {
    expect(() => evaluateVisionLapRun({ ...fixture().input, split: "validation" }, fixture().manifestRaw)).toThrow(/test split/);

    const duplicateId = fixture();
    duplicateId.input.predictions[1].id = duplicateId.input.predictions[0].id;
    expect(() => evaluate(duplicateId)).toThrow(/重复 id/);

    const duplicateSession = fixture().manifest;
    duplicateSession.sessions[1].sessionId = duplicateSession.sessions[0].sessionId;
    expect(() => validateVisionDatasetManifest(duplicateSession)).toThrow(/禁止跨 split/);

    const duplicateHash = fixture().manifest;
    duplicateHash.sessions[1].split = "train";
    duplicateHash.sessions[1].fileSha256 = duplicateHash.sessions[0].fileSha256;
    expect(() => validateVisionDatasetManifest(duplicateHash)).toThrow(/fileSha256 重复/);
  });
});
