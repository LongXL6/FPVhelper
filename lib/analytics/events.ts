import {
  ANALYTICS_ERROR_CODES,
  ANALYTICS_ERROR_DOMAINS,
  ANALYTICS_ERROR_STAGES,
  type AnalyticsErrorCode,
  type AnalyticsErrorDomain,
  type AnalyticsErrorStage,
} from "./error-codes";

export const PHASE_ONE_EVENT_NAMES = [
  "app_opened",
  "video_connect_result",
  "video_lost",
  "serial_connect_result",
  "serial_lost",
  "telemetry_stalled",
  "telemetry_resumed",
  "demo_returned",
  "recording_started",
  "recording_stopped",
  "session_exported",
  "session_lost",
  "page_hidden",
  "page_visible",
  "page_unloaded",
  "error_shown",
  "js_error",
  "overlay_mode_changed",
  "overlay_layout_reset",
] as const;

export type PhaseOneEventName = (typeof PHASE_ONE_EVENT_NAMES)[number];

export type AnalyticsConnectionState = "demo" | "connecting" | "live" | "stale" | "error";
export type AnalyticsVideoState = "idle" | "connecting" | "live" | "error";
export type AnalyticsOverlayMode = "trail" | "simple";
export type AnalyticsTelemetrySource = "demo" | "serial";
export type AnalyticsRecordedSource = "demo" | "ground_rc";
export type AnalyticsInvalidReason =
  | "source_not_ground_rc"
  | "mixed_sources"
  | "too_short"
  | "too_few_unique_samples"
  | "non_monotonic"
  | "no_athlete_code"
  | "interrupted";

export interface PhaseOneEventProps {
  app_opened: {
    browser_family: "chrome" | "edge" | "safari" | "firefox" | "wechat" | "other" | "unknown";
    browser_major: number;
    os_family: "windows" | "macos" | "linux" | "android" | "ios" | "chromeos" | "other" | "unknown";
    serial_supported: boolean;
    secure_context: boolean;
    media_supported: boolean;
    viewport_w: number;
    viewport_h: number;
    dpr: number;
    is_wechat: boolean;
    is_standalone: boolean;
    referrer_host: string;
  };
  video_connect_result: {
    ok: boolean;
    reason?: "unsupported" | "insecure_context" | "permission_denied" | "device_not_found" | "device_busy" | "constraint_failed" | "aborted" | "unknown";
    device_kind: "capture_card" | "webcam" | "virtual" | "unknown";
    width?: number;
    height?: number;
    frame_rate?: number;
    latency_ms: number;
    attempt_index: number;
  };
  video_lost: {
    live_ms: number;
    was_recording: boolean;
    device_kind: "capture_card" | "webcam" | "virtual" | "unknown";
  };
  serial_connect_result: {
    ok: boolean;
    reason?: "web_serial_unsupported" | "picker_cancelled" | "port_busy" | "open_failed" | "not_readable" | "not_writable" | "first_frame_timeout" | "device_lost" | "unknown";
    stage: "unsupported" | "picker" | "open" | "handshake";
    ms_to_first_frame?: number;
    usb_vendor_id?: number;
    usb_product_id?: number;
    attempt_index: number;
  };
  serial_lost: {
    reason: "read_error" | "write_error" | "device_disconnect" | "user_demo" | "unmount";
    live_ms: number;
    was_recording: boolean;
    rc_frames: number;
    analog_frames: number;
    checksum_errors: number;
    error_frames: number;
    effective_hz: number;
  };
  telemetry_stalled: {
    was_recording: boolean;
    tab_hidden: boolean;
    rc_frames_before: number;
  };
  telemetry_resumed: {
    stall_ms: number;
    was_recording: boolean;
    tab_hidden: boolean;
    rc_frames_before: number;
  };
  demo_returned: {
    was_recording: boolean;
    previous_connection: AnalyticsConnectionState;
    serial_live_ms: number;
  };
  recording_started: {
    recording_id: string;
    connection_at_start: AnalyticsConnectionState;
    source_at_start: AnalyticsTelemetrySource;
    video_state: AnalyticsVideoState;
    athlete_set: boolean;
    prev_unexported: boolean;
    recording_index: number;
    ms_since_serial_live: number;
  };
  recording_stopped: {
    recording_id: string;
    duration_ms: number;
    sample_count: number;
    hz: number;
    data_sources: AnalyticsRecordedSource[];
    valid: boolean;
    invalid_reasons: AnalyticsInvalidReason[];
    max_gap_ms: number;
    hidden_ms: number;
    stall_count: number;
    athlete_set: boolean;
  };
  session_exported: {
    recording_id: string;
    valid: boolean;
    ms_since_stop: number;
    bytes: number;
    export_index: number;
    method: "download" | "auto" | "folder";
  };
  session_lost: {
    reason: "overwritten" | "unload" | "recording_interrupted";
    recording_id: string;
    /** For recording_interrupted, validity is evaluated before interruption itself. */
    valid: boolean;
    duration_ms: number;
    sample_count: number;
    ms_since_stop: number;
  };
  page_hidden: {
    was_recording: boolean;
    connection: AnalyticsConnectionState;
    video_state: AnalyticsVideoState;
  };
  page_visible: {
    was_recording: boolean;
    hidden_ms: number;
    connection: AnalyticsConnectionState;
    video_state: AnalyticsVideoState;
  };
  page_unloaded: {
    page_duration_ms: number;
    is_recording: boolean;
    has_unexported_session: boolean;
    max_funnel_step: number;
    recordings_started: number;
    recordings_stopped: number;
    sessions_exported: number;
    error_count: number;
    serial_live_ms_total: number;
    video_live_ms_total: number;
  };
  error_shown: {
    domain: AnalyticsErrorDomain;
    code: AnalyticsErrorCode;
    stage: AnalyticsErrorStage;
    fingerprint: string;
    masked_other: boolean;
    shown_index: number;
    is_recording: boolean;
  };
  js_error: {
    code: "unexpected_exception";
    stage: AnalyticsErrorStage;
    fingerprint: string;
  };
  overlay_mode_changed: {
    from: AnalyticsOverlayMode;
    to: AnalyticsOverlayMode;
    is_recording: boolean;
  };
  overlay_layout_reset: {
    overlay_mode: AnalyticsOverlayMode;
    was_default: boolean;
  };
}

