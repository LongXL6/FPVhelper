import {
  isAnalyticsIngestToken,
  validateAnalyticsEvent,
  type AnalyticsConnectionState,
  type AnalyticsEventEnvelope,
  type AnalyticsOverlayMode,
  type AnalyticsTelemetrySource,
  type AnalyticsVideoState,
  type AnyAnalyticsEvent,
  type PhaseOneEventName,
  type PhaseOneEventProps,
} from "./events";
import {
  getOrCreateWorkstationId,
  WORKSTATION_ID_STORAGE_KEY,
} from "../workstation-id";

const WORKSTATION_KEY = WORKSTATION_ID_STORAGE_KEY;
const TOKEN_KEY = "fpvhelper.analytics.ingest-token.v1";
const QUEUE_KEY = "fpvhelper.analytics.queue.v1";
const OPT_OUT_KEY = "fpvhelper.analytics.opt-out.v1";
const MAX_QUEUE_LENGTH = 500;
const MAX_QUEUE_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const FLUSH_SIZE = 20;
const MAX_BATCH_BYTES = 32 * 1_024;
const FLUSH_INTERVAL_MS = 10_000;
const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60 * 1_000;
const DROP_RESPONSE_STATUSES = new Set([400, 413, 415, 422]);
export const CUSTOMER_ANALYTICS_HOSTNAME = "race.fpvsuperapp.com";

export type AnalyticsLocalStatus =
  | { state: "off"; reason: "hostname" | "configuration" | "opted_out" }
  | { state: "waiting_token"; reason: "missing_token" | "rejected_token" }
  | { state: "enabled"; reason: "installed" };

interface AnalyticsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface AnalyticsRuntime {
  storage: AnalyticsStorage;
  hostname: string;
  search: string;
  online(): boolean;
  randomUuid(): string;
  now(): number;
  monotonicNow(): number;
  fetch(input: string, init: RequestInit): Promise<Response>;
  sendBeacon(input: string, body: Blob): boolean;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(timer: number): void;
  addWindowListener(type: "online" | "pagehide", listener: () => void): void;
  removeWindowListener(type: "online" | "pagehide", listener: () => void): void;
}

export interface AnalyticsClientContext {
  recordingId: string | null;
  connection: AnalyticsConnectionState;
  videoState: AnalyticsVideoState;
  isRecording: boolean;
  overlayMode: AnalyticsOverlayMode;
  telemetrySource: AnalyticsTelemetrySource;
}

export interface AnalyticsClientOptions {
  enabled?: boolean;
  environment?: string;
  build?: string;
  sessionSchemaVersion?: number;
  ingestToken?: string;
  endpoint?: string;
  initialContext?: Partial<AnalyticsClientContext>;
  /** Test seam; production callers should not provide this. */
  runtime?: AnalyticsRuntime;
  /** Test seam; keeps the public singleton a no-op under Vitest. */
  allowInTest?: boolean;
}

export interface TrackOptions {
  urgent?: boolean;
}

const DEFAULT_CONTEXT: AnalyticsClientContext = {
  recordingId: null,
  connection: "demo",
  videoState: "idle",
  isRecording: false,
  overlayMode: "trail",
  telemetrySource: "demo",
};

function browserRuntime(): AnalyticsRuntime | null {
  if (typeof window === "undefined" || typeof document === "undefined" || typeof navigator === "undefined") return null;
  return {
    storage: window.localStorage,
    hostname: window.location.hostname.toLowerCase(),
    search: window.location.search,
    online: () => navigator.onLine,
    randomUuid: () => crypto.randomUUID(),
    now: () => Date.now(),
    monotonicNow: () => performance.now(),
    fetch: (input, init) => window.fetch(input, init),
    sendBeacon: (input, body) => navigator.sendBeacon(input, body),
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (timer) => window.clearTimeout(timer),
    addWindowListener: (type, listener) => window.addEventListener(type, listener),
    removeWindowListener: (type, listener) => window.removeEventListener(type, listener),
  };
}

