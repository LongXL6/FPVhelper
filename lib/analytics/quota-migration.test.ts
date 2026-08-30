import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260830192551_app_events_analytics.sql"),
  "utf8",
).toLowerCase();

describe("analytics atomic quota migration", () => {
  it("keeps quota counters private, short-lived, and free of plaintext tokens or network identifiers", () => {
    expect(migration).toContain("create table private.analytics_ingest_quota_windows");
    expect(migration).toContain("token_id uuid not null references public.analytics_ingest_tokens(id)");
    expect(migration).toContain("alter table private.analytics_ingest_quota_windows enable row level security");
    expect(migration).toContain("window_started_at < now() - interval '1 day'");
    expect(migration).not.toMatch(/analytics_ingest_quota_windows[\s\S]{0,500}\b(token_hash|ip|user_agent)\b/);
  });

  it("uses one atomic upsert for a token/workstation fixed window", () => {
    expect(migration).toContain("on conflict (token_id, workstation_id, window_started_at) do update");
    expect(migration).toContain("request_count = private.analytics_ingest_quota_windows.request_count + 1");
    expect(migration).toContain("event_count = private.analytics_ingest_quota_windows.event_count + excluded.event_count");
    expect(migration).toContain("private.analytics_ingest_quota_windows.request_count < 120");
    expect(migration).toContain("private.analytics_ingest_quota_windows.event_count + excluded.event_count <= 1000");
  });

  it("exposes only a security-invoker RPC executable by service_role", () => {
    expect(migration).toMatch(/create or replace function public\.authorize_and_consume_analytics_quota\([\s\S]*?security invoker[\s\S]*?set search_path = ''/);
    expect(migration).toMatch(/revoke all on function public\.authorize_and_consume_analytics_quota\(text, uuid, integer\)[\s\S]*?from public, anon, authenticated;/);
    expect(migration).toMatch(/grant execute on function public\.authorize_and_consume_analytics_quota\(text, uuid, integer\)[\s\S]*?to service_role;/);
  });
});
