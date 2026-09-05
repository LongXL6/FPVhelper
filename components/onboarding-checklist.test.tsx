import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OnboardingChecklist } from "./onboarding-checklist";

describe("OnboardingChecklist", () => {
  it("renders a reusable trigger and an accessibly named dialog before browser inspection", () => {
    const markup = renderToStaticMarkup(<OnboardingChecklist />);

    expect(markup).toContain(">安装检查</button>");
    expect(markup).toContain("<dialog");
    expect(markup).toContain('aria-labelledby="onboarding-title"');
    expect(markup).toContain('aria-describedby="onboarding-privacy"');
    expect(markup).toContain("不连接设备、不打开权限选择器、不发送检查结果");
  });
});