export interface AnalyticsEventEnvelope<Name extends PhaseOneEventName = PhaseOneEventName> {
  event_id: string;
  event_name: Name;
  occurred_at: string;
  client_monotonic_ms: number;
  workstation_id: string;
  visit_id: string;
  recording_id: string | null;
  build: string;
  hostname: string;
  vercel_env: "production";
  session_schema_version: number;
  connection: AnalyticsConnectionState;
  video_state: AnalyticsVideoState;
  is_recording: boolean;
  overlay_mode: AnalyticsOverlayMode;
  telemetry_source: AnalyticsTelemetrySource;
  props: PhaseOneEventProps[Name];
}

export type AnyAnalyticsEvent = {
  [Name in PhaseOneEventName]: AnalyticsEventEnvelope<Name>;
}[PhaseOneEventName];

export interface AnalyticsBatchPayload {
  schema_version: 1;
  ingest_token: string;
  events: AnyAnalyticsEvent[];
}

export class AnalyticsValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "AnalyticsValidationError";
  }
}

type Rule =
  | { kind: "boolean"; optional?: true }
  | { kind: "number"; min: number; max: number; integer?: true; optional?: true }
  | { kind: "string"; minLength: number; maxLength: number; pattern?: RegExp; optional?: true }
  | { kind: "enum"; values: readonly string[]; optional?: true }
  | { kind: "array"; values: readonly string[]; minLength: number; maxLength: number; unique?: true; optional?: true };

type EventRules = { [Name in PhaseOneEventName]: Record<keyof PhaseOneEventProps[Name], Rule> };

