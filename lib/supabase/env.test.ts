import { afterEach, describe, expect, it } from "vitest";
import {
  getSupabasePublicConfig,
  requireSupabasePublicConfig,
} from "./env";

const originalEnvironment = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
};

afterEach(() => {
  restoreEnvironmentVariable("NEXT_PUBLIC_SUPABASE_URL", originalEnvironment.url);
  restoreEnvironmentVariable(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    originalEnvironment.publishableKey,
  );
  restoreEnvironmentVariable("NEXT_PUBLIC_SUPABASE_ANON_KEY", originalEnvironment.anonKey);
});

describe("Supabase public configuration", () => {
  it("returns null when required values are missing", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    expect(getSupabasePublicConfig()).toBeNull();
    expect(() => requireSupabasePublicConfig()).toThrow(/Supabase is not configured/);
  });

  it("supports the existing legacy anon key", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "legacy-anon-key";

    expect(getSupabasePublicConfig()).toEqual({
      url: "https://example.supabase.co",
      key: "legacy-anon-key",
    });
  });

  it("prefers a publishable key when both key types exist", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "publishable-key";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "legacy-anon-key";

    expect(requireSupabasePublicConfig()).toEqual({
      url: "https://example.supabase.co",
      key: "publishable-key",
    });
  });
});

function restoreEnvironmentVariable(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
