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