const CONNECTIONS = ["demo", "connecting", "live", "stale", "error"] as const;
const VIDEO_STATES = ["idle", "connecting", "live", "error"] as const;
const OVERLAY_MODES = ["trail", "simple"] as const;
const RECORDED_SOURCES = ["demo", "ground_rc"] as const;
const INVALID_REASONS = [
  "source_not_ground_rc",
  "mixed_sources",
  "too_short",
  "too_few_unique_samples",
  "non_monotonic",
  "no_athlete_code",
  "interrupted",
] as const;
const HOST_PATTERN = /^(?:$|(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{16,64}$/;
const BUILD_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}$/;
const INGEST_TOKEN_PATTERN = /^fpvh_ingest_[A-Za-z0-9_-]{43,128}$/;

const bool = (): Rule => ({ kind: "boolean" });
const number = (min: number, max: number, integer = false, optional = false): Rule => ({
  kind: "number",
  min,
  max,
  ...(integer ? { integer: true as const } : {}),
  ...(optional ? { optional: true as const } : {}),
});
const string = (minLength: number, maxLength: number, pattern?: RegExp, optional = false): Rule => ({
  kind: "string",
  minLength,
  maxLength,
  ...(pattern ? { pattern } : {}),
  ...(optional ? { optional: true as const } : {}),
});
const oneOf = (values: readonly string[], optional = false): Rule => ({
  kind: "enum",
  values,
  ...(optional ? { optional: true as const } : {}),
});
const arrayOf = (values: readonly string[], minLength: number, maxLength: number): Rule => ({
  kind: "array",
  values,
  minLength,
  maxLength,
  unique: true,
});

const EVENT_PROP_RULES: EventRules = {
  app_opened: {
    browser_family: oneOf(["chrome", "edge", "safari", "firefox", "wechat", "other", "unknown"]),
    browser_major: number(0, 999, true),
    os_family: oneOf(["windows", "macos", "linux", "android", "ios", "chromeos", "other", "unknown"]),
    serial_supported: bool(), secure_context: bool(), media_supported: bool(),
    viewport_w: number(0, 16_384, true), viewport_h: number(0, 16_384, true), dpr: number(0.1, 10),
    is_wechat: bool(), is_standalone: bool(), referrer_host: string(0, 253, HOST_PATTERN),
  },
  video_connect_result: {
    ok: bool(),
    reason: oneOf(["unsupported", "insecure_context", "permission_denied", "device_not_found", "device_busy", "constraint_failed", "aborted", "unknown"], true),
    device_kind: oneOf(["capture_card", "webcam", "virtual", "unknown"]),
    width: number(1, 16_384, true, true), height: number(1, 16_384, true, true), frame_rate: number(0, 1_000, false, true),
    latency_ms: number(0, 600_000), attempt_index: number(1, 10_000, true),
  },
  video_lost: {
    live_ms: number(0, 31_536_000_000), was_recording: bool(),
    device_kind: oneOf(["capture_card", "webcam", "virtual", "unknown"]),
  },
  serial_connect_result: {
    ok: bool(),
    reason: oneOf(["web_serial_unsupported", "picker_cancelled", "port_busy", "open_failed", "not_readable", "not_writable", "first_frame_timeout", "device_lost", "unknown"], true),
    stage: oneOf(["unsupported", "picker", "open", "handshake"]),
    ms_to_first_frame: number(0, 600_000, false, true), usb_vendor_id: number(0, 65_535, true, true),
    usb_product_id: number(0, 65_535, true, true), attempt_index: number(1, 10_000, true),
  },
  serial_lost: {
    reason: oneOf(["read_error", "write_error", "device_disconnect", "user_demo", "unmount"]),
    live_ms: number(0, 31_536_000_000), was_recording: bool(), rc_frames: number(0, 1_000_000_000, true),
    analog_frames: number(0, 1_000_000_000, true), checksum_errors: number(0, 1_000_000_000, true),
    error_frames: number(0, 1_000_000_000, true), effective_hz: number(0, 1_000),
  },
  telemetry_stalled: { was_recording: bool(), tab_hidden: bool(), rc_frames_before: number(0, 1_000_000_000, true) },
  telemetry_resumed: { stall_ms: number(0, 31_536_000_000), was_recording: bool(), tab_hidden: bool(), rc_frames_before: number(0, 1_000_000_000, true) },
  demo_returned: { was_recording: bool(), previous_connection: oneOf(CONNECTIONS), serial_live_ms: number(0, 31_536_000_000) },
  recording_started: {
    recording_id: string(36, 36, UUID_PATTERN), connection_at_start: oneOf(CONNECTIONS), source_at_start: oneOf(["demo", "serial"]),
    video_state: oneOf(VIDEO_STATES), athlete_set: bool(), prev_unexported: bool(), recording_index: number(1, 1_000_000, true),
    ms_since_serial_live: number(0, 31_536_000_000),
  },
  recording_stopped: {
    recording_id: string(36, 36, UUID_PATTERN), duration_ms: number(0, 86_400_000), sample_count: number(0, 10_000_000, true),
    hz: number(0, 1_000), data_sources: arrayOf(RECORDED_SOURCES, 1, 2), valid: bool(),
    invalid_reasons: arrayOf(INVALID_REASONS, 0, INVALID_REASONS.length), max_gap_ms: number(0, 86_400_000),
    hidden_ms: number(0, 86_400_000), stall_count: number(0, 1_000_000, true), athlete_set: bool(),
  },
  session_exported: {
    recording_id: string(36, 36, UUID_PATTERN), valid: bool(), ms_since_stop: number(0, 31_536_000_000),
    bytes: number(0, 1_000_000_000, true), export_index: number(1, 1_000_000, true), method: oneOf(["download", "auto", "folder"]),
  },
  session_lost: {
    reason: oneOf(["overwritten", "unload", "recording_interrupted"]), recording_id: string(36, 36, UUID_PATTERN),
    valid: bool(), duration_ms: number(0, 86_400_000), sample_count: number(0, 10_000_000, true), ms_since_stop: number(0, 31_536_000_000),
  },
  page_hidden: { was_recording: bool(), connection: oneOf(CONNECTIONS), video_state: oneOf(VIDEO_STATES) },
  page_visible: { was_recording: bool(), hidden_ms: number(0, 31_536_000_000), connection: oneOf(CONNECTIONS), video_state: oneOf(VIDEO_STATES) },
  page_unloaded: {
    page_duration_ms: number(0, 31_536_000_000), is_recording: bool(), has_unexported_session: bool(), max_funnel_step: number(1, 6, true),
    recordings_started: number(0, 1_000_000, true), recordings_stopped: number(0, 1_000_000, true), sessions_exported: number(0, 1_000_000, true),
    error_count: number(0, 1_000_000, true), serial_live_ms_total: number(0, 31_536_000_000), video_live_ms_total: number(0, 31_536_000_000),
  },
  error_shown: {
    domain: oneOf(ANALYTICS_ERROR_DOMAINS), code: oneOf(ANALYTICS_ERROR_CODES), stage: oneOf(ANALYTICS_ERROR_STAGES),
    fingerprint: string(16, 64, FINGERPRINT_PATTERN), masked_other: bool(), shown_index: number(1, 1_000_000, true), is_recording: bool(),
  },
  js_error: { code: oneOf(["unexpected_exception"]), stage: oneOf(ANALYTICS_ERROR_STAGES), fingerprint: string(16, 64, FINGERPRINT_PATTERN) },
  overlay_mode_changed: { from: oneOf(OVERLAY_MODES), to: oneOf(OVERLAY_MODES), is_recording: bool() },
  overlay_layout_reset: { overlay_mode: oneOf(OVERLAY_MODES), was_default: bool() },
};

const EVENT_FIELDS = [
  "event_id", "event_name", "occurred_at", "client_monotonic_ms", "workstation_id", "visit_id", "recording_id",
  "build", "hostname", "vercel_env", "session_schema_version", "connection", "video_state", "is_recording", "overlay_mode",
  "telemetry_source", "props",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new AnalyticsValidationError(`${field}.${key}`, "字段不在白名单中");
  }
}

