import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PHASE_ONE_EVENT_NAMES } from "./events";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260830192551_app_events_analytics.sql"),
  "utf8",
).toLowerCase();

describe("analytics migration static security review", () => {
  it("keeps the database event allowlist synchronized with all 19 Phase 1 events", () => {
    expect(PHASE_ONE_EVENT_NAMES).toHaveLength(19);
    PHASE_ONE_EVENT_NAMES.forEach((eventName) => {
      expect(migration).toContain(`'${eventName}'`);
    });
  });

  it("gives service_role only event insert and token-hash select table permissions", () => {
    expect(migration).toMatch(/revoke all on table public\.app_events from public, anon, authenticated, service_role;/);
    expect(migration).toMatch(/grant insert on table public\.app_events to service_role;/);
    expect(migration).not.toMatch(/grant (select|update|delete).*public\.app_events.*service_role/);
    expect(migration).toMatch(/grant select on table public\.analytics_ingest_tokens to service_role;/);
    expect(migration).not.toMatch(/grant (insert|update|delete).*public\.analytics_ingest_tokens.*service_role/);
  });

  it("keeps reports and retention code private while enabling 90-day pg_cron cleanup", () => {
    expect(migration.match(/with \(security_invoker = true\)/g)).toHaveLength(6);
    expect(migration).toContain("security definer\nset search_path = ''");
    expect(migration).toContain("interval '90 days'");
    expect(migration).toContain("create extension if not exists pg_cron");
    expect(migration).toContain("fpvhelper-app-events-retention");
    expect(migration).toMatch(/revoke all on schema private from public, anon, authenticated, service_role;/);
  });

  it("groups the environment summary by every non-aggregate column, including build", () => {
    const environmentSummary = migration.match(
      /create view private\.environment_summary[\s\S]*?group by ([^;]+);/,
    );
    expect(environmentSummary?.[1].replaceAll(/\s+/g, " ").trim()).toBe("1, 2, 3, 4, 5, 6, 7, 8");
  });

  it("uses the independent intent ledger for commercial coverage and has no club join key", () => {
    expect(migration).toContain("private.training_intent_ledger");
    expect(migration).toContain("independent_intended_recordings");
    expect(migration).toContain("commercial_valid_coverage");
    expect(migration).toContain("tracked recording_started events must never replace or shrink this denominator");
    expect(migration).not.toMatch(/\bclub_(id|code)\b|references\s+[^\n]*club/);
  });
});
