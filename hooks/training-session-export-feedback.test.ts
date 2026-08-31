import { describe, expect, it } from "vitest";
import type { TrainingSession } from "../lib/training-session";
import {
  combineTrainingSessionExportFailures,
  createTrainingSessionExportReceiptId,
  requestUnconfirmedTrainingSessionDownload,
} from "./training-session-export-feedback";

describe("training session export feedback", () => {
  it("keeps both the directory error and fallback download error", () => {
    const fallback = requestUnconfirmedTrainingSessionDownload(
      { id: "session-double-failure" } as TrainingSession,
      () => { throw new Error("downloads blocked"); },
    );

    const combined = combineTrainingSessionExportFailures(
      "自动保存文件夹写入失败：disk full",
      fallback,
    );

    expect(combined.warning).toContain("自动保存文件夹写入失败：disk full");
    expect(combined.warning).toContain("下载请求失败：downloads blocked");
    expect(combined.warning?.indexOf("disk full")).toBeLessThan(combined.warning?.indexOf("downloads blocked") ?? 0);
  });

  it("creates a distinct receipt for every physical write attempt", () => {
    const first = createTrainingSessionExportReceiptId("session-repeat", 1_788_131_200_000);
    const second = createTrainingSessionExportReceiptId("session-repeat", 1_788_131_200_000);

    expect(first).not.toBe(second);
    expect(first).toContain("session-repeat:1788131200000:");
    expect(second).toContain("session-repeat:1788131200000:");
  });
});