function validateRule(value: unknown, rule: Rule, field: string) {
  if (value === undefined && rule.optional) return;
  if (rule.kind === "boolean") {
    if (typeof value !== "boolean") throw new AnalyticsValidationError(field, "必须是布尔值");
    return;
  }
  if (rule.kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < rule.min || value > rule.max || (rule.integer && !Number.isInteger(value))) {
      throw new AnalyticsValidationError(field, "数字超出允许范围");
    }
    return;
  }
  if (rule.kind === "string") {
    if (typeof value !== "string" || value.length < rule.minLength || value.length > rule.maxLength || (rule.pattern && !rule.pattern.test(value))) {
      throw new AnalyticsValidationError(field, "字符串格式无效");
    }
    return;
  }
  if (rule.kind === "enum") {
    if (typeof value !== "string" || !rule.values.includes(value)) throw new AnalyticsValidationError(field, "枚举值无效");
    return;
  }
  if (!Array.isArray(value) || value.length < rule.minLength || value.length > rule.maxLength) {
    throw new AnalyticsValidationError(field, "数组长度无效");
  }
  if (value.some((item) => typeof item !== "string" || !rule.values.includes(item))) {
    throw new AnalyticsValidationError(field, "数组元素不在白名单中");
  }
  if (rule.unique && new Set(value).size !== value.length) throw new AnalyticsValidationError(field, "数组元素不可重复");
}

