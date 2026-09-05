import { describe, expect, it } from "vitest";
import { APP_VERSION, getAppVersionPayload, getPublicBuildEnvironment } from "./app-version";

describe("getAppVersionPayload", () => {
  it("在没有 Vercel 环境变量时使用安全的本地构建号", () => {
    expect(getAppVersionPayload({})).toEqual({
      version: APP_VERSION,
      build: `${APP_VERSION}+local`,
      commitSha: null,
      environment: "development",
    });
  });

  it("只暴露短提交标识，不要求 Vercel 环境存在", () => {
    expect(getAppVersionPayload({
      VERCEL_GIT_COMMIT_SHA: "1234567890abcdef",
      VERCEL_ENV: "preview",
    })).toEqual({
      version: APP_VERSION,
      build: `${APP_VERSION}+1234567`,
      commitSha: "1234567890ab",
      environment: "preview",
    });
  });
});

describe("getPublicBuildEnvironment", () => {
  it("默认生成可追踪的本地版本且保持统计关闭", () => {
    expect(getPublicBuildEnvironment({})).toEqual({
      appVersion: `${APP_VERSION}+local`,
      analyticsEnabled: false,
      analyticsEnvironment: "development",
    });
  });

  it("只在明确启用的 Vercel production 构建中开放统计", () => {
    expect(getPublicBuildEnvironment({
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_SHA: "1234567890abcdef",
      NEXT_PUBLIC_ANALYTICS_ENABLED: "true",
    })).toEqual({
      appVersion: `${APP_VERSION}+1234567`,
      analyticsEnabled: true,
      analyticsEnvironment: "production",
    });
  });

  it("preview 即使误设开关也保持统计关闭", () => {
    expect(getPublicBuildEnvironment({
      VERCEL_ENV: "preview",
      NEXT_PUBLIC_ANALYTICS_ENABLED: "true",
      NEXT_PUBLIC_APP_VERSION: "0.2.0+preview",
    })).toEqual({
      appVersion: "0.2.0+preview",
      analyticsEnabled: false,
      analyticsEnvironment: "preview",
    });
  });
});
