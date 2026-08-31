import { describe, expect, it } from "vitest";
import {
  assessOnboardingEnvironment,
  loadOnboardingDecision,
  ONBOARDING_DECISION_STORAGE_KEY,
  saveOnboardingDecision,
  shouldAutoOpenOnboarding,
} from "./onboarding";

describe("onboarding environment", () => {
  it("reports capabilities without claiming a browser from its user agent", () => {
    const environment = assessOnboardingEnvironment({
      userAgent: "A desktop browser",
      secureContext: true,
      serialSupported: true,
      mediaSupported: true,
      indexedDbSupported: true,
      directoryPickerSupported: false,
    });

    expect(environment.compatibilityNotice).toBeNull();
    expect(environment.directoryPickerSupported).toBe(false);
  });

  it("detects WeChat and recommends leaving the embedded browser without promising compatibility", () => {
    const environment = assessOnboardingEnvironment({
      userAgent: "Mozilla/5.0 MicroMessenger/8.0.50",
      secureContext: true,
      serialSupported: false,
      mediaSupported: false,
      indexedDbSupported: true,
      directoryPickerSupported: false,
    });

    expect(environment.isWeChat).toBe(true);
    expect(environment.compatibilityNotice).toContain("微信内置浏览器");
    expect(environment.compatibilityNotice).toContain("仍以本页能力检查和实际设备授权为准");
  });

  it("names missing secure, serial, and media capabilities accurately", () => {
    const environment = assessOnboardingEnvironment({
      userAgent: "Unknown",
      secureContext: false,
      serialSupported: false,
      mediaSupported: false,
      indexedDbSupported: false,
      directoryPickerSupported: false,
    });

    expect(environment.compatibilityNotice).toContain("安全上下文");
    expect(environment.compatibilityNotice).toContain("视频采集能力");
    expect(environment.compatibilityNotice).toContain("Web Serial");
  });
});

describe("local onboarding decision", () => {
  it("persists only the explicit decision value", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };

    expect(saveOnboardingDecision(storage, "acknowledged")).toBeNull();
    expect(values).toEqual(new Map([[ONBOARDING_DECISION_STORAGE_KEY, "acknowledged"]]));
    expect(loadOnboardingDecision(storage)).toBe("acknowledged");
    expect(shouldAutoOpenOnboarding("acknowledged")).toBe(false);
    expect(shouldAutoOpenOnboarding("later")).toBe(true);
  });

  it("fails safe when localStorage reads or writes are denied", () => {
    const blockedStorage = {
      getItem: () => { throw new DOMException("", "SecurityError"); },
      setItem: () => { throw new DOMException("", "SecurityError"); },
    };

    expect(loadOnboardingDecision(blockedStorage)).toBeNull();
    expect(shouldAutoOpenOnboarding(loadOnboardingDecision(blockedStorage))).toBe(true);
    expect(saveOnboardingDecision(blockedStorage, "later")).toContain("下次仍会显示");
  });
});
