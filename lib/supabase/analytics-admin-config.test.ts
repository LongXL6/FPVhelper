import { describe, expect, it } from "vitest";
import { readAnalyticsAdminConfig } from "./analytics-admin-config";

describe("analytics admin environment boundary", () => {
  it("accepts only the explicit independent FPVHelper analytics project settings", () => {
    expect(readAnalyticsAdminConfig({
      FPVHELPER_ANALYTICS_SUPABASE_URL: " https://fpvhelper.supabase.co ",
      FPVHELPER_ANALYTICS_SUPABASE_SECRET_KEY: " sb_secret_test ",
    })).toEqual({
      url: "https://fpvhelper.supabase.co",
      secretKey: "sb_secret_test",
    });
  });

  it("stays disabled when either dedicated server-only setting is missing", () => {
    expect(readAnalyticsAdminConfig({
      FPVHELPER_ANALYTICS_SUPABASE_URL: "https://fpvhelper.supabase.co",
    })).toBeNull();
    expect(readAnalyticsAdminConfig({
      FPVHELPER_ANALYTICS_SUPABASE_SECRET_KEY: "sb_secret_test",
    })).toBeNull();
  });

  it("does not read public, generic, or legacy Supabase variables", () => {
    const legacyOnly = {
      NEXT_PUBLIC_SUPABASE_URL: "https://other-project.supabase.co",
      SUPABASE_URL: "https://other-project.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_other",
      SUPABASE_SERVICE_ROLE_KEY: "legacy-service-role",
    };

    expect(readAnalyticsAdminConfig(legacyOnly)).toBeNull();
  });
});