export function validateEventProps<Name extends PhaseOneEventName>(name: Name, value: unknown): PhaseOneEventProps[Name] {
  if (!isRecord(value)) throw new AnalyticsValidationError("props", "必须是对象");
  const rules = EVENT_PROP_RULES[name] as Record<string, Rule>;
  assertExactKeys(value, Object.keys(rules), "props");
  for (const [key, rule] of Object.entries(rules)) validateRule(value[key], rule, `props.${key}`);

  if ((name === "video_connect_result" || name === "serial_connect_result") && value.ok === false && value.reason === undefined) {
    throw new AnalyticsValidationError("props.reason", "失败结果必须提供稳定原因枚举");
  }
  if ((name === "video_connect_result" || name === "serial_connect_result") && value.ok === true && value.reason !== undefined) {
    throw new AnalyticsValidationError("props.reason", "成功结果不能带失败原因");
  }
  if (name === "recording_stopped" && value.valid === true && Array.isArray(value.invalid_reasons) && value.invalid_reasons.length > 0) {
    throw new AnalyticsValidationError("props.invalid_reasons", "有效记录不能带无效原因");
  }
  if (name === "recording_stopped" && value.valid === false && Array.isArray(value.invalid_reasons) && value.invalid_reasons.length === 0) {
    throw new AnalyticsValidationError("props.invalid_reasons", "无效记录必须带至少一个稳定原因");
  }
  if (name === "overlay_mode_changed" && value.from === value.to) {
    throw new AnalyticsValidationError("props.to", "叠层模式必须确实发生变化");
  }
  return value as unknown as PhaseOneEventProps[Name];
}

function validateUuid(value: unknown, field: string, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new AnalyticsValidationError(field, "必须是 UUID");
}

export interface AnalyticsValidationOptions {
  now?: number;
  allowedHostnames?: ReadonlySet<string>;
}

