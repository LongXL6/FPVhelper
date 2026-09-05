import { beginUnconfirmedTrainingSessionDownload } from "../lib/training-session-export";
import type { TrainingSession } from "../lib/training-session";

export interface TrainingSessionExportFeedback {
  notice: string | null;
  warning: string | null;
}

function receiptNonce() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function exportErrorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "浏览器下载请求失败";
}

export function requestUnconfirmedTrainingSessionDownload(
  session: TrainingSession,
  requestDownload: (targetSession: TrainingSession) => number = beginUnconfirmedTrainingSessionDownload,
): TrainingSessionExportFeedback {
  try {
    requestDownload(session);
    return {
      notice: "已请求下载但未确认落盘；Session 已安全保存在本机 IndexedDB，仍标记为待导出。",
      warning: null,
    };
  } catch (error) {
    return {
      notice: null,
      warning: `下载请求失败：${exportErrorMessage(error)}；Session 已安全保存在本机 IndexedDB，可稍后手动导出。`,
    };
  }
}

export function combineTrainingSessionExportFailures(
  directoryReason: string,
  fallback: TrainingSessionExportFeedback,
): TrainingSessionExportFeedback {
  const fallbackReason = fallback.warning
    ?? "已退回普通浏览器下载，但浏览器不会确认文件是否真正落盘；Session 仍安全保存在本机且保持未导出状态。";
  return {
    notice: fallback.notice,
    warning: `${directoryReason}；${fallbackReason}`,
  };
}

export function createTrainingSessionExportReceiptId(
  sessionId: string,
  exportedAtEpochMs: number,
) {
  return `${sessionId}:${exportedAtEpochMs}:${receiptNonce()}`;
}
