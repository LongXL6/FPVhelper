import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AnalyticsInsertRow } from "@/lib/analytics/server";

let analyticsAdminClient: SupabaseClient | null = null;

function analyticsAdminConfig() {
  const url = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL)?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  const legacyServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const key = secretKey || legacyServiceRoleKey;
  if (!url || !key) return null;
  return { url, key };
}

function getAnalyticsAdminClient() {
  if (analyticsAdminClient) return analyticsAdminClient;
  const config = analyticsAdminConfig();
  if (!config) return null;
  analyticsAdminClient = createClient(config.url, config.key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return analyticsAdminClient;
}

export function analyticsAllowedHostnames() {
  return new Set(
    (process.env.ANALYTICS_ALLOWED_HOSTNAMES ?? "")
      .split(",")
      .map((hostname) => hostname.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function authorizeAnalyticsIngest(input: { tokenHash: string; workstationId: string }) {
  const client = getAnalyticsAdminClient();
  if (!client) throw new Error("Analytics storage is not configured");

  const { data, error } = await client
    .from("analytics_ingest_tokens")
    .select("workstation_id, purpose, revoked_at, expires_at")
    .eq("token_hash", input.tokenHash)
    .eq("workstation_id", input.workstationId)
    .eq("purpose", "event_ingest")
    .is("revoked_at", null)
    .maybeSingle();

  if (error) throw new Error("Analytics token lookup failed");
  if (!data) return false;
  return data.expires_at === null || Date.parse(data.expires_at) > Date.now();
}

export async function insertAnalyticsEvents(events: AnalyticsInsertRow[]) {
  const client = getAnalyticsAdminClient();
  if (!client) throw new Error("Analytics storage is not configured");

  const { error } = await client
    .from("app_events")
    .upsert(events, { onConflict: "event_id", ignoreDuplicates: true });
  if (error) throw new Error("Analytics insert failed");
}
