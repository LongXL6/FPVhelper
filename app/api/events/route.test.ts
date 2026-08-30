import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  handleAnalyticsEventsRequest,
  MAX_ANALYTICS_BODY_BYTES,
  type AnalyticsInsertRow,
  type AnalyticsRequestDependencies,
} from "../../../lib/analytics/server";

const NOW = Date.parse("2026-08-31T00:00:00.000Z");
const TOKEN = `fpvh_ingest_${"a".repeat(43)}`;

function event(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "10000000-0000-4000-8000-000000000001",
    event_name: "overlay_layout_reset",
    occurred_at: new Date(NOW).toISOString(),
    client_monotonic_ms: 1234,
    workstation_id: "20000000-0000-4000-8000-000000000001",
    visit_id: "30000000-0000-4000-8000-000000000001",
    recording_id: null,
    build: "0.1.0+abcdef0",
    hostname: "helper.example.com",
    vercel_env: "production",
    session_schema_version: 2,
    connection: "live",
    video_state: "live",
    is_recording: false,
    overlay_mode: "trail",
    telemetry_source: "serial",
    props: { overlay_mode: "trail", was_default: false },
    ...overrides,
  };
}

function body(events = [event()]) {
  return JSON.stringify({ schema_version: 1, ingest_token: TOKEN, events });
}

function dependencies(overrides: Partial<AnalyticsRequestDependencies> = {}) {
  const inserted: AnalyticsInsertRow[][] = [];
  const input: AnalyticsRequestDependencies = {
    allowedHostnames: new Set(["helper.example.com"]),
    now: () => NOW,
    authorizeAndConsumeQuota: async () => ({ authorized: true, allowed: true, retryAfterSeconds: 0 }),
    insert: async (events) => { inserted.push(events); },
    ...overrides,
  };
  return { input, inserted };
}

function request(payload: string, contentType = "application/json", extraHeaders: Record<string, string> = {}) {
  return new Request("https://helper.example.com/api/events", {
    method: "POST",
    headers: { "content-type": contentType, ...extraHeaders },
    body: payload,
  });
}

describe("POST /api/events", () => {
  it.each(["application/json", "text/plain;charset=UTF-8"])("accepts strict %s batches and returns 204", async (contentType) => {
    let authorization: { tokenHash: string; workstationId: string; eventCount: number } | undefined;
    const deps = dependencies({
      authorizeAndConsumeQuota: async (input) => {
        authorization = input;
        return { authorized: true, allowed: true, retryAfterSeconds: 0 };
      },
    });
    const response = await handleAnalyticsEventsRequest(
      request(body(), contentType, { "user-agent": "private-agent", "x-forwarded-for": "203.0.113.8" }),
      deps.input,
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(authorization).toEqual({
      tokenHash: createHash("sha256").update(TOKEN).digest("hex"),
      workstationId: "20000000-0000-4000-8000-000000000001",
      eventCount: 1,
    });
    expect(deps.inserted).toHaveLength(1);
    expect(deps.inserted[0][0]).not.toHaveProperty("ingest_token");
    expect(deps.inserted[0][0]).not.toHaveProperty("ip");
    expect(deps.inserted[0][0]).not.toHaveProperty("user_agent");
  });

  it("rejects unsupported content types, malformed JSON, and oversized bodies", async () => {
    const deps = dependencies();
    expect((await handleAnalyticsEventsRequest(request(body(), "application/x-www-form-urlencoded"), deps.input)).status).toBe(415);
    expect((await handleAnalyticsEventsRequest(request("not-json"), deps.input)).status).toBe(400);
    expect((await handleAnalyticsEventsRequest(
      request("{}", "application/json", { "content-length": String(MAX_ANALYTICS_BODY_BYTES + 1) }),
      deps.input,
    )).status).toBe(413);
    expect(deps.inserted).toHaveLength(0);
  });

  it("rejects the whole batch for unknown props, UUIDs, timestamps, hostnames, and more than 50 events", async () => {
    const cases = [
      [event({ props: { overlay_mode: "trail", was_default: false, raw_bytes: [1, 2, 3] } })],
      [event({ event_id: "not-a-uuid" })],
      [event({ occurred_at: "2025-01-01T00:00:00.000Z" })],
      [event({ hostname: "other.example.com" })],
      Array.from({ length: 51 }, (_, index) => event({ event_id: `10000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}` })),
    ];

    for (const events of cases) {
      const deps = dependencies();
      const response = await handleAnalyticsEventsRequest(request(body(events)), deps.input);
      expect(response.status).toBe(422);
      expect(await response.text()).toBe("");
      expect(deps.inserted).toHaveLength(0);
    }
  });

  it("requires a configured hostname allowlist and a valid workstation token", async () => {
    const unavailable = dependencies({ allowedHostnames: new Set() });
    expect((await handleAnalyticsEventsRequest(request(body()), unavailable.input)).status).toBe(503);

    const unauthorized = dependencies({
      authorizeAndConsumeQuota: async () => ({ authorized: false, allowed: false, retryAfterSeconds: 0 }),
    });
    const response = await handleAnalyticsEventsRequest(request(body()), unauthorized.input);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
    expect(unauthorized.inserted).toHaveLength(0);
  });

  it("returns a body-free 429 with bounded Retry-After when the atomic quota is exhausted", async () => {
    const rateLimited = dependencies({
      authorizeAndConsumeQuota: async () => ({ authorized: true, allowed: false, retryAfterSeconds: 42.1 }),
    });
    const response = await handleAnalyticsEventsRequest(request(body()), rateLimited.input);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("43");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
    expect(rateLimited.inserted).toHaveLength(0);
  });

  it("does not reflect token, workstation, IP, or user-agent data in a 429 response", async () => {
    const rateLimited = dependencies({
      authorizeAndConsumeQuota: async () => ({ authorized: true, allowed: false, retryAfterSeconds: 9999 }),
    });
    const response = await handleAnalyticsEventsRequest(
      request(body(), "application/json", { "user-agent": "private-agent", "x-forwarded-for": "203.0.113.8" }),
      rateLimited.input,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("300");
    expect([...response.headers.entries()]).toEqual([
      ["cache-control", "no-store"],
      ["retry-after", "300"],
    ]);
    expect(await response.text()).toBe("");
  });

  it("returns a body-free 503 without logging the token or request body", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const deps = dependencies({ insert: async () => { throw new Error("database unavailable"); } });
    const response = await handleAnalyticsEventsRequest(request(body()), deps.input);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    consoleError.mockRestore();
    consoleLog.mockRestore();
  });
});
