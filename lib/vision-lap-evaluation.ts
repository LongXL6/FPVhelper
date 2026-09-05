import { createHash } from "node:crypto";

export const VISION_LAP_EVALUATION_SCHEMA_VERSION = 2;
export const VISION_DATASET_MANIFEST_SCHEMA_VERSION = 2;
export const VISION_LAP_MIN_TEST_TRUTH = 300;
export const VISION_LAP_MIN_RECALL = 0.98;
export const VISION_LAP_MAX_FALSE_OR_DUPLICATE_RATE = 0.01;
export const VISION_LAP_MAX_P95_ERROR_MS = 100;
export const VISION_LAP_MAX_MATCHING_CELLS = 2_000_000;

export type VisionLapDirection = "forward" | "reverse";
export type VisionDatasetSplit = "train" | "validation" | "test";
export type VisionScenarioDimension = "venue" | "lighting" | "videoSystem";

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
  manifestSha256: string;
  frozenAt: string;
  testOpenedAt: string;
  confidenceThreshold: number;
  matchWindowMs: number;
  duplicateWindowMs: number;
  truth: VisionLapTruth[];
  predictions: VisionLapPrediction[];
}

export interface VisionScenarioProfile {
  venue: string;
  lighting: string;
  videoSystem: string;
}

export interface VisionScenarioCoverageRequirement {
  dimension: VisionScenarioDimension;
  value: string;
  minimumTruth: number;
}

export interface VisionDatasetManifestSession {
  sessionId: string;
  split: VisionDatasetSplit;
  fileSha256: string;
  truthCount: number;
  scenario: VisionScenarioProfile;
  consentReference: string;
  deleteAfter: string;
}

export interface VisionDatasetManifest {
  schemaVersion: typeof VISION_DATASET_MANIFEST_SCHEMA_VERSION;
  datasetVersion: string;
  evaluationConfig: {
    modelVersion: string;
    frozenAt: string;
    confidenceThreshold: number;
    matchWindowMs: number;
    duplicateWindowMs: number;
  };
  requiredScenarioCoverage: VisionScenarioCoverageRequirement[];
  sessions: VisionDatasetManifestSession[];
}

export interface VisionLapMatch {
  truthId: string;
  predictionId: string;
  errorMs: number;
}

export interface VisionScenarioCoverageResult extends VisionScenarioCoverageRequirement {
  observedTruth: number;
  passed: boolean;
}

