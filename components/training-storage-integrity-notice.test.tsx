import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TrainingStorageIntegrityNotice } from "./training-storage-integrity-notice";

describe("TrainingStorageIntegrityNotice", () => {
  it("renders nothing when every local record is readable", () => {
    const markup = renderToStaticMarkup(<TrainingStorageIntegrityNotice integrity={{
      readableDraftCount: 0,
      readableSessionCount: 2,
      quarantinedDraftCount: 0,
      quarantinedSessionCount: 0,
    }} />);

    expect(markup).toBe("");
  });

  it("keeps read-only migration access distinct from unavailable or deleted data", () => {
    const markup = renderToStaticMarkup(<TrainingStorageIntegrityNotice integrity={{
      readableDraftCount: 0, readableSessionCount: 2, quarantinedDraftCount: 1, quarantinedSessionCount: 0,
      migrationWarning: "升级存储时空间不足。",
    }} />);
    expect(markup).toContain("本机记录暂以只读方式打开");
    expect(markup).toContain("升级存储时空间不足");
    expect(markup).toContain("现有可读记录可以查看和导出");
    expect(markup).toContain("新录制与本机修改暂不可用");
    expect(markup).not.toContain("新训练仍可使用");
  });

  it("states the quarantine count, usable boundary, and raw-record retention", () => {
    const markup = renderToStaticMarkup(<TrainingStorageIntegrityNotice integrity={{
      readableDraftCount: 1,
      readableSessionCount: 3,
      quarantinedDraftCount: 1,
      quarantinedSessionCount: 2,
    }} />);

    expect(markup).toContain("已隔离 3 条异常记录");
    expect(markup).toContain("其余 3 条 Session 与新训练仍可使用");
    expect(markup).toContain("不会进入恢复、今日列表、导出或有效统计");
    expect(markup).toContain("原始异常记录仍保留在 IndexedDB");
  });
});
