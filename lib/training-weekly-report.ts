import {
  assessTrainingAttemptCandidate,
  serializeTrainingSession,
  type TrainingSession,
  type TrainingSessionInvalidReason,
  type TrainingSessionMarkerKind,
} from "./training-session";

export const TRAINING_REPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

export interface TrainingSessionMergeResult {
  sessions: TrainingSession[];
  duplicateCount: number;
  conflictingSessionIds: string[];
}

export interface TrainingWeeklyReport {
  windowStartedAt: string;
  windowEndedAt: string;
  workstationCount: number;
  unknownWorkstationSessionCount: number;
  athleteCount: number;
  attemptCount: number;
  validCount: number;
  validCoveragePercent: number | null;
  exportedCount: number;
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

export function mergeTrainingSessions(sessions: TrainingSession[]): TrainingSessionMergeResult {
  const canonicalById = new Map<string, { session: TrainingSession; serialized: string }>();
  const conflictingIds = new Set<string>();
  let duplicateCount = 0;

  for (const session of sessions) {
    if (conflictingIds.has(session.id)) continue;
    const serialized = serializeTrainingSession(session);
    const current = canonicalById.get(session.id);
    if (!current) {
      canonicalById.set(session.id, { session, serialized });
      continue;
    }
    if (current.serialized === serialized) {
      duplicateCount += 1;
      continue;
    }
    canonicalById.delete(session.id);
    conflictingIds.add(session.id);
  }

  return {
    sessions: [...canonicalById.values()]
      .map(({ session }) => session)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
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

export function buildTrainingWeeklyReport(
  inputSessions: TrainingSession[],
  windowStartedAtEpochMs: number,
): TrainingWeeklyReport {
  if (!Number.isFinite(windowStartedAtEpochMs)) throw new Error("周报开始时间无效");
  const windowEndedAtEpochMs = windowStartedAtEpochMs + TRAINING_REPORT_WINDOW_MS;
  const merged = mergeTrainingSessions(inputSessions);
  const sessionsInWindow = merged.sessions.filter((session) => {
    const startedAtEpochMs = Date.parse(session.startedAt);
    return startedAtEpochMs >= windowStartedAtEpochMs && startedAtEpochMs < windowEndedAtEpochMs;
  });
  const attempts = sessionsInWindow.filter((session) => session.initialSource === "ground_rc");
  const validCount = attempts.filter((session) => session.validity.valid).length;
  const exportedCount = attempts.filter((session) => session.exportedAt !== null).length;
  const invalidReasonCounts = emptyInvalidReasonCounts();
  const markerCounts = emptyMarkerCounts();

  for (const session of attempts) {
    for (const reason of session.validity.reasons) invalidReasonCounts[reason] += 1;
    for (const marker of session.markers) markerCounts[marker.kind] += 1;
  }

  const workstationIds = new Set(attempts.flatMap((session) => session.workstationId ? [session.workstationId] : []));
  const athleteCodes = new Set(attempts.flatMap((session) => session.athleteCode ? [session.athleteCode] : []));

  return {
    windowStartedAt: new Date(windowStartedAtEpochMs).toISOString(),
    windowEndedAt: new Date(windowEndedAtEpochMs).toISOString(),
    workstationCount: workstationIds.size,
    unknownWorkstationSessionCount: attempts.filter((session) => session.workstationId === null).length,
    athleteCount: athleteCodes.size,
    attemptCount: attempts.length,
    validCount,
    validCoveragePercent: percent(validCount, attempts.length),
    exportedCount,
    exportCoveragePercent: percent(exportedCount, attempts.length),
    attemptCandidateCount: attempts.filter((session) => assessTrainingAttemptCandidate(session).candidate).length,
    totalDurationMs: attempts.reduce((total, session) => total + session.durationMs, 0),
    markerCount: attempts.reduce((total, session) => total + session.markers.length, 0),
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

function formatPercent(value: number | null) {
  return value === null ? "—（无尝试）" : `${value.toFixed(1)}%`;
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
    `- 真实训练尝试：${report.attemptCount} 次`,
    `- 技术有效：${report.validCount} 次；有效覆盖率 ${formatPercent(report.validCoveragePercent)}`,
    `- 已确认导出：${report.exportedCount} 次；导出覆盖率 ${formatPercent(report.exportCoveragePercent)}`,
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
    `- 完全重复文件：${report.duplicateCount} 条（已去重）`,
    conflicts,
    "",
    "> 这份报告只证明 Session 运行与验收指标，不证明运动员能力提升。老板要求的三项表现指标尚未冻结前，不从 20 Hz 左右的打杆数据推导“平滑度”或“进步分数”。",
  ].join("\n");
}
