import {
  assessTrainingAttemptCandidate,
  serializeTrainingSession,
  toLocalWallClockTimestamp,
  type TrainingSession,
  type TrainingSessionInvalidReason,
  type TrainingSessionMarkerKind,
} from "./training-session";

export const MAX_REPORT_FILES = 20;
export const MAX_REPORT_FILE_BYTES = 5 * 1_024 * 1_024;
export const MAX_REPORT_TOTAL_BYTES = 20 * 1_024 * 1_024;

export type TrainingWeeklyReportSessionSource = "browser-local" | "imported-file";

export interface TrainingWeeklyReportSessionInput {
  session: TrainingSession;
  source: TrainingWeeklyReportSessionSource;
}

export interface BuildTrainingWeeklyReportInput {
  sessions: TrainingWeeklyReportSessionInput[];
  windowStartedAtEpochMs: number;
  intendedRecordings?: number;
}

export interface TrainingSessionMergeResult {
  sessions: TrainingWeeklyReportSessionInput[];
  duplicateCount: number;
  conflictingSessionIds: string[];
}

export interface TrainingWeeklyReport {
  windowStartedAt: string;
  windowEndedAt: string;
  workstationCount: number;
  unknownWorkstationSessionCount: number;
  athleteCount: number;
  intendedRecordings: number | null;
  completedSessionCount: number;
  validCount: number;
  validCoveragePercent: number | null;
  confirmedFileCount: number;
  exportCoveragePercent: number | null;
  attemptCandidateCount: number;
  totalDurationMs: number;
  markerCount: number;
  markerCounts: Record<TrainingSessionMarkerKind, number>;
  invalidReasonCounts: Record<TrainingSessionInvalidReason, number>;
  duplicateCount: number;
  conflictingSessionIds: string[];
}

const INVALID_REASONS: TrainingSessionInvalidReason[] = [
  "source_not_ground_rc",
  "mixed_sources",
  "too_short",
  "too_few_unique_samples",
  "non_monotonic",
  "no_athlete_code",
  "interrupted",
];

const MARKER_KINDS: TrainingSessionMarkerKind[] = ["manual", "crash", "gate_hit", "clean", "throttle"];

export function mergeTrainingSessions(inputs: TrainingWeeklyReportSessionInput[]): TrainingSessionMergeResult {
  const canonicalById = new Map<string, TrainingWeeklyReportSessionInput & { serialized: string }>();
  const conflictingIds = new Set<string>();
  let duplicateCount = 0;

  for (const input of inputs) {
    const { session } = input;
    if (conflictingIds.has(session.id)) continue;
    const serialized = serializeTrainingSession(session);
    const current = canonicalById.get(session.id);
    if (!current) {
      canonicalById.set(session.id, { ...input, serialized });
      continue;
    }
    if (current.serialized === serialized) {
      duplicateCount += 1;
      if (input.source === "imported-file") canonicalById.set(session.id, { ...input, serialized });
      continue;
    }
    canonicalById.delete(session.id);
    conflictingIds.add(session.id);
  }

  return {
    sessions: [...canonicalById.values()]
      .map(({ session, source }) => ({ session, source }))
      .sort((left, right) => left.session.startedAt.localeCompare(right.session.startedAt)),
    duplicateCount,
    conflictingSessionIds: [...conflictingIds].sort(),
  };
}

function emptyInvalidReasonCounts(): Record<TrainingSessionInvalidReason, number> {
  return Object.fromEntries(INVALID_REASONS.map((reason) => [reason, 0])) as Record<TrainingSessionInvalidReason, number>;
}

function emptyMarkerCounts(): Record<TrainingSessionMarkerKind, number> {
  return Object.fromEntries(MARKER_KINDS.map((kind) => [kind, 0])) as Record<TrainingSessionMarkerKind, number>;
}

function percent(numerator: number, denominator: number) {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 1_000) / 10;
}

export function trainingReportWindowEndEpochMs(windowStartedAtEpochMs: number) {
  const windowEnd = new Date(windowStartedAtEpochMs);
  windowEnd.setDate(windowEnd.getDate() + 7);
  return windowEnd.getTime();
}

function hasConfirmedBrowserFileEvidence(session: TrainingSession) {
  return session.exportedAt !== null
    && Number.isFinite(Date.parse(session.exportedAt))
    && Number.isInteger(session.exportCount)
    && session.exportCount > 0;
}

