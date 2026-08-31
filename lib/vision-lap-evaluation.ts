export const VISION_LAP_EVALUATION_SCHEMA_VERSION = 1;
export const VISION_LAP_MIN_TEST_TRUTH = 300;
export const VISION_LAP_MIN_RECALL = 0.98;
export const VISION_LAP_MAX_FALSE_OR_DUPLICATE_RATE = 0.01;
export const VISION_LAP_MAX_P95_ERROR_MS = 100;

export type VisionLapDirection = "forward" | "reverse";
export type VisionDatasetSplit = "train" | "validation" | "test";

export interface VisionLapTruth {
  id: string;
  sessionId: string;
  gateId: string;
  direction: VisionLapDirection;
  timestampMs: number;
}

export interface VisionLapPrediction extends VisionLapTruth {
  confidence: number;
}

export interface VisionLapEvaluationInput {
  schemaVersion: typeof VISION_LAP_EVALUATION_SCHEMA_VERSION;
  runId: string;
  datasetVersion: string;
  modelVersion: string;
  split: "test";
  frozenAt: string;
  testOpenedAt: string;
  confidenceThreshold: number;
  matchWindowMs: number;
  duplicateWindowMs: number;
  truth: VisionLapTruth[];
  predictions: VisionLapPrediction[];
}

export interface VisionDatasetManifestSession {
  sessionId: string;
  split: VisionDatasetSplit;
  fileSha256: string;
  truthCount: number;
  consentReference: string;
  deleteAfter: string;
}

export interface VisionDatasetManifest {
  schemaVersion: 1;
  datasetVersion: string;
  sessions: VisionDatasetManifestSession[];
}

