import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  TrainingWeeklyReport,
  validateIntendedRecordingsInput,
  validateTrainingWeekStartInput,
} from "./training-weekly-report";

describe("training weekly report client boundary", () => {
  it("uses a stable empty server snapshot instead of freezing or hydrating a server-local date", () => {
    const html = renderToStaticMarkup(<TrainingWeeklyReport localSessions={[]} />);

    expect(html).toMatch(/type="date"[^>]*value=""/);
    expect(html).toContain("正在读取浏览器本地周起始日期");
    expect(html).toContain("— 待台账");
  });

  it("validates oversized and malformed ledger fields before report construction", () => {
    expect(validateIntendedRecordingsInput("1000001")).toMatchObject({ intendedRecordings: undefined, error: expect.stringContaining("1,000,000") });
    expect(validateIntendedRecordingsInput("1.5")).toMatchObject({ intendedRecordings: undefined, error: expect.stringContaining("整数") });
    expect(validateIntendedRecordingsInput("1000000")).toEqual({ intendedRecordings: 1_000_000, error: null });
  });

  it("accepts only a valid local Monday date", () => {
    expect(validateTrainingWeekStartInput("2026-08-31")).toMatchObject({ epochMs: expect.any(Number), error: null });
    expect(validateTrainingWeekStartInput("2026-09-01")).toEqual({ epochMs: null, error: "周开始必须选择本地周一" });
    expect(validateTrainingWeekStartInput("not-a-date")).toEqual({ epochMs: null, error: "请选择有效的本地日期" });
  });
});
