import {
  normalizeSessionNotes, parseTrainingSessionVideo, resolveTrainingSessionTermination,
  type TrainingSession, type TrainingSessionFinalization, type TrainingSessionTermination,
} from "./training-session";
import type { TrainingSessionSummary } from "./training-session-index";
import type { LocalVideoRecordingReceipt } from "./local-video-recording";

export function sessionFinalization(session: Pick<TrainingSession, "video" | "exportedAt" | "finalization">): TrainingSessionFinalization {
  return session.finalization ?? { version: 1, contentRevision: 0, confirmedExportRevision: session.exportedAt === null ? null : 0,
    media: { state: session.video.recorded ? "recorded" : "unknown", operationId: null } };
}
export function hasCurrentSessionExport(session: Pick<TrainingSession, "video" | "exportedAt" | "finalization">) {
  const f = sessionFinalization(session);
  return session.exportedAt !== null && f.confirmedExportRevision === f.contentRevision;
}
export type TrainingSessionMetadataPatch =
  | { kind: "notes"; notes: string }
  | { kind: "termination"; termination: TrainingSessionTermination }
  | { kind: "media"; operationId: string; receipt: LocalVideoRecordingReceipt | null }
  | { kind: "export"; exportedAtEpochMs: number; snapshotRevision: number };

/** Field-scoped merge; caller must read current metadata inside the write transaction. */
export function applyTrainingSessionMetadataPatch(current: TrainingSessionSummary, patch: TrainingSessionMetadataPatch): TrainingSessionSummary {
  const f = sessionFinalization(current);
  let next: TrainingSessionSummary;
  if (patch.kind === "notes") {
    const notes = normalizeSessionNotes(patch.notes);
    if (notes === current.notes) return current;
    next = { ...current, notes };
  } else if (patch.kind === "termination") {
    const termination = resolveTrainingSessionTermination(current, patch.termination);
    if (termination.interrupted === current.interrupted && termination.interruptionReason === current.interruptionReason) return current;
    const reasons: TrainingSession["validity"]["reasons"] = current.validity.reasons.filter((reason) => reason !== "rx_link_lost" && reason !== "interrupted");
    if (termination.interruptionReason === "rx_link_lost") reasons.push("rx_link_lost");
    else if (termination.interrupted) reasons.push("interrupted");
    next = { ...current, ...termination, validity: { valid: reasons.length === 0, reasons } };
  } else if (patch.kind === "media") {
    if (!patch.operationId || f.media.operationId !== patch.operationId) throw new Error("视频回执的 Session / 操作身份不匹配");
    const video = patch.receipt === null ? { recorded: false as const, synchronized: false as const }
      : parseTrainingSessionVideo({ recorded: true, synchronized: false, receiptVersion: 1, receiptEvidence: "write_and_close_resolved",
        ...patch.receipt, overlay: "sticks", overlayTiming: "latest_available_host_sample" });
    const state = patch.receipt === null ? "failed" : "recorded";
    if (f.media.state !== "pending") {
      if (f.media.state === state && JSON.stringify(current.video) === JSON.stringify(video)) return current;
      throw new Error("同一视频操作出现不一致结果；原收据与记录已保留");
    }
    next = { ...current, video, finalization: { ...f, media: { state, operationId: patch.operationId } } };
  } else {
    if (!Number.isSafeInteger(patch.snapshotRevision) || patch.snapshotRevision < 0 || patch.snapshotRevision > f.contentRevision
      || !Number.isFinite(patch.exportedAtEpochMs) || !Number.isFinite(new Date(patch.exportedAtEpochMs).getTime())) throw new Error("导出修订或时间无效");
    return { ...current, exportedAt: new Date(Math.max(patch.exportedAtEpochMs, current.exportedAt ? Date.parse(current.exportedAt) : 0)).toISOString(),
      exportCount: current.exportCount + 1, finalization: { ...f, confirmedExportRevision: Math.max(f.confirmedExportRevision ?? 0, patch.snapshotRevision) } };
  }
  if (f.contentRevision === Number.MAX_SAFE_INTEGER) throw new Error("记录修订数已达上限");
  return { ...next, finalization: { ...(next.finalization ?? f), contentRevision: f.contentRevision + 1 } };
}

export function sessionMediaStatusText(session: Pick<TrainingSession, "video" | "exportedAt" | "finalization">, active = false) {
  switch (sessionFinalization(session).media.state) {
    case "pending": return active ? "视频仍在收尾；现在导出的 JSON 不含最终视频收据。" : "视频尚未确认；此前页面的收尾结果未知，遥控记录仍可查看和导出。";
    case "failed": return "视频未完整保存；遥控记录与视频结果分别保留。";
    case "recorded": return "视频收据已确认：文件写入与关闭已完成，未校准物理同步。";
    case "not_requested": return "本次未录制视频。";
    default: return "历史记录没有可确认的视频完成状态。";
  }
}
