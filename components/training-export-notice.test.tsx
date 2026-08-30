import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TrainingExportNotice } from "./training-export-notice";

describe("TrainingExportNotice", () => {
  it("shows an unconfirmed-download notice without presenting a storage failure", () => {
    const markup = renderToStaticMarkup(
      <TrainingExportNotice
        notice="已请求下载但未确认落盘；记录仍标记为待导出。"
        warning={null}
      />,
    );

    expect(markup).toContain("导出提示");
    expect(markup).toContain("已请求下载但未确认落盘");
    expect(markup).not.toContain("export-banner--warning");
  });

  it("renders download failures as non-storage export warnings", () => {
    const markup = renderToStaticMarkup(
      <TrainingExportNotice
        notice={null}
        warning="下载请求失败；Session 已安全保存在本机。"
      />,
    );

    expect(markup).toContain("导出警告");
    expect(markup).toContain("export-banner--warning");
    expect(markup).toContain("Session 已安全保存在本机");
  });

  it("renders nothing without export feedback", () => {
    expect(renderToStaticMarkup(
      <TrainingExportNotice notice={null} warning={null} />,
    )).toBe("");
  });
});
