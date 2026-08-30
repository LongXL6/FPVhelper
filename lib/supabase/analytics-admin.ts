import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AnalyticsInsertRow } from "@/lib/analytics/server";
import { readAnalyticsAdminConfig } from "./analytics-admin-config";

let analyticsAdminClient: SupabaseClient | null = null;

function getAnalyticsAdminClient() {
  if (analyticsAdminClient) return analyticsAdminClient;
  const config = readAnalyticsAdminConfig();
  if (!config) return null;
  analyticsAdminClient = createClient(config.url, config.secretKey, {
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

export interface AnalyticsIngestAdmission {
  authorized: boolean;
  allowed: boolean;
  retryAfterSeconds: number;
}

export async function authorizeAndConsumeAnalyticsQuota(input: {
  tokenHash: string;
  workstationId: string;
  eventCount: number;
}): Promise<AnalyticsIngestAdmission> {
  const client = getAnalyticsAdminClient();
  if (!client) throw new Error("Analytics storage is not configured");

  const { data, error } = await client
    .rpc("authorize_and_consume_analytics_quota", {
      p_token_hash: input.tokenHash,
      p_workstation_id: input.workstationId,
      p_event_count: input.eventCount,
    });

  if (error) throw new Error("Analytics admission check failed");
  const result = Array.isArray(data) ? data[0] : data;
  if (
    !result
    || typeof result.authorized !== "boolean"
    || typeof result.allowed !== "boolean"
    || !Number.isSafeInteger(result.retry_after_seconds)
  ) throw new Error("Analytics admission response was invalid");
  return {
    authorized: result.authorized,
    allowed: result.allowed,
    retryAfterSeconds: Math.max(0, result.retry_after_seconds),
  };
}

export async function insertAnalyticsEvents(events: AnalyticsInsertRow[]) {
  const client = getAnalyticsAdminClient();
  if (!client) throw new Error("Analytics storage is not configured");

  const { error } = await client
    .from("app_events")
    .upsert(events, { onConflict: "event_id", ignoreDuplicates: true });
  if (error) throw new Error("Analytics insert failed");
}