export function buildTrainingWeeklyReport({
  sessions,
  windowStartedAtEpochMs,
  intendedRecordings,
}: BuildTrainingWeeklyReportInput): TrainingWeeklyReport {
  if (!Number.isFinite(windowStartedAtEpochMs)) throw new Error("周报开始时间无效");
  if (intendedRecordings !== undefined && (!Number.isSafeInteger(intendedRecordings) || intendedRecordings < 0)) {
    throw new Error("训练意图台账次数必须是非负整数");
  }
  const windowEndedAtEpochMs = trainingReportWindowEndEpochMs(windowStartedAtEpochMs);
  const sessionsInWindow = sessions.filter(({ session }) => {
    const startedAtEpochMs = Date.parse(session.startedAt);
    return startedAtEpochMs >= windowStartedAtEpochMs && startedAtEpochMs < windowEndedAtEpochMs;
  });
  const merged = mergeTrainingSessions(sessionsInWindow);
  const completedSessions = merged.sessions.filter(({ session }) => session.initialSource === "ground_rc");
  const validCount = completedSessions.filter(({ session }) => session.validity.valid).length;
  const confirmedFileCount = completedSessions.filter(({ session, source }) => (
    source === "imported-file" || hasConfirmedBrowserFileEvidence(session)
  )).length;
  const invalidReasonCounts = emptyInvalidReasonCounts();
  const markerCounts = emptyMarkerCounts();

  for (const { session } of completedSessions) {
    for (const reason of session.validity.reasons) invalidReasonCounts[reason] += 1;
    for (const marker of session.markers) markerCounts[marker.kind] += 1;
  }

  const workstationIds = new Set(completedSessions.flatMap(({ session }) => session.workstationId ? [session.workstationId] : []));
  const athleteCodes = new Set(completedSessions.flatMap(({ session }) => session.athleteCode ? [session.athleteCode] : []));
  const intendedRecordingCount = intendedRecordings ?? null;

  return {
    windowStartedAt: toLocalWallClockTimestamp(windowStartedAtEpochMs),
    windowEndedAt: toLocalWallClockTimestamp(windowEndedAtEpochMs),
    workstationCount: workstationIds.size,
    unknownWorkstationSessionCount: completedSessions.filter(({ session }) => session.workstationId === null).length,
    athleteCount: athleteCodes.size,
    intendedRecordings: intendedRecordingCount,
    completedSessionCount: completedSessions.length,
    validCount,
    validCoveragePercent: intendedRecordingCount === null ? null : percent(validCount, intendedRecordingCount),
    confirmedFileCount,
    exportCoveragePercent: intendedRecordingCount === null ? null : percent(confirmedFileCount, intendedRecordingCount),
    attemptCandidateCount: completedSessions.filter(({ session }) => assessTrainingAttemptCandidate(session).candidate).length,
    totalDurationMs: completedSessions.reduce((total, { session }) => total + session.durationMs, 0),
    markerCount: completedSessions.reduce((total, { session }) => total + session.markers.length, 0),
    markerCounts,
    invalidReasonCounts,
    duplicateCount: merged.duplicateCount,
    conflictingSessionIds: merged.conflictingSessionIds,
  };
}

const INVALID_REASON_LABELS: Record<TrainingSessionInvalidReason, string> = {
  source_not_ground_rc: "非真实 GROUND_RC",
  mixed_sources: "混入其他数据源",
  too_short: "不足 60 秒",
  too_few_unique_samples: "不足 300 个独立样本",
  non_monotonic: "时间戳不严格单调",
  no_athlete_code: "缺少选手代号",
  interrupted: "中断结束",
};

const MARKER_LABELS: Record<TrainingSessionMarkerKind, string> = {
  manual: "人工",
  crash: "炸机",
  gate_hit: "撞门",
  clean: "漂亮",
  throttle: "油门过猛",
};

function formatCommercialCoverage(value: number | null, intendedRecordings: number | null) {
  if (intendedRecordings === null) return "— 待台账";
  return value === null ? "—（台账为 0）" : `${value.toFixed(1)}%`;
}

export function formatTrainingWeeklyReportMarkdown(report: TrainingWeeklyReport) {
  const invalidReasons = INVALID_REASONS
    .filter((reason) => report.invalidReasonCounts[reason] > 0)
    .map((reason) => `  - ${INVALID_REASON_LABELS[reason]}：${report.invalidReasonCounts[reason]}`);
  const markerCounts = MARKER_KINDS
    .filter((kind) => report.markerCounts[kind] > 0)
    .map((kind) => `  - ${MARKER_LABELS[kind]}：${report.markerCounts[kind]}`);
  const conflicts = report.conflictingSessionIds.length > 0
    ? `- 冲突 Session：${report.conflictingSessionIds.length} 条（已排除，需人工核对）`
    : "- 冲突 Session：0 条";

  return [
    "# FPVHelper 试点验收周报",
    "",
    `统计窗口：${report.windowStartedAt} 至 ${report.windowEndedAt}（结束时间不含）`,
    "",
    "## 核心验收指标",
    `- 工作站：${report.workstationCount} 台${report.unknownWorkstationSessionCount > 0 ? `；另有 ${report.unknownWorkstationSessionCount} 条旧记录缺少工作站 ID` : ""}`,
    `- 选手代号：${report.athleteCount} 个`,
    `- 训练意图台账：${report.intendedRecordings === null ? "— 待台账" : `${report.intendedRecordings} 次`}`,
    `- 已完成 GROUND_RC Session：${report.completedSessionCount} 次（不等于商业尝试分母）`,
    `- 技术有效：${report.validCount} 次；有效覆盖率 ${formatCommercialCoverage(report.validCoveragePercent, report.intendedRecordings)}`,
    `- 已确认文件证据：${report.confirmedFileCount} 次；导出覆盖率 ${formatCommercialCoverage(report.exportCoveragePercent, report.intendedRecordings)}`,
    `- 80% 验收候选：${report.attemptCandidateCount} 次（仍需外部台账、重解析和授权记录）`,
    `- 总记录时长：${(report.totalDurationMs / 60_000).toFixed(1)} 分钟`,
    `- 人工 Marker：${report.markerCount} 条`,
    "",
    "## 无效原因",
    ...(invalidReasons.length > 0 ? invalidReasons : ["  - 无"]),
    "",
    "## Marker 分布",
    ...(markerCounts.length > 0 ? markerCounts : ["  - 无"]),
    "",
    "## 数据质量",
    `- 完全重复记录：${report.duplicateCount} 条（已去重）`,
    conflicts,
    "",
    "> 这份报告只证明 Session 运行与验收指标，不证明运动员能力提升。老板要求的三项表现指标尚未冻结前，不从 20 Hz 左右的打杆数据推导“平滑度”或“进步分数”。",
  ].join("\n");
}