function safeGet(storage: AnalyticsStorage, key: string) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage: AnalyticsStorage, key: string, value: string) {
  try {
    storage.setItem(key, value);
    return storage.getItem(key) === value;
  } catch {
    return false;
  }
}

function safeRemove(storage: AnalyticsStorage, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    // Storage failures must never affect the dashboard.
  }
}

function productionAnalyticsEnabled(options: AnalyticsClientOptions) {
  const enabled = options.enabled ?? process.env.NEXT_PUBLIC_ANALYTICS_ENABLED === "true";
  const environment = options.environment ?? process.env.NEXT_PUBLIC_ANALYTICS_ENV;
  return enabled && environment === "production";
}

function analyticsBuildIdentifier(options: AnalyticsClientOptions) {
  const candidate = (options.build ?? process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown").trim();
  const sanitized = candidate.replaceAll(/[^a-zA-Z0-9._+-]/g, "-").slice(0, 80);
  return sanitized && /^[a-zA-Z0-9]/.test(sanitized) ? sanitized : "unknown";
}

function retryAfterMilliseconds(value: string | null, now: number) {
  if (!value) return null;
  const seconds = Number(value);
  const requested = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1_000
    : Date.parse(value) - now;
  if (!Number.isFinite(requested) || requested < 0) return null;
  return Math.min(MAX_BACKOFF_MS, Math.max(1_000, Math.ceil(requested)));
}

export function isCustomerAnalyticsHostname(hostname: string) {
  return hostname.trim().toLowerCase() === CUSTOMER_ANALYTICS_HOSTNAME;
}

export function resolveAnalyticsLocalStatus(options: {
  hostname: string;
  configured: boolean;
  optedOut: boolean;
  hasToken: boolean;
  authorizationBlocked?: boolean;
}): AnalyticsLocalStatus {
  if (!isCustomerAnalyticsHostname(options.hostname)) return { state: "off", reason: "hostname" };
  if (!options.configured) return { state: "off", reason: "configuration" };
  if (options.optedOut) return { state: "off", reason: "opted_out" };
  if (options.authorizationBlocked) return { state: "waiting_token", reason: "rejected_token" };
  if (!options.hasToken) return { state: "waiting_token", reason: "missing_token" };
  return { state: "enabled", reason: "installed" };
}

export class AnalyticsClient {
  private runtime: AnalyticsRuntime | null = null;
  private workstationId = "";
  private visitId = "";
  private ingestToken = "";
  private queue: AnyAnalyticsEvent[] = [];
  private context: AnalyticsClientContext = { ...DEFAULT_CONTEXT };
  private timer: number | null = null;
  private inflight = false;
  private active = false;
  private authorizationBlocked = false;
  private installedToken: string | null = null;
  private readonly statusListeners = new Set<(status: AnalyticsLocalStatus) => void>();
  private backoffMs = 0;
  private retryNotBefore = 0;

  private readonly handleOnline = () => {
    void this.flush();
  };

  private readonly handlePageHide = () => {
    void this.flush({ beacon: true });
  };

  constructor(private readonly options: AnalyticsClientOptions = {}) {}

  init() {
    if (this.active) return true;
    const runtime = this.options.runtime ?? browserRuntime();
    if (!runtime || (process.env.NODE_ENV === "test" && !this.options.allowInTest)) return false;

    this.runtime = runtime;
    if (!isCustomerAnalyticsHostname(runtime.hostname) || !productionAnalyticsEnabled(this.options)) return false;
    if (new URLSearchParams(runtime.search).get("analytics") === "off") {
      safeSet(runtime.storage, OPT_OUT_KEY, "1");
      safeRemove(runtime.storage, QUEUE_KEY);
      safeRemove(runtime.storage, TOKEN_KEY);
      safeRemove(runtime.storage, WORKSTATION_KEY);
      this.queue = [];
      return false;
    }
    if (safeGet(runtime.storage, OPT_OUT_KEY) === "1") return false;

    const workstationId = getOrCreateWorkstationId(runtime.storage, runtime.randomUuid);
    if (!workstationId) return false;

    const configuredToken = this.installedToken ?? this.options.ingestToken ?? safeGet(runtime.storage, TOKEN_KEY) ?? "";
    if (!isAnalyticsIngestToken(configuredToken)) return false;
    if (!safeSet(runtime.storage, TOKEN_KEY, configuredToken)) return false;

    this.workstationId = workstationId;
    this.visitId = runtime.randomUuid();
    this.ingestToken = configuredToken;
    this.context = { ...DEFAULT_CONTEXT, ...this.options.initialContext };
    this.queue = this.loadQueue();
    this.active = true;
    runtime.addWindowListener("online", this.handleOnline);
    runtime.addWindowListener("pagehide", this.handlePageHide);
    this.scheduleFlush();
    if (this.queue.length > 0 && runtime.online()) void this.flush();
    return true;
  }

  setContext(patch: Partial<AnalyticsClientContext>) {
    this.context = { ...this.context, ...patch };
  }

  track<Name extends PhaseOneEventName>(
    eventName: Name,
    props: PhaseOneEventProps[Name],
    options: TrackOptions = {},
  ) {
    const runtime = this.runtime;
    if (!this.active || !runtime) return null;

    const propsRecordingId = "recording_id" in props && typeof props.recording_id === "string"
      ? props.recording_id
      : this.context.recordingId;
    const event: AnalyticsEventEnvelope<Name> = {
      event_id: runtime.randomUuid(),
      event_name: eventName,
      occurred_at: new Date(runtime.now()).toISOString(),
      client_monotonic_ms: runtime.monotonicNow(),
      workstation_id: this.workstationId,
      visit_id: this.visitId,
      recording_id: propsRecordingId,
      build: analyticsBuildIdentifier(this.options),
      hostname: runtime.hostname,
      vercel_env: "production",
      session_schema_version: this.options.sessionSchemaVersion ?? 2,
      connection: this.context.connection,
      video_state: this.context.videoState,
      is_recording: this.context.isRecording,
      overlay_mode: this.context.overlayMode,
      telemetry_source: this.context.telemetrySource,
      props,
    };

    try {
      validateAnalyticsEvent(event, { now: runtime.now() });
    } catch {
      return null;
    }
    this.queue.push(event as AnyAnalyticsEvent);
    if (this.queue.length > MAX_QUEUE_LENGTH) this.queue.splice(0, this.queue.length - MAX_QUEUE_LENGTH);
    this.persistQueue();

    if (options.urgent || this.queue.length >= FLUSH_SIZE) void this.flush();
    return event.event_id;
  }

  async flush(options: { beacon?: boolean } = {}) {
    const runtime = this.runtime;
    if (!this.active || !runtime || this.authorizationBlocked) return false;
    this.pruneQueue();
    if (this.queue.length === 0) return false;
    const retryDelay = this.retryNotBefore - runtime.now();
    if (retryDelay > 0) {
      this.scheduleFlush(retryDelay);
      return false;
    }
    const events = this.takeBatch();
    // sendBeacon cannot set Authorization headers. The purpose-limited workstation
    // ingest token therefore travels in the body, is never an event property, and
    // is stored only in this workstation's localStorage. The server stores only SHA-256.
    const body = JSON.stringify({ schema_version: 1, ingest_token: this.ingestToken, events });

    if (options.beacon) {
      runtime.sendBeacon(
        this.options.endpoint ?? "/api/events",
        new Blob([body], { type: "text/plain;charset=UTF-8" }),
      );
      // Beacon delivery is not observable. Keep the events and rely on event_id
      // idempotency when the next normal flush replays them.
      return true;
    }

    if (this.inflight || !runtime.online()) return false;
    this.inflight = true;
    try {
      const response = await runtime.fetch(this.options.endpoint ?? "/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
        credentials: "same-origin",
      });
      if (response.ok || DROP_RESPONSE_STATUSES.has(response.status)) {
        const sentIds = new Set(events.map((event) => event.event_id));
        this.queue = this.queue.filter((event) => !sentIds.has(event.event_id));
        this.persistQueue();
        this.resetBackoff();
      }
      if (response.status === 401 || response.status === 403) {
        this.authorizationBlocked = true;
        safeRemove(runtime.storage, TOKEN_KEY);
        this.installedToken = "";
        this.ingestToken = "";
        if (this.timer !== null) runtime.clearTimeout(this.timer);
        this.timer = null;
        this.notifyStatusChanged();
      } else if (!response.ok && !DROP_RESPONSE_STATUSES.has(response.status)) {
        this.applyBackoff(retryAfterMilliseconds(response.headers.get("retry-after"), runtime.now()));
      }
      return response.ok;
    } catch {
      this.applyBackoff(null);
      return false;
    } finally {
      this.inflight = false;
      if (!this.authorizationBlocked) this.scheduleFlush(this.backoffMs || undefined);
    }
  }

  setIngestToken(token: string) {
    const runtime = this.runtime ?? this.options.runtime ?? browserRuntime();
    if (
      !runtime
      || !isCustomerAnalyticsHostname(runtime.hostname)
      || !productionAnalyticsEnabled(this.options)
      || safeGet(runtime.storage, OPT_OUT_KEY) === "1"
      || !isAnalyticsIngestToken(token)
      || !safeSet(runtime.storage, TOKEN_KEY, token)
    ) return false;
    this.installedToken = token;
    this.authorizationBlocked = false;
    this.resetBackoff();
    if (!this.active) {
      if (!this.init()) {
        safeRemove(runtime.storage, TOKEN_KEY);
        this.installedToken = null;
        return false;
      }
    } else {
      this.ingestToken = token;
      void this.flush();
    }
    this.notifyStatusChanged();
    return true;
  }

  clearIngestToken() {
    const runtime = this.runtime ?? this.options.runtime ?? browserRuntime();
    if (!runtime) return;
    safeRemove(runtime.storage, TOKEN_KEY);
    safeRemove(runtime.storage, QUEUE_KEY);
    this.installedToken = "";
    this.ingestToken = "";
    this.queue = [];
    this.authorizationBlocked = false;
    this.resetBackoff();
    this.stop();
    this.notifyStatusChanged();
  }

  optOut() {
    const runtime = this.runtime ?? this.options.runtime ?? browserRuntime();
    if (!runtime) return;
    safeSet(runtime.storage, OPT_OUT_KEY, "1");
    safeRemove(runtime.storage, QUEUE_KEY);
    safeRemove(runtime.storage, TOKEN_KEY);
    safeRemove(runtime.storage, WORKSTATION_KEY);
    this.installedToken = "";
    this.ingestToken = "";
    this.queue = [];
    this.resetBackoff();
    this.stop();
    this.notifyStatusChanged();
  }

  prepareReactivation() {
    const runtime = this.runtime ?? this.options.runtime ?? browserRuntime();
    if (
      !runtime
      || !isCustomerAnalyticsHostname(runtime.hostname)
      || !productionAnalyticsEnabled(this.options)
    ) return false;
    safeRemove(runtime.storage, OPT_OUT_KEY);
    safeRemove(runtime.storage, TOKEN_KEY);
    safeRemove(runtime.storage, QUEUE_KEY);
    safeRemove(runtime.storage, WORKSTATION_KEY);
    this.installedToken = "";
    this.ingestToken = "";
    this.queue = [];
    this.authorizationBlocked = false;
    this.resetBackoff();
    this.stop();
    this.notifyStatusChanged();
    return true;
  }

  getLocalStatus(): AnalyticsLocalStatus {
    const runtime = this.runtime ?? this.options.runtime ?? browserRuntime();
    if (!runtime) return { state: "off", reason: "configuration" };
    return resolveAnalyticsLocalStatus({
      hostname: runtime.hostname,
      configured: productionAnalyticsEnabled(this.options),
      optedOut: safeGet(runtime.storage, OPT_OUT_KEY) === "1",
      hasToken: isAnalyticsIngestToken(this.installedToken ?? safeGet(runtime.storage, TOKEN_KEY) ?? ""),
      authorizationBlocked: this.authorizationBlocked,
    });
  }

  subscribeLocalStatus(listener: (status: AnalyticsLocalStatus) => void) {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  stop() {
    if (!this.runtime) return;
    if (this.timer !== null) this.runtime.clearTimeout(this.timer);
    this.timer = null;
    this.runtime.removeWindowListener("online", this.handleOnline);
    this.runtime.removeWindowListener("pagehide", this.handlePageHide);
    this.active = false;
  }

  getQueueLength() {
    return this.queue.length;
  }

  getWorkstationId() {
    return this.workstationId || null;
  }

  private loadQueue() {
    if (!this.runtime) return [];
    const raw = safeGet(this.runtime.storage, QUEUE_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const cutoff = this.runtime.now() - MAX_QUEUE_AGE_MS;
      return parsed.flatMap((candidate) => {
        try {
          const event = validateAnalyticsEvent(candidate, { now: this.runtime?.now() });
          return event.workstation_id === this.workstationId && Date.parse(event.occurred_at) >= cutoff ? [event] : [];
        } catch {
          return [];
        }
      }).slice(-MAX_QUEUE_LENGTH);
    } catch {
      return [];
    }
  }

  private persistQueue() {
    if (!this.runtime) return;
    safeSet(this.runtime.storage, QUEUE_KEY, JSON.stringify(this.queue));
  }

  private pruneQueue() {
    if (!this.runtime) return;
    const cutoff = this.runtime.now() - MAX_QUEUE_AGE_MS;
    const retained = this.queue.filter((event) => Date.parse(event.occurred_at) >= cutoff);
    if (retained.length === this.queue.length) return;
    this.queue = retained;
    this.persistQueue();
  }

  private takeBatch() {
    const events: AnyAnalyticsEvent[] = [];
    let bytes = 0;
    for (const event of this.queue) {
      const eventBytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (events.length >= FLUSH_SIZE || (events.length > 0 && bytes + eventBytes > MAX_BATCH_BYTES)) break;
      events.push(event);
      bytes += eventBytes;
    }
    return events.length > 0 ? events : this.queue.slice(0, 1);
  }

  private applyBackoff(retryAfterMs: number | null) {
    if (!this.runtime) return;
    this.backoffMs = retryAfterMs ?? Math.min(
      this.backoffMs ? this.backoffMs * 2 : INITIAL_BACKOFF_MS,
      MAX_BACKOFF_MS,
    );
    this.retryNotBefore = this.runtime.now() + this.backoffMs;
  }

  private resetBackoff() {
    this.backoffMs = 0;
    this.retryNotBefore = 0;
  }

  private scheduleFlush(delayMs = FLUSH_INTERVAL_MS) {
    if (!this.runtime || !this.active || this.authorizationBlocked) return;
    if (this.timer !== null) this.runtime.clearTimeout(this.timer);
    const retryDelay = Math.max(0, this.retryNotBefore - this.runtime.now());
    this.timer = this.runtime.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, Math.max(delayMs, retryDelay));
  }

  private notifyStatusChanged() {
    const status = this.getLocalStatus();
    this.statusListeners.forEach((listener) => listener(status));
  }
}

export const analyticsClient = new AnalyticsClient();

export function initializeAnalytics() {
  return analyticsClient.init();
}

export function trackAnalytics<Name extends PhaseOneEventName>(
  eventName: Name,
  props: PhaseOneEventProps[Name],
  options?: TrackOptions,
) {
  return analyticsClient.track(eventName, props, options);
}

export function setAnalyticsIngestToken(token: string) {
  return analyticsClient.setIngestToken(token);
}

export function clearAnalyticsIngestToken() {
  analyticsClient.clearIngestToken();
}

export function optOutAnalytics() {
  analyticsClient.optOut();
}

export function prepareAnalyticsReactivation() {
  return analyticsClient.prepareReactivation();
}

export function getAnalyticsLocalStatus() {
  return analyticsClient.getLocalStatus();
}

export function subscribeAnalyticsLocalStatus(listener: (status: AnalyticsLocalStatus) => void) {
  return analyticsClient.subscribeLocalStatus(listener);
}

export function flushAnalyticsWithBeacon() {
  return analyticsClient.flush({ beacon: true });
}
