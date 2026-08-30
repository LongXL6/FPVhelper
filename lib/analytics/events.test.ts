import { describe, expect, it } from "vitest";
import {
  AnalyticsValidationError,
  PHASE_ONE_EVENT_NAMES,
  validateAnalyticsBatch,
  validateAnalyticsEvent,
  type AnyAnalyticsEvent,
  type PhaseOneEventName,
  type PhaseOneEventProps,
} from "./events";

const NOW = Date.parse("2026-08-31T00:00:00.000Z");
const WORKSTATION_ID = "20000000-0000-4000-8000-000000000001";
const VISIT_ID = "30000000-0000-4000-8000-000000000001";
const RECORDING_ID = "40000000-0000-4000-8000-000000000001";
const TOKEN = `fpvh_ingest_${"a".repeat(43)}`;

const PROPS: { [Name in PhaseOneEventName]: PhaseOneEventProps[Name] } = {
  app_opened: {
    browser_family: "chrome", browser_major: 140, os_family: "macos", serial_supported: true,
    secure_context: true, media_supported: true, viewport_w: 1440, viewport_h: 900, dpr: 2,
    is_wechat: false, is_standalone: false, referrer_host: "",
  },
  video_connect_result: { ok: true, device_kind: "capture_card", width: 1920, height: 1080, frame_rate: 60, latency_ms: 420, attempt_index: 1 },
  video_lost: { live_ms: 60_000, was_recording: true, device_kind: "capture_card" },
  serial_connect_result: { ok: true, stage: "handshake", ms_to_first_frame: 850, usb_vendor_id: 1155, usb_product_id: 22336, attempt_index: 1 },
  serial_lost: { reason: "device_disconnect", live_ms: 60_000, was_recording: true, rc_frames: 1200, analog_frames: 60, checksum_errors: 1, error_frames: 0, effective_hz: 20 },
  telemetry_stalled: { was_recording: true, tab_hidden: false, rc_frames_before: 1200 },
  telemetry_resumed: { stall_ms: 1800, was_recording: true, tab_hidden: false, rc_frames_before: 1200 },
  demo_returned: { was_recording: false, previous_connection: "stale", serial_live_ms: 80_000 },
  recording_started: { recording_id: RECORDING_ID, connection_at_start: "live", source_at_start: "serial", video_state: "live", athlete_set: true, prev_unexported: false, recording_index: 1, ms_since_serial_live: 2_000 },
  recording_stopped: { recording_id: RECORDING_ID, duration_ms: 60_000, sample_count: 1200, hz: 20, data_sources: ["ground_rc"], valid: true, invalid_reasons: [], max_gap_ms: 100, hidden_ms: 0, stall_count: 0, athlete_set: true },
  session_exported: { recording_id: RECORDING_ID, valid: true, ms_since_stop: 1200, bytes: 20_000, export_index: 1, method: "download" },
  session_lost: { reason: "unload", recording_id: RECORDING_ID, valid: false, duration_ms: 30_000, sample_count: 500, ms_since_stop: 0 },
  page_hidden: { was_recording: false, connection: "live", video_state: "live" },
  page_visible: { was_recording: false, hidden_ms: 3000, connection: "live", video_state: "live" },
  page_unloaded: { page_duration_ms: 120_000, is_recording: false, has_unexported_session: false, max_funnel_step: 6, recordings_started: 1, recordings_stopped: 1, sessions_exported: 1, error_count: 0, serial_live_ms_total: 100_000, video_live_ms_total: 110_000 },
  error_shown: { domain: "video", code: "video_device_busy", stage: "capture", fingerprint: "0123456789abcdef", masked_other: false, shown_index: 1, is_recording: false },
  js_error: { code: "unexpected_exception", stage: "runtime", fingerprint: "fedcba9876543210" },
  overlay_mode_changed: { from: "trail", to: "simple", is_recording: false },
  overlay_layout_reset: { overlay_mode: "trail", was_default: false },
};

