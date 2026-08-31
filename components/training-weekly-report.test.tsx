import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TrainingWeeklyReport } from "./training-weekly-report";

describe("training weekly report client boundary", () => {
  it("uses a stable empty server snapshot instead of freezing or hydrating a server-local date", () => {
    const html = renderToStaticMarkup(<TrainingWeeklyReport localSessions={[]} />);

    expect(html).toContain('type="date" value=""');
    expect(html).toContain("正在读取浏览器本地周起始日期");
    expect(html).toContain("— 待台账");
  });
});