export interface VisionLapEvaluationReport {
  schemaVersion: 1;
  runId: string;
  datasetVersion: string;
  modelVersion: string;
  truthCount: number;
  predictionCount: number;
  matchedCount: number;
  falsePositiveCount: number;
  duplicateCount: number;
  lowConfidencePredictionIds: string[];
  recall: number;
  falseOrDuplicateRate: number;
  timingErrorP95Ms: number | null;
  thresholds: {
    minimumTruth: number;
    minimumRecall: number;
    maximumFalseOrDuplicateRate: number;
    maximumTimingErrorP95Ms: number;
  };
  gates: {
    enoughIndependentTruth: boolean;
    recall: boolean;
    falseOrDuplicateRate: boolean;
    timingErrorP95: boolean;
    configurationFrozenBeforeTest: boolean;
  };
  passedTrainingAidThreshold: boolean;
  disclaimer: "实验圈数，不作为正式成绩或赛事计时";
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 160) throw new Error(`${label} 必须是非空短字符串`);
  return value;
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} 超出范围`);
  }
  return value;
}

function isoTimestamp(value: unknown, label: string) {
  const candidate = requiredString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(candidate) || Number.isNaN(Date.parse(candidate))) {
    throw new Error(`${label} 必须是 UTC ISO 时间`);
  }
  return candidate;
}

function parseDirection(value: unknown, label: string): VisionLapDirection {
  if (value !== "forward" && value !== "reverse") throw new Error(`${label} 必须是 forward 或 reverse`);
  return value;
}

function parseTruth(value: unknown, label: string): VisionLapTruth {
  assertRecord(value, label);
  return {
    id: requiredString(value.id, `${label}.id`),
    sessionId: requiredString(value.sessionId, `${label}.sessionId`),
    gateId: requiredString(value.gateId, `${label}.gateId`),
    direction: parseDirection(value.direction, `${label}.direction`),
    timestampMs: finiteNumber(value.timestampMs, `${label}.timestampMs`, 0, Number.MAX_SAFE_INTEGER),
  };
}

function uniqueIds(entries: readonly { id: string }[], label: string) {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`${label} 存在重复 id：${entry.id}`);
    ids.add(entry.id);
  }
}

export function parseVisionLapEvaluationInput(value: unknown): VisionLapEvaluationInput {
  assertRecord(value, "evaluation");
  if (value.schemaVersion !== VISION_LAP_EVALUATION_SCHEMA_VERSION) throw new Error("只支持 evaluation schemaVersion 1");
  if (value.split !== "test") throw new Error("正式评估只能使用独立 test split");
  if (!Array.isArray(value.truth) || !Array.isArray(value.predictions)) throw new Error("truth 与 predictions 必须是数组");
  if (value.truth.length > 10_000 || value.predictions.length > 20_000) throw new Error("评估文件超过本地安全上限");

  const truth = value.truth.map((entry, index) => parseTruth(entry, `truth[${index}]`));
  const predictions = value.predictions.map((entry, index) => {
    assertRecord(entry, `predictions[${index}]`);
    return {
      ...parseTruth(entry, `predictions[${index}]`),
      confidence: finiteNumber(entry.confidence, `predictions[${index}].confidence`, 0, 1),
    };
  });
  uniqueIds(truth, "truth");
  uniqueIds(predictions, "predictions");

  return {
    schemaVersion: 1,
    runId: requiredString(value.runId, "runId"),
    datasetVersion: requiredString(value.datasetVersion, "datasetVersion"),
    modelVersion: requiredString(value.modelVersion, "modelVersion"),
    split: "test",
    frozenAt: isoTimestamp(value.frozenAt, "frozenAt"),
    testOpenedAt: isoTimestamp(value.testOpenedAt, "testOpenedAt"),
    confidenceThreshold: finiteNumber(value.confidenceThreshold, "confidenceThreshold", 0, 1),
    matchWindowMs: finiteNumber(value.matchWindowMs, "matchWindowMs", 1, 10_000),
    duplicateWindowMs: finiteNumber(value.duplicateWindowMs, "duplicateWindowMs", 1, 30_000),
    truth,
    predictions,
  };
}

function samePass(
  left: Pick<VisionLapTruth, "sessionId" | "gateId" | "direction">,
  right: Pick<VisionLapTruth, "sessionId" | "gateId" | "direction">,
) {
  return left.sessionId === right.sessionId && left.gateId === right.gateId && left.direction === right.direction;
}

function percentile95(values: readonly number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

export function evaluateVisionLapRun(untrustedInput: unknown): VisionLapEvaluationReport {
  const input = parseVisionLapEvaluationInput(untrustedInput);
  const acceptedPredictions = input.predictions.filter((prediction) => prediction.confidence >= input.confidenceThreshold);
  const lowConfidencePredictionIds = input.predictions
    .filter((prediction) => prediction.confidence < input.confidenceThreshold)
    .map((prediction) => prediction.id);
  const unmatchedPredictionIds = new Set(acceptedPredictions.map((prediction) => prediction.id));
  const matchedPredictionByTruth = new Map<string, VisionLapPrediction>();
  const timingErrors: number[] = [];

  for (const truth of [...input.truth].sort((left, right) => left.timestampMs - right.timestampMs)) {
    const candidate = acceptedPredictions
      .filter((prediction) => unmatchedPredictionIds.has(prediction.id) && samePass(truth, prediction))
      .map((prediction) => ({ prediction, errorMs: Math.abs(prediction.timestampMs - truth.timestampMs) }))
      .filter(({ errorMs }) => errorMs <= input.matchWindowMs)
      .sort((left, right) => left.errorMs - right.errorMs || left.prediction.timestampMs - right.prediction.timestampMs)[0];
    if (!candidate) continue;
    unmatchedPredictionIds.delete(candidate.prediction.id);
    matchedPredictionByTruth.set(truth.id, candidate.prediction);
    timingErrors.push(candidate.errorMs);
  }

  let duplicateCount = 0;
  let falsePositiveCount = 0;
  for (const prediction of acceptedPredictions) {
    if (!unmatchedPredictionIds.has(prediction.id)) continue;
    const duplicatesMatchedPass = input.truth.some((truth) => {
      const matched = matchedPredictionByTruth.get(truth.id);
      return matched !== undefined && samePass(truth, prediction) && Math.abs(prediction.timestampMs - truth.timestampMs) <= input.duplicateWindowMs;
    });
    if (duplicatesMatchedPass) duplicateCount += 1;
    else falsePositiveCount += 1;
  }

  const truthCount = input.truth.length;
  const matchedCount = matchedPredictionByTruth.size;
  const recall = truthCount === 0 ? 0 : matchedCount / truthCount;
  const falseOrDuplicateRate = truthCount === 0 ? 1 : (falsePositiveCount + duplicateCount) / truthCount;
  const timingErrorP95Ms = percentile95(timingErrors);
  const configurationFrozenBeforeTest = Date.parse(input.frozenAt) <= Date.parse(input.testOpenedAt);
  const gates = {
    enoughIndependentTruth: truthCount >= VISION_LAP_MIN_TEST_TRUTH,
    recall: recall >= VISION_LAP_MIN_RECALL,
    falseOrDuplicateRate: falseOrDuplicateRate <= VISION_LAP_MAX_FALSE_OR_DUPLICATE_RATE,
    timingErrorP95: timingErrorP95Ms !== null && timingErrorP95Ms <= VISION_LAP_MAX_P95_ERROR_MS,
    configurationFrozenBeforeTest,
  };

  return {
    schemaVersion: 1,
    runId: input.runId,
    datasetVersion: input.datasetVersion,
    modelVersion: input.modelVersion,
    truthCount,
    predictionCount: acceptedPredictions.length,
    matchedCount,
    falsePositiveCount,
    duplicateCount,
    lowConfidencePredictionIds,
    recall,
    falseOrDuplicateRate,
    timingErrorP95Ms,
    thresholds: {
      minimumTruth: VISION_LAP_MIN_TEST_TRUTH,
      minimumRecall: VISION_LAP_MIN_RECALL,
      maximumFalseOrDuplicateRate: VISION_LAP_MAX_FALSE_OR_DUPLICATE_RATE,
      maximumTimingErrorP95Ms: VISION_LAP_MAX_P95_ERROR_MS,
    },
    gates,
    passedTrainingAidThreshold: Object.values(gates).every(Boolean),
    disclaimer: "实验圈数，不作为正式成绩或赛事计时",
  };
}

export function validateVisionDatasetManifest(value: unknown): VisionDatasetManifest {
  assertRecord(value, "manifest");
  if (value.schemaVersion !== 1) throw new Error("只支持 manifest schemaVersion 1");
  if (!Array.isArray(value.sessions) || value.sessions.length === 0 || value.sessions.length > 100_000) {
    throw new Error("manifest.sessions 数量无效");
  }
  const seenSessions = new Map<string, VisionDatasetSplit>();
  const sessions = value.sessions.map((entry, index) => {
    assertRecord(entry, `sessions[${index}]`);
    const sessionId = requiredString(entry.sessionId, `sessions[${index}].sessionId`);
    if (entry.split !== "train" && entry.split !== "validation" && entry.split !== "test") throw new Error(`sessions[${index}].split 无效`);
    const split: VisionDatasetSplit = entry.split;
    if (seenSessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} 重复出现，禁止跨 split 或重复切片`);
    }
    seenSessions.set(sessionId, split);
    const fileSha256 = requiredString(entry.fileSha256, `sessions[${index}].fileSha256`).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(fileSha256)) throw new Error(`sessions[${index}].fileSha256 必须是 SHA-256`);
    const truthCount = finiteNumber(entry.truthCount, `sessions[${index}].truthCount`, 0, 1_000_000);
    if (!Number.isSafeInteger(truthCount)) throw new Error(`sessions[${index}].truthCount 必须是整数`);
    return {
      sessionId,
      split,
      fileSha256,
      truthCount,
      consentReference: requiredString(entry.consentReference, `sessions[${index}].consentReference`),
      deleteAfter: isoTimestamp(entry.deleteAfter, `sessions[${index}].deleteAfter`),
    };
  });
  return {
    schemaVersion: 1,
    datasetVersion: requiredString(value.datasetVersion, "datasetVersion"),
    sessions,
  };
}
