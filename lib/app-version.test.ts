import { describe, expect, it } from "vitest";
import { APP_VERSION, getAppVersionPayload } from "./app-version";

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
