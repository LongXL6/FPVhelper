import { beginUnconfirmedTrainingSessionDownload } from "../lib/training-session-export";
import type { TrainingSession } from "../lib/training-session";

export interface TrainingSessionExportFeedback {
  notice: string | null;
  warning: string | null;
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