function eventId(index: number) {
  return `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function event<Name extends PhaseOneEventName>(name: Name, index = 1): AnyAnalyticsEvent {
  const props = PROPS[name];
  const recordingId = "recording_id" in props ? props.recording_id : null;
  return {
    event_id: eventId(index), event_name: name, occurred_at: new Date(NOW).toISOString(), client_monotonic_ms: 100,
    workstation_id: WORKSTATION_ID, visit_id: VISIT_ID, recording_id: recordingId, build: "0.1.0+abcdef0",
    hostname: "helper.example.com", vercel_env: "production", session_schema_version: 2, connection: "live",
    video_state: "live", is_recording: false, overlay_mode: "trail", telemetry_source: "serial", props,
  } as AnyAnalyticsEvent;
}

describe("Phase 1 analytics schema", () => {
  it("expands the tracking plan into exactly 19 concrete event names", () => {
    expect(PHASE_ONE_EVENT_NAMES).toHaveLength(19);
    expect(new Set(PHASE_ONE_EVENT_NAMES).size).toBe(19);
    expect(PHASE_ONE_EVENT_NAMES).toContain("telemetry_stalled");
    expect(PHASE_ONE_EVENT_NAMES).toContain("telemetry_resumed");
    expect(PHASE_ONE_EVENT_NAMES).toContain("page_hidden");
    expect(PHASE_ONE_EVENT_NAMES).toContain("page_visible");
  });

  it("validates one strict envelope for every event", () => {
    PHASE_ONE_EVENT_NAMES.forEach((name, index) => {
      expect(validateAnalyticsEvent(event(name, index + 1), { now: NOW })).toMatchObject({ event_name: name });
    });
  });

  it("rejects arbitrary props and arbitrary JSON array elements", () => {
    const extra = event("app_opened") as unknown as Record<string, unknown>;
    extra.props = { ...(extra.props as object), device_label: "USB Capture HDMI" };
    expect(() => validateAnalyticsEvent(extra, { now: NOW })).toThrow(AnalyticsValidationError);

    const array = event("recording_stopped") as unknown as Record<string, unknown>;
    array.props = { ...(array.props as object), data_sources: ["ground_rc", { raw: [1, 2, 3] }] };
    expect(() => validateAnalyticsEvent(array, { now: NOW })).toThrow(/数组元素不在白名单/);
  });

  it("rejects invalid enum arrays, duplicate IDs, mixed workstations and unknown hosts", () => {
    const invalidReasons = event("recording_stopped") as unknown as Record<string, unknown>;
    invalidReasons.props = { ...(invalidReasons.props as object), valid: false, invalid_reasons: ["too_short", "too_short"] };
    expect(() => validateAnalyticsEvent(invalidReasons, { now: NOW })).toThrow(/不可重复/);

    const first = event("app_opened", 1);
    expect(() => validateAnalyticsBatch({ schema_version: 1, ingest_token: TOKEN, events: [first, first] }, { now: NOW })).toThrow(/重复 event_id/);

    const second = { ...event("app_opened", 2), workstation_id: "20000000-0000-4000-8000-000000000002" };
    expect(() => validateAnalyticsBatch({ schema_version: 1, ingest_token: TOKEN, events: [first, second] }, { now: NOW })).toThrow(/一个批次/);
    expect(() => validateAnalyticsEvent(first, { now: NOW, allowedHostnames: new Set(["other.example.com"]) })).toThrow(/hostname/);
  });

  it("rejects the entire batch when any event is invalid or the batch exceeds 50", () => {
    const events = Array.from({ length: 51 }, (_, index) => event("app_opened", index + 1));
    expect(() => validateAnalyticsBatch({ schema_version: 1, ingest_token: TOKEN, events }, { now: NOW })).toThrow(/1 至 50/);

    const bad = event("app_opened", 2) as unknown as Record<string, unknown>;
    bad.hostname = "https://not-a-host.example";
    expect(() => validateAnalyticsBatch({ schema_version: 1, ingest_token: TOKEN, events: [event("app_opened"), bad] }, { now: NOW })).toThrow(/hostname/);
  });
});