export interface VisionLapEvaluationReport {
  schemaVersion: typeof VISION_LAP_EVALUATION_SCHEMA_VERSION;
  runId: string;
  datasetVersion: string;
  modelVersion: string;
  manifestSha256: string;
  truthCount: number;
  predictionCount: number;
  matchedCount: number;
  falsePositiveCount: number;
  duplicateCount: number;
  matches: VisionLapMatch[];
  lowConfidencePredictionIds: string[];
  scenarioCoverage: VisionScenarioCoverageResult[];
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
    manifestBound: boolean;
    testSessionsVerified: boolean;
    scenarioCoverage: boolean;
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

function safeInteger(value: unknown, label: string, minimum: number, maximum: number) {
  const parsed = finiteNumber(value, label, minimum, maximum);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} 必须是整数`);
  return parsed;
}

function sha256(value: unknown, label: string) {
  const parsed = requiredString(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(parsed)) throw new Error(`${label} 必须是 SHA-256`);
  return parsed;
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

function parseSplit(value: unknown, label: string): VisionDatasetSplit {
  if (value !== "train" && value !== "validation" && value !== "test") throw new Error(`${label} 无效`);
  return value;
}

function parseScenarioDimension(value: unknown, label: string): VisionScenarioDimension {
  if (value !== "venue" && value !== "lighting" && value !== "videoSystem") throw new Error(`${label} 无效`);
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
  if (value.schemaVersion !== VISION_LAP_EVALUATION_SCHEMA_VERSION) {
    throw new Error(`只支持 evaluation schemaVersion ${VISION_LAP_EVALUATION_SCHEMA_VERSION}`);
  }
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
    schemaVersion: VISION_LAP_EVALUATION_SCHEMA_VERSION,
    runId: requiredString(value.runId, "runId"),
    datasetVersion: requiredString(value.datasetVersion, "datasetVersion"),
    modelVersion: requiredString(value.modelVersion, "modelVersion"),
    split: "test",
    manifestSha256: sha256(value.manifestSha256, "manifestSha256"),
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

function passKey(value: Pick<VisionLapTruth, "sessionId" | "gateId" | "direction">) {
  return JSON.stringify([value.sessionId, value.gateId, value.direction]);
}

function percentile95(values: readonly number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function compareTimedId(left: VisionLapTruth, right: VisionLapTruth) {
  return left.timestampMs - right.timestampMs || left.id.localeCompare(right.id);
}

const ACTION_SKIP_TRUTH = 1;
const ACTION_SKIP_PREDICTION = 2;
const ACTION_MATCH = 3;

function optimalMatchesForPass(
  truth: readonly VisionLapTruth[],
  predictions: readonly VisionLapPrediction[],
  matchWindowMs: number,
): VisionLapMatch[] {
  const sortedTruth = [...truth].sort(compareTimedId);
  const sortedPredictions = [...predictions].sort(compareTimedId);
  const width = sortedPredictions.length + 1;
  const cellCount = (sortedTruth.length + 1) * width;
  if (cellCount > VISION_LAP_MAX_MATCHING_CELLS) {
    throw new Error(`单一 Session/门/方向的匹配歧义超过 ${VISION_LAP_MAX_MATCHING_CELLS.toLocaleString()} 单元安全上限`);
  }

  const matchCounts = new Int32Array(cellCount);
  const totalErrors = new Float64Array(cellCount);
  const actions = new Uint8Array(cellCount);
  const isBetter = (count: number, error: number, action: number, index: number) => {
    const currentCount = matchCounts[index];
    const currentError = totalErrors[index];
    return count > currentCount
      || (count === currentCount && error < currentError)
      || (count === currentCount && error === currentError && action > actions[index]);
  };

  for (let truthIndex = sortedTruth.length - 1; truthIndex >= 0; truthIndex -= 1) {
    for (let predictionIndex = sortedPredictions.length - 1; predictionIndex >= 0; predictionIndex -= 1) {
      const index = truthIndex * width + predictionIndex;
      const skipTruthIndex = (truthIndex + 1) * width + predictionIndex;
      matchCounts[index] = matchCounts[skipTruthIndex];
      totalErrors[index] = totalErrors[skipTruthIndex];
      actions[index] = ACTION_SKIP_TRUTH;

      const skipPredictionIndex = truthIndex * width + predictionIndex + 1;
      if (isBetter(matchCounts[skipPredictionIndex], totalErrors[skipPredictionIndex], ACTION_SKIP_PREDICTION, index)) {
        matchCounts[index] = matchCounts[skipPredictionIndex];
        totalErrors[index] = totalErrors[skipPredictionIndex];
        actions[index] = ACTION_SKIP_PREDICTION;
      }

      const errorMs = Math.abs(sortedPredictions[predictionIndex].timestampMs - sortedTruth[truthIndex].timestampMs);
      if (errorMs <= matchWindowMs) {
        const matchedRestIndex = (truthIndex + 1) * width + predictionIndex + 1;
        const count = matchCounts[matchedRestIndex] + 1;
        const error = totalErrors[matchedRestIndex] + errorMs;
        if (isBetter(count, error, ACTION_MATCH, index)) {
          matchCounts[index] = count;
          totalErrors[index] = error;
          actions[index] = ACTION_MATCH;
        }
      }
    }
  }

  const matches: VisionLapMatch[] = [];
  let truthIndex = 0;
  let predictionIndex = 0;
  while (truthIndex < sortedTruth.length && predictionIndex < sortedPredictions.length) {
    const action = actions[truthIndex * width + predictionIndex];
    if (action === ACTION_MATCH) {
      matches.push({
        truthId: sortedTruth[truthIndex].id,
        predictionId: sortedPredictions[predictionIndex].id,
        errorMs: Math.abs(sortedPredictions[predictionIndex].timestampMs - sortedTruth[truthIndex].timestampMs),
      });
      truthIndex += 1;
      predictionIndex += 1;
    } else if (action === ACTION_SKIP_PREDICTION) {
      predictionIndex += 1;
    } else if (action === ACTION_SKIP_TRUTH) {
      truthIndex += 1;
    } else {
      break;
    }
  }
  return matches;
}

function validateEvaluationAgainstManifest(input: VisionLapEvaluationInput, manifest: VisionDatasetManifest) {
  if (manifest.datasetVersion !== input.datasetVersion) throw new Error("evaluation.datasetVersion 与 manifest 不一致");
  const config = manifest.evaluationConfig;
  if (
    config.modelVersion !== input.modelVersion
    || config.frozenAt !== input.frozenAt
    || config.confidenceThreshold !== input.confidenceThreshold
    || config.matchWindowMs !== input.matchWindowMs
    || config.duplicateWindowMs !== input.duplicateWindowMs
  ) {
    throw new Error("evaluation 模型或冻结阈值与 manifest 不一致");
  }

  const testSessions = new Map(manifest.sessions.filter((session) => session.split === "test").map((session) => [session.sessionId, session]));
  const truthCounts = new Map<string, number>();
  for (const truth of input.truth) {
    if (!testSessions.has(truth.sessionId)) throw new Error(`truth ${truth.id} 不属于 manifest 的 test Session`);
    truthCounts.set(truth.sessionId, (truthCounts.get(truth.sessionId) ?? 0) + 1);
  }
  for (const prediction of input.predictions) {
    if (!testSessions.has(prediction.sessionId)) throw new Error(`prediction ${prediction.id} 不属于 manifest 的 test Session`);
  }
  for (const session of testSessions.values()) {
    const observed = truthCounts.get(session.sessionId) ?? 0;
    if (observed !== session.truthCount) {
      throw new Error(`test Session ${session.sessionId} 真值数与 manifest 不一致：${observed} != ${session.truthCount}`);
    }
  }
  return testSessions;
}

function evaluateScenarioCoverage(
  manifest: VisionDatasetManifest,
  testSessions: ReadonlyMap<string, VisionDatasetManifestSession>,
): VisionScenarioCoverageResult[] {
  return manifest.requiredScenarioCoverage.map((requirement) => {
    let observedTruth = 0;
    for (const session of testSessions.values()) {
      if (session.scenario[requirement.dimension] === requirement.value) observedTruth += session.truthCount;
    }
    return { ...requirement, observedTruth, passed: observedTruth >= requirement.minimumTruth };
  });
}

export function evaluateVisionLapRun(untrustedInput: unknown, manifestJson: string): VisionLapEvaluationReport {
  const input = parseVisionLapEvaluationInput(untrustedInput);
  if (typeof manifestJson !== "string" || manifestJson.length === 0) throw new Error("必须提供独立 manifest JSON 文件内容");
  const manifestSha256 = createHash("sha256").update(manifestJson).digest("hex");
  if (manifestSha256 !== input.manifestSha256) throw new Error("manifestSha256 与实际 manifest 文件不一致");

  let untrustedManifest: unknown;
  try {
    untrustedManifest = JSON.parse(manifestJson);
  } catch {
    throw new Error("manifest 不是有效 JSON");
  }
  const manifest = validateVisionDatasetManifest(untrustedManifest);
  const testSessions = validateEvaluationAgainstManifest(input, manifest);
  const scenarioCoverage = evaluateScenarioCoverage(manifest, testSessions);
  const acceptedPredictions = input.predictions.filter((prediction) => prediction.confidence >= input.confidenceThreshold);
  const lowConfidencePredictionIds = input.predictions
    .filter((prediction) => prediction.confidence < input.confidenceThreshold)
    .sort(compareTimedId)
    .map((prediction) => prediction.id);

  const truthsByPass = new Map<string, VisionLapTruth[]>();
  const predictionsByPass = new Map<string, VisionLapPrediction[]>();
  for (const truth of input.truth) {
    const key = passKey(truth);
    truthsByPass.set(key, [...(truthsByPass.get(key) ?? []), truth]);
  }
  for (const prediction of acceptedPredictions) {
    const key = passKey(prediction);
    predictionsByPass.set(key, [...(predictionsByPass.get(key) ?? []), prediction]);
  }

  const matches = [...new Set([...truthsByPass.keys(), ...predictionsByPass.keys()])]
    .sort()
    .flatMap((key) => optimalMatchesForPass(truthsByPass.get(key) ?? [], predictionsByPass.get(key) ?? [], input.matchWindowMs));
  const matchedPredictionIds = new Set(matches.map((match) => match.predictionId));
  const matchedTruthIds = new Set(matches.map((match) => match.truthId));
  const matchedTruth = input.truth.filter((truth) => matchedTruthIds.has(truth.id));

  let duplicateCount = 0;
  let falsePositiveCount = 0;
  for (const prediction of acceptedPredictions) {
    if (matchedPredictionIds.has(prediction.id)) continue;
    const duplicatesMatchedPass = matchedTruth.some((truth) => (
      samePass(truth, prediction) && Math.abs(prediction.timestampMs - truth.timestampMs) <= input.duplicateWindowMs
    ));
    if (duplicatesMatchedPass) duplicateCount += 1;
    else falsePositiveCount += 1;
  }

  const truthCount = input.truth.length;
  const matchedCount = matches.length;
  const recall = truthCount === 0 ? 0 : matchedCount / truthCount;
  const falseOrDuplicateRate = truthCount === 0 ? 1 : (falsePositiveCount + duplicateCount) / truthCount;
  const timingErrorP95Ms = percentile95(matches.map((match) => match.errorMs));
  const gates = {
    manifestBound: true,
    testSessionsVerified: true,
    scenarioCoverage: scenarioCoverage.every((result) => result.passed),
    enoughIndependentTruth: truthCount >= VISION_LAP_MIN_TEST_TRUTH,
    recall: recall >= VISION_LAP_MIN_RECALL,
    falseOrDuplicateRate: falseOrDuplicateRate <= VISION_LAP_MAX_FALSE_OR_DUPLICATE_RATE,
    timingErrorP95: timingErrorP95Ms !== null && timingErrorP95Ms <= VISION_LAP_MAX_P95_ERROR_MS,
    configurationFrozenBeforeTest: Date.parse(manifest.evaluationConfig.frozenAt) < Date.parse(input.testOpenedAt),
  };

  return {
    schemaVersion: VISION_LAP_EVALUATION_SCHEMA_VERSION,
    runId: input.runId,
    datasetVersion: input.datasetVersion,
    modelVersion: input.modelVersion,
    manifestSha256,
    truthCount,
    predictionCount: acceptedPredictions.length,
    matchedCount,
    falsePositiveCount,
    duplicateCount,
    matches,
    lowConfidencePredictionIds,
    scenarioCoverage,
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
  if (value.schemaVersion !== VISION_DATASET_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`只支持 manifest schemaVersion ${VISION_DATASET_MANIFEST_SCHEMA_VERSION}`);
  }
  assertRecord(value.evaluationConfig, "manifest.evaluationConfig");
  if (!Array.isArray(value.requiredScenarioCoverage) || value.requiredScenarioCoverage.length === 0 || value.requiredScenarioCoverage.length > 100) {
    throw new Error("manifest.requiredScenarioCoverage 数量无效");
  }
  if (!Array.isArray(value.sessions) || value.sessions.length === 0 || value.sessions.length > 100_000) {
    throw new Error("manifest.sessions 数量无效");
  }

  const seenRequirements = new Set<string>();
  const valuesByDimension = new Map<VisionScenarioDimension, Set<string>>([
    ["venue", new Set()],
    ["lighting", new Set()],
    ["videoSystem", new Set()],
  ]);
  const requiredScenarioCoverage = value.requiredScenarioCoverage.map((entry, index) => {
    assertRecord(entry, `requiredScenarioCoverage[${index}]`);
    const dimension = parseScenarioDimension(entry.dimension, `requiredScenarioCoverage[${index}].dimension`);
    const scenarioValue = requiredString(entry.value, `requiredScenarioCoverage[${index}].value`);
    const key = `${dimension}:${scenarioValue}`;
    if (seenRequirements.has(key)) throw new Error(`场景覆盖要求重复：${key}`);
    seenRequirements.add(key);
    valuesByDimension.get(dimension)!.add(scenarioValue);
    return {
      dimension,
      value: scenarioValue,
      minimumTruth: safeInteger(entry.minimumTruth, `requiredScenarioCoverage[${index}].minimumTruth`, 1, 1_000_000),
    };
  });
  for (const [dimension, values] of valuesByDimension) {
    if (values.size < 2) throw new Error(`场景覆盖证据必须为 ${dimension} 冻结至少两个不同取值`);
  }

  const seenSessions = new Set<string>();
  const seenFileHashes = new Map<string, string>();
  let testSessionCount = 0;
  const sessions = value.sessions.map((entry, index) => {
    assertRecord(entry, `sessions[${index}]`);
    const sessionId = requiredString(entry.sessionId, `sessions[${index}].sessionId`);
    if (seenSessions.has(sessionId)) throw new Error(`Session ${sessionId} 重复出现，禁止跨 split 或重复切片`);
    seenSessions.add(sessionId);
    const split = parseSplit(entry.split, `sessions[${index}].split`);
    if (split === "test") testSessionCount += 1;
    const fileSha256 = sha256(entry.fileSha256, `sessions[${index}].fileSha256`);
    const duplicateHashSession = seenFileHashes.get(fileSha256);
    if (duplicateHashSession) {
      throw new Error(`fileSha256 重复：Session ${duplicateHashSession} 与 ${sessionId} 指向同一文件，禁止跨 split 或跨 Session 复用`);
    }
    seenFileHashes.set(fileSha256, sessionId);
    assertRecord(entry.scenario, `sessions[${index}].scenario`);
    return {
      sessionId,
      split,
      fileSha256,
      truthCount: safeInteger(entry.truthCount, `sessions[${index}].truthCount`, 0, 1_000_000),
      scenario: {
        venue: requiredString(entry.scenario.venue, `sessions[${index}].scenario.venue`),
        lighting: requiredString(entry.scenario.lighting, `sessions[${index}].scenario.lighting`),
        videoSystem: requiredString(entry.scenario.videoSystem, `sessions[${index}].scenario.videoSystem`),
      },
      consentReference: requiredString(entry.consentReference, `sessions[${index}].consentReference`),
      deleteAfter: isoTimestamp(entry.deleteAfter, `sessions[${index}].deleteAfter`),
    };
  });
  if (testSessionCount === 0) throw new Error("manifest 至少需要一个 test Session");

  return {
    schemaVersion: VISION_DATASET_MANIFEST_SCHEMA_VERSION,
    datasetVersion: requiredString(value.datasetVersion, "datasetVersion"),
    evaluationConfig: {
      modelVersion: requiredString(value.evaluationConfig.modelVersion, "evaluationConfig.modelVersion"),
      frozenAt: isoTimestamp(value.evaluationConfig.frozenAt, "evaluationConfig.frozenAt"),
      confidenceThreshold: finiteNumber(value.evaluationConfig.confidenceThreshold, "evaluationConfig.confidenceThreshold", 0, 1),
      matchWindowMs: finiteNumber(value.evaluationConfig.matchWindowMs, "evaluationConfig.matchWindowMs", 1, 10_000),
      duplicateWindowMs: finiteNumber(value.evaluationConfig.duplicateWindowMs, "evaluationConfig.duplicateWindowMs", 1, 30_000),
    },
    requiredScenarioCoverage,
    sessions,
  };
}
