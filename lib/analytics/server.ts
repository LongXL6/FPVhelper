import { createHash } from "node:crypto";
import {
  AnalyticsValidationError,
  validateAnalyticsBatch,
  type AnyAnalyticsEvent,
} from "./events";

export const MAX_ANALYTICS_BODY_BYTES = 64 * 1_024;

export interface AnalyticsInsertRow {
  event_id: string;
  workstation_id: string;
  visit_id: string;
  recording_id: string | null;
  event_name: string;
  occurred_at: string;
  client_monotonic_ms: number;
  build: string;
  hostname: string;
  vercel_env: "production";
  session_schema_version: number;
  connection: string;
  video_state: string;
  is_recording: boolean;
  overlay_mode: string;
  telemetry_source: string;
  props: Record<string, unknown>;
}

export interface AnalyticsRequestDependencies {
  allowedHostnames: ReadonlySet<string>;
  authorizeAndConsumeQuota(input: {
    tokenHash: string;
    workstationId: string;
    eventCount: number;
  }): Promise<{
    authorized: boolean;
    allowed: boolean;
    retryAfterSeconds: number;
  }>;
  insert(events: AnalyticsInsertRow[]): Promise<void>;
  now?: () => number;
}

function response(status: number, extraHeaders: Record<string, string> = {}) {
  return new Response(null, {
    status,
    headers: {
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function boundedRetryAfterSeconds(value: number) {
  if (!Number.isFinite(value)) return 5;
  return Math.min(300, Math.max(1, Math.ceil(value)));
}

function analyticsRow(event: AnyAnalyticsEvent): AnalyticsInsertRow {
  return {
    event_id: event.event_id,
    workstation_id: event.workstation_id,
    visit_id: event.visit_id,
    recording_id: event.recording_id,
    event_name: event.event_name,
    occurred_at: event.occurred_at,
    client_monotonic_ms: event.client_monotonic_ms,
    build: event.build,
    hostname: event.hostname,
    vercel_env: event.vercel_env,
    session_schema_version: event.session_schema_version,
    connection: event.connection,
    video_state: event.video_state,
    is_recording: event.is_recording,
    overlay_mode: event.overlay_mode,
    telemetry_source: event.telemetry_source,
    props: event.props as Record<string, unknown>,
  };
}

export async function handleAnalyticsEventsRequest(
  request: Request,
  dependencies: AnalyticsRequestDependencies,
) {
  if (dependencies.allowedHostnames.size === 0) return response(503);

  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json" && contentType !== "text/plain") return response(415);

  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) return response(400);
    if (length > MAX_ANALYTICS_BODY_BYTES) return response(413);
  }

  let rawBody: string;
  try {
    // Never log this body: it contains a workstation ingest token for the
    // sendBeacon path. Only its SHA-256 digest is passed to persistence.
    rawBody = await request.text();
  } catch {
    return response(400);
  }
  if (new TextEncoder().encode(rawBody).byteLength > MAX_ANALYTICS_BODY_BYTES) return response(413);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return response(400);
  }

  try {
    const batch = validateAnalyticsBatch(parsed, {
      now: dependencies.now?.() ?? Date.now(),
      allowedHostnames: dependencies.allowedHostnames,
    });
    const workstationId = batch.events[0].workstation_id;
    const tokenHash = createHash("sha256").update(batch.ingest_token, "utf8").digest("hex");
    const admission = await dependencies.authorizeAndConsumeQuota({
      tokenHash,
      workstationId,
      eventCount: batch.events.length,
    });
    if (!admission.authorized) return response(401);
    if (!admission.allowed) {
      return response(429, {
        "retry-after": String(boundedRetryAfterSeconds(admission.retryAfterSeconds)),
      });
    }
    await dependencies.insert(batch.events.map(analyticsRow));
    return response(204);
  } catch (error) {
    if (error instanceof AnalyticsValidationError) return response(422);
    return response(503);
  }
}