export function validateAnalyticsEvent(value: unknown, options: AnalyticsValidationOptions = {}): AnyAnalyticsEvent {
  if (!isRecord(value)) throw new AnalyticsValidationError("event", "必须是对象");
  assertExactKeys(value, EVENT_FIELDS, "event");

  validateUuid(value.event_id, "event.event_id");
  validateUuid(value.workstation_id, "event.workstation_id");
  validateUuid(value.visit_id, "event.visit_id");
  validateUuid(value.recording_id, "event.recording_id", true);

  if (typeof value.event_name !== "string" || !(PHASE_ONE_EVENT_NAMES as readonly string[]).includes(value.event_name)) {
    throw new AnalyticsValidationError("event.event_name", "事件名不在 Phase 1 白名单中");
  }
  if (typeof value.occurred_at !== "string" || value.occurred_at.length > 35 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.occurred_at)) {
    throw new AnalyticsValidationError("event.occurred_at", "必须是带时区的 ISO 时间");
  }
  const occurredAt = Date.parse(value.occurred_at);
  const now = options.now ?? Date.now();
  if (!Number.isFinite(occurredAt) || occurredAt < now - 7 * 24 * 60 * 60 * 1_000 || occurredAt > now + 24 * 60 * 60 * 1_000) {
    throw new AnalyticsValidationError("event.occurred_at", "时间超出离线保留窗口");
  }
  validateRule(value.client_monotonic_ms, number(0, 31_536_000_000), "event.client_monotonic_ms");
  validateRule(value.build, string(1, 80, BUILD_PATTERN), "event.build");
  validateRule(value.hostname, string(1, 253, HOST_PATTERN), "event.hostname");
  if (options.allowedHostnames && !options.allowedHostnames.has(value.hostname as string)) {
    throw new AnalyticsValidationError("event.hostname", "hostname 未获准上报");
  }
  validateRule(value.vercel_env, oneOf(["production"]), "event.vercel_env");
  validateRule(value.session_schema_version, number(1, 1_000, true), "event.session_schema_version");
  validateRule(value.connection, oneOf(CONNECTIONS), "event.connection");
  validateRule(value.video_state, oneOf(VIDEO_STATES), "event.video_state");
  validateRule(value.is_recording, bool(), "event.is_recording");
  validateRule(value.overlay_mode, oneOf(OVERLAY_MODES), "event.overlay_mode");
  validateRule(value.telemetry_source, oneOf(["demo", "serial"]), "event.telemetry_source");

  const name = value.event_name as PhaseOneEventName;
  validateEventProps(name, value.props);
  const propsBytes = new TextEncoder().encode(JSON.stringify(value.props)).byteLength;
  if (propsBytes > 4_096) throw new AnalyticsValidationError("event.props", "属性超过 4096 bytes");

  if (["recording_started", "recording_stopped", "session_exported", "session_lost"].includes(name)) {
    const propsRecordingId = (value.props as Record<string, unknown>).recording_id;
    if (value.recording_id !== propsRecordingId) throw new AnalyticsValidationError("event.recording_id", "必须与 props.recording_id 一致");
  }
  return value as unknown as AnyAnalyticsEvent;
}

export function validateAnalyticsBatch(value: unknown, options: AnalyticsValidationOptions = {}): AnalyticsBatchPayload {
  if (!isRecord(value)) throw new AnalyticsValidationError("batch", "必须是对象");
  assertExactKeys(value, ["schema_version", "ingest_token", "events"], "batch");
  if (value.schema_version !== 1) throw new AnalyticsValidationError("batch.schema_version", "仅支持版本 1");
  if (typeof value.ingest_token !== "string" || !INGEST_TOKEN_PATTERN.test(value.ingest_token)) {
    throw new AnalyticsValidationError("batch.ingest_token", "工作站 ingest token 格式无效");
  }
  if (!Array.isArray(value.events) || value.events.length < 1 || value.events.length > 50) {
    throw new AnalyticsValidationError("batch.events", "批量必须包含 1 至 50 个事件");
  }
  const events = value.events.map((event) => validateAnalyticsEvent(event, options));
  if (new Set(events.map((event) => event.event_id)).size !== events.length) {
    throw new AnalyticsValidationError("batch.events", "同一批次不能重复 event_id");
  }
  const workstationId = events[0].workstation_id;
  if (events.some((event) => event.workstation_id !== workstationId)) {
    throw new AnalyticsValidationError("batch.events", "一个批次只能属于一个工作站");
  }
  return { schema_version: 1, ingest_token: value.ingest_token, events };
}

export function isAnalyticsIngestToken(value: string) {
  return INGEST_TOKEN_PATTERN.test(value);
}
