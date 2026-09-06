import type { FlightTelemetry, TelemetrySource } from "./telemetry";

export type MeasurementValue = null | boolean | number | string | readonly MeasurementValue[] | { readonly [key: string]: MeasurementValue };
export type MeasurementFields = Record<string, MeasurementValue>;
export interface MeasurementEvent extends MeasurementFields { index: number; timeMs: number; kind: string }
export interface MeasurementSetup { mode: "on" | "off"; maxEvents: number; runId?: string }
export interface MeasurementSnapshot {
  schemaVersion: 1;
  runId: string | null;
  mode: "on" | "off";
  enabled: boolean;
  maxEvents: number;
  overflowed: boolean;
  overflowCount: number;
  instrumentationErrorCount: number;
  timeOriginEpochMs: number;
  events: MeasurementEvent[];
}
export interface MeasurementBridge {
  snapshot(): MeasurementSnapshot;
  mark(label: string): { timeMs: number; index: number | null };
}
declare global {
  interface Window {
    __fpvMeasurementSetup?: MeasurementSetup;
    __fpvMeasurement?: MeasurementBridge;
  }
}

const MAX_EVENTS = 200_000;
const EMPTY_FIELDS: MeasurementFields = Object.freeze({});
type SampleFields = Pick<FlightTelemetry, "sequence" | "monotonicTimestampMs" | "rcChannelsUs">;
interface SampleContext { hookId: string; pilotChannelId: string | null; connectionGeneration: number; source: TelemetrySource }

function initialize() {
  if (process.env.NEXT_PUBLIC_FPV_MEASUREMENT !== "true" || typeof window === "undefined") return null;
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(window.location?.hostname)) return null;
  const input = window.__fpvMeasurementSetup;
  if (!input || (input.mode !== "on" && input.mode !== "off") || !Number.isInteger(input.maxEvents)
    || input.maxEvents < 1 || input.maxEvents > MAX_EVENTS
    || (input.runId !== undefined && (typeof input.runId !== "string" || !/^[A-Za-z0-9_.-]{1,120}$/.test(input.runId)))) return null;
  // Copy the handshake once. Query strings and later setup mutations cannot enable a run.
  const mode = input.mode;
  const maxEvents = input.maxEvents;
  const runId = input.runId ?? null;
  const events: MeasurementEvent[] = [];
  const identities = mode === "on" ? new WeakMap<object, Map<string, string>>() : null;
  const samples = mode === "on" ? new WeakMap<object, SampleContext>() : null;
  const subscriptions = mode === "on" ? new WeakMap<object, Map<object, string>>() : null;
  let identityIndex = 0;
  let overflowCount = 0;
  let instrumentationErrorCount = 0;
  const enabled = () => mode === "on" && overflowCount === 0 && instrumentationErrorCount === 0;
  const record = (kind: string, data: MeasurementFields, timeMs: number): number | null => {
    if (!enabled()) return null;
    if (events.length >= maxEvents) { overflowCount += 1; return null; }
    try {
      // Snapshot caller-owned arrays; never retain mutable samples or mutate product data.
      const copy = structuredClone(data);
      const index = events.length;
      events.push({ ...copy, index, timeMs, kind });
      return index;
    } catch { instrumentationErrorCount += 1; return null; }
  };
  const bridge: MeasurementBridge = Object.freeze({
    snapshot: () => ({ schemaVersion: 1 as const, runId, mode, enabled: enabled(), maxEvents,
      overflowed: overflowCount > 0, overflowCount, instrumentationErrorCount,
      timeOriginEpochMs: performance.timeOrigin, events: structuredClone(events) }),
    mark: (label: string) => {
      const timeMs = performance.now();
      return { timeMs, index: record("measurement.mark", { label }, timeMs) };
    },
  });
  window.__fpvMeasurement = bridge;
  return { enabled, record, identities, samples, subscriptions, nextIdentity: () => ++identityIndex };
}

const measurement = initialize();

export function measurementEnabled(): boolean { return measurement?.enabled() ?? false; }

export function measurementEvent(kind: string, data: MeasurementFields): void {
  if (measurement?.enabled()) measurement.record(kind, data, performance.now());
}

export function measurementIdentity(object: object, prefix: string): string {
  if (!measurement?.enabled() || !measurement.identities) return "";
  let values = measurement.identities.get(object);
  if (!values) { values = new Map(); measurement.identities.set(object, values); }
  let id = values.get(prefix);
  if (!id) { id = `${prefix}-${measurement.nextIdentity()}`; values.set(prefix, id); }
  return id;
}

export function measurementBindSample(sample: object, context: SampleContext): void {
  if (measurement?.enabled()) measurement.samples?.set(sample, { ...context });
}

export function measurementInheritSample(sample: object, previous: object): void {
  if (!measurement?.enabled()) return;
  const context = measurement.samples?.get(previous);
  if (context) measurement.samples?.set(sample, context);
}

// Registry entries describe the existing Set semantics, including duplicate adds/removals.
export function measurementRegisterSubscription(owner: object, listener: object): MeasurementFields {
  if (!measurement?.enabled() || !measurement.subscriptions) return EMPTY_FIELDS;
  let entries = measurement.subscriptions.get(owner);
  if (!entries) { entries = new Map(); measurement.subscriptions.set(owner, entries); }
  const registrationId = `subscription-${measurement.nextIdentity()}`;
  const existing = entries.get(listener);
  if (!existing) entries.set(listener, registrationId);
  return { consumerId: measurementIdentity(listener, "consumer"), registrationId,
    subscriptionId: existing ?? registrationId, added: !existing };
}

export function measurementSubscriptionFields(owner: object, listener: object): MeasurementFields {
  if (!measurement?.enabled()) return EMPTY_FIELDS;
  return { consumerId: measurementIdentity(listener, "consumer"),
    subscriptionId: measurement.subscriptions?.get(owner)?.get(listener) ?? null };
}

export function measurementRemoveSubscription(owner: object, listener: object, registrationId: MeasurementValue): MeasurementFields {
  if (!measurement?.enabled()) return EMPTY_FIELDS;
  const fields = measurementSubscriptionFields(owner, listener);
  const deleted = measurement.subscriptions?.get(owner)?.delete(listener) ?? false;
  return { ...fields, registrationId, deleted };
}

export function measurementSampleFields(sample: SampleFields | undefined): MeasurementFields {
  if (!measurement?.enabled() || !sample) return EMPTY_FIELDS;
  return { ...measurement.samples?.get(sample), sequence: sample.sequence,
    monotonicTimestampMs: sample.monotonicTimestampMs, channelsUs: [...sample.rcChannelsUs] };
}
