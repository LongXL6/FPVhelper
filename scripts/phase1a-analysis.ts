import { fixtureFrameKey, frameKey, type MeasurementHardwareSnapshot } from "../e2e/fixtures/measurement-hardware.ts";

export type MeasurementMode = "N" | "P0" | "P1";
export interface MeasurementCondition { id: string; scenario: "S0" | "S1" | "S2" | "S3" | "S4"; inputHz: 0 | 50 | 100; modes: MeasurementMode[] }
export interface MeasurementPlan {
  schemaVersion: 1; status: string; warmupMs: number; windowMs: number; repeats: number; lifecyclePhaseMs: number; drainMs: number;
  cleanupMs: number; maxEvents: number; maxTraceBytes: number; maxRunMs: number; maxBatchMs: number; maxOutputBytes: number; minDiskFreeBytes: number; maxHeapBytes: number | null;
  conditions: MeasurementCondition[]; runOrder: Array<{ repeat: number; condition: string; mode: MeasurementMode }>;
}
export interface ProbeEvent { index: number; timeMs: number; kind: string; [key: string]: unknown }
export interface ProbeSnapshot { mode: string; enabled: boolean; timeOriginEpochMs: number; overflowCount: number; events: ProbeEvent[]; [key: string]: unknown }
export interface MeasurementWindow { label: string; t0: number; t1: number; drainEnd: number; steady: boolean; cdp?: unknown }
export interface MeasurementResult {
  runId: string; condition: MeasurementCondition; mode: MeasurementMode; repeat: number; exploratory: boolean;
  windows: MeasurementWindow[]; hardware: MeasurementHardwareSnapshot; probe: ProbeSnapshot | null;
  sessions: Array<{ id: string; startedMonotonicMs?: number; samples: Array<{ channelsUs: number[]; sequence: number; elapsedMs: number }>; video?: unknown }>;
  errors: string[]; networkViolations: unknown[]; [key: string]: unknown;
}
export function parseMeasurementPlan(value: unknown): MeasurementPlan {
  if (!value || typeof value !== "object") throw new Error("Expected measurement plan object");
  const plan = value as MeasurementPlan;
  if (plan.schemaVersion !== 1 || typeof plan.status !== "string") throw new Error("Unsupported measurement plan");
  const bounds: Array<[keyof MeasurementPlan, number, number]> = [
    ["warmupMs", 0, 30000], ["windowMs", 1, 60000], ["repeats", 1, 10], ["lifecyclePhaseMs", 1, 10000], ["drainMs", 0, 3000],
    ["cleanupMs", 1, 20000], ["maxEvents", 1, 200000], ["maxTraceBytes", 1, 67108864], ["maxRunMs", 1, 120000], ["maxBatchMs", 1, 1800000], ["maxOutputBytes", 1, 262144000], ["minDiskFreeBytes", 2147483648, Number.MAX_SAFE_INTEGER],
  ];
  for (const [key, low, high] of bounds) if (!Number.isSafeInteger(plan[key]) || Number(plan[key]) < low || Number(plan[key]) > high) throw new Error(`Invalid plan budget ${key}`);
  if (plan.maxHeapBytes !== null && (!Number.isSafeInteger(plan.maxHeapBytes) || plan.maxHeapBytes <= 0)) throw new Error("Invalid maxHeapBytes");
  if (!Array.isArray(plan.conditions) || !plan.conditions.length || !Array.isArray(plan.runOrder)) throw new Error("Missing conditions/runOrder");
  const ids = new Set<string>();
  for (const condition of plan.conditions) {
    if (!condition.id || ids.has(condition.id) || !["S0", "S1", "S2", "S3", "S4"].includes(condition.scenario) || ![0, 50, 100].includes(condition.inputHz)
      || (condition.scenario === "S0") !== (condition.inputHz === 0) || !condition.modes?.length || condition.modes.some((mode) => !["N", "P0", "P1"].includes(mode))
      || new Set(condition.modes).size !== condition.modes.length) throw new Error("Invalid or duplicate condition");
    ids.add(condition.id);
  }
  const expected = new Set(plan.conditions.flatMap((condition) => Array.from({ length: plan.repeats }, (_, repeat) => condition.modes.map((mode) => `${repeat + 1}:${condition.id}:${mode}`)).flat()));
  for (const run of plan.runOrder) if (!expected.delete(`${run.repeat}:${run.condition}:${run.mode}`)) throw new Error("Invalid/duplicate planned run");
  if (expected.size) throw new Error("runOrder does not cover every planned condition");
  return plan;
}
export function percentile(values: readonly number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), position = (sorted.length - 1) * quantile;
  return sorted[Math.floor(position)] + (sorted[Math.ceil(position)] - sorted[Math.floor(position)]) * (position % 1);
}
function distribution(values: number[]) { return { count: values.length, min: values.length ? Math.min(...values) : null, p50: percentile(values, .5), p95: percentile(values, .95), max: values.length ? Math.max(...values) : null }; }
function counts(events: ProbeEvent[]) { const result: Record<string, number> = {}; for (const event of events) result[event.kind] = (result[event.kind] ?? 0) + 1; return result; }
export function eventKey(event: ProbeEvent) { return Array.isArray(event.channelsUs) ? fixtureFrameKey(event.channelsUs as number[]) : null; }
function keyCounts(events: ProbeEvent[]) { const result = new Map<string, number>(); for (const event of events) { const key = eventKey(event); if (key) result.set(key, (result.get(key) ?? 0) + 1); } return result; }
function outOfOrder(keys: Iterable<string>) {
  const last = new Map<string, number>(); let count = 0;
  for (const key of keys) { const parts = key.split(":"); const group = `${parts[0]}:${parts[1]}`, index = Number(parts[2]); if (last.has(group) && index < last.get(group)!) count++; last.set(group, index); }
  return count;
}
function coverage(expected: Set<string>, actual: Map<string, number>) {
  const missing = [...expected].filter((key) => !actual.has(key)), duplicated = [...expected].filter((key) => (actual.get(key) ?? 0) > 1);
  const outsideExpected = [...actual.keys()].filter((key) => !expected.has(key));
  return { outsideExpected: outsideExpected.length, outsideExpectedExamples: outsideExpected.slice(0, 10), expected: expected.size, observedUnique: [...expected].filter((key) => actual.has(key)).length, missing: missing.length, duplicated: duplicated.length, missingExamples: missing.slice(0, 10), duplicateExamples: duplicated.slice(0, 10) };
}
function conditionRequiresIndependentHooks(run: MeasurementResult) { return run.condition.scenario === "S3"; }
export function analyzeMeasurementRun(run: MeasurementResult) {
  const violations = [...run.errors];
  if (run.networkViolations.length) violations.push("unexpected_network_request");
  if (run.hardware.overflowCount || run.probe?.overflowCount) violations.push("measurement_buffer_overflow");
  if (run.probe?.instrumentationErrorCount) violations.push("instrumentation_error");
  if (run.hardware.protocolErrors.length) violations.push("synthetic_protocol_error");
  if (run.mode === "N" && run.probe !== null) violations.push("normal_build_exposed_probe");
  if (run.mode === "P0" && (!run.probe || run.probe.events.length || run.probe.enabled)) violations.push("off_mode_collected_product_events");
  if (run.mode === "P1" && (!run.probe?.enabled || !run.probe.events.some((event) => event.kind === "react.commit"))) violations.push("profiler_not_verified");
  if (run.probe && Math.abs(run.probe.timeOriginEpochMs - run.hardware.timeOriginEpochMs) > .1) violations.push("clock_origin_mismatch");
  const events = run.mode === "P1" ? run.probe?.events ?? [] : null;
  if (run.hardware.frames.some((frame) => ![frame.requestedAtMs, frame.plannedAtMs, frame.generatedAtMs].every(Number.isFinite)
    || frame.generatedAtMs < frame.requestedAtMs || frame.generatedAtMs < frame.plannedAtMs
    || (frame.deliveredAtMs !== null && (!Number.isFinite(frame.deliveredAtMs) || frame.deliveredAtMs < frame.generatedAtMs)))) violations.push("fixture_clock_order_error");
  const allDelivered = new Set(run.hardware.frames.filter((frame) => frame.deliveredAtMs !== null).map(frameKey));
  const savedKeys = new Map<string, number>(); let unknownSaved = 0;
  for (const session of run.sessions) for (const sample of session.samples) {
    const key = fixtureFrameKey(sample.channelsUs);
    if (!key) unknownSaved += 1; else savedKeys.set(key, (savedKeys.get(key) ?? 0) + 1);
  }
  const savedOrderErrors = run.sessions.reduce((count, session) => count + outOfOrder(session.samples.map((sample) => fixtureFrameKey(sample.channelsUs)).filter((key): key is string => key !== null)), 0);
  const savedTimeErrors = run.sessions.reduce((total, session) => total + session.samples.filter((sample, index) => !Number.isFinite(sample.elapsedMs) || sample.elapsedMs < 0 || (index > 0 && sample.elapsedMs < session.samples[index - 1].elapsedMs)).length, 0);
  if (savedTimeErrors) violations.push("saved_timestamp_order_error");
  if (savedOrderErrors) violations.push("saved_input_out_of_order");
  const hookGroups = new Map<string, Set<string>>();
  for (const event of events ?? []) {
    const key = eventKey(event); if (!key || typeof event.hookId !== "string") continue;
    const group = key.split(":").slice(0, 2).join(":");
    const groups = hookGroups.get(event.hookId) ?? new Set<string>(); groups.add(group); hookGroups.set(event.hookId, groups);
  }
  const foreignSaved = [...savedKeys.keys()].filter((key) => !allDelivered.has(key));
  const windows = run.windows.map((window) => {
    if (!(window.t0 < window.t1 && window.t1 <= window.drainEnd && window.drainEnd - window.t1 <= 3500)) violations.push(`invalid_window:${window.label}`);
    const cohort = run.hardware.frames.filter((frame) => frame.deliveredAtMs !== null && frame.deliveredAtMs >= window.t0 && frame.deliveredAtMs < window.t1);
    const keys = new Set(cohort.map(frameKey));
    const requiredStreams = run.condition.scenario === "S3" ? [1, 2]
      : ["S1", "S2"].includes(run.condition.scenario) || (run.condition.scenario === "S4" && ["connected", "source_resumed"].includes(window.label)) ? [1] : [];
    for (const streamId of requiredStreams) if (!cohort.some((frame) => frame.streamId === streamId)) violations.push(`missing_active_source:${window.label}:${streamId}`);
    const timed = events?.filter((event) => event.timeMs >= window.t0 && event.timeMs < window.t1) ?? null;
    const settled = events?.filter((event) => event.timeMs <= window.drainEnd && !!eventKey(event) && keys.has(eventKey(event)!)) ?? null;
    const perStream = [1, 2].map((streamId) => {
      const delivered = cohort.filter((frame) => frame.streamId === streamId).map((frame) => frame.deliveredAtMs!);
      return { streamId, nominalOpportunityCount: run.condition.inputHz && (streamId === 1 || run.condition.scenario === "S3") ? run.condition.inputHz * (window.t1 - window.t0) / 1000 : null, delivered: delivered.length, deliveredHz: delivered.length / ((window.t1 - window.t0) / 1000), intervalsMs: distribution(delivered.slice(1).map((time, i) => time - delivered[i])) };
    });
    const stages = settled ? Object.fromEntries(["rc.decoded", "sample.published"].map((kind) => {
      const observations = settled.filter((event) => event.kind === kind);
      const late = events?.filter((event) => event.kind === kind && event.timeMs > window.drainEnd && keys.has(eventKey(event) ?? "")) ?? [];
      const metric = { ...coverage(keys, keyCounts(observations)), lateAfterDrainUnique: keyCounts(late).size, outOfOrder: outOfOrder(observations.map(eventKey).filter((key): key is string => key !== null)) };
      if (metric.missing || metric.duplicated || metric.outOfOrder) violations.push(`raw_integrity:${window.label}:${kind}`);
      return [kind, metric];
    })) : null;
    let pipelineCausalOrderErrors: number | null = null;
    if (settled) {
      const producerKey = (event: ProbeEvent) => `${event.hookId}:${eventKey(event)}`;
      const decoded = new Map(settled.filter((event) => event.kind === "rc.decoded").map((event) => [producerKey(event), event]));
      const published = new Map(settled.filter((event) => event.kind === "sample.published").map((event) => [producerKey(event), event]));
      pipelineCausalOrderErrors = settled.filter((event) => {
        const prior = event.kind === "sample.published" ? decoded.get(producerKey(event))
          : event.kind === "sample.delivery.attempted" ? published.get(producerKey(event)) : undefined;
        return ["sample.published", "sample.delivery.attempted"].includes(event.kind) && (!prior || prior.index >= event.index);
      }).length;
      if (pipelineCausalOrderErrors) violations.push(`pipeline_causality:${window.label}`);
    }
    if (conditionRequiresIndependentHooks(run) && settled) {
      const hookStreams = new Map<string, Set<number>>();
      for (const event of settled.filter((event) => event.kind === "rc.decoded")) { const key = eventKey(event); if (!key) continue; const streams = hookStreams.get(String(event.hookId)) ?? new Set<number>(); streams.add(Number(key.split(":")[0])); hookStreams.set(String(event.hookId), streams); }
      if ([...hookStreams.values()].some((streams) => streams.size > 1)) violations.push(`cross_source_hook_mix:${window.label}`);
    }
    const subscriptions: Array<Record<string, unknown>> = [];
    if (settled && events) {
      const publishes = new Map(settled.filter((event) => event.kind === "sample.published").map((event) => [eventKey(event), event]));
      for (const add of events.filter((event) => event.kind === "sample.subscription.add" && event.added !== false)) {
        const remove = events.find((event) => event.kind === "sample.subscription.remove" && event.subscriptionId === add.subscriptionId && event.index > add.index && event.deleted !== false);
        const groups = hookGroups.get(String(add.hookId));
        // Every independent delivered ID remains in the denominator even when publication is absent.
        const expected = new Set(cohort.filter((frame) => {
          if (!groups?.has(`${frame.streamId}:${frame.generation}`)) return false;
          const publication = publishes.get(frameKey(frame));
          return publication ? publication.index > add.index && (!remove || publication.index < remove.index)
            : frame.deliveredAtMs! >= add.timeMs && (!remove || frame.deliveredAtMs! < remove.timeMs);
        }).map(frameKey));
        const attempted = settled.filter((event) => event.kind === "sample.delivery.attempted" && event.subscriptionId === add.subscriptionId);
        const returned = settled.filter((event) => event.kind === "sample.delivery.returned" && event.subscriptionId === add.subscriptionId);
        const thrown = settled.filter((event) => event.kind === "sample.delivery.threw" && event.subscriptionId === add.subscriptionId);
        if (!expected.size && !attempted.length && !returned.length && !thrown.length) continue;
        const causalOrderErrors = returned.filter((event) => !attempted.some((attempt) => eventKey(attempt) === eventKey(event) && attempt.index < event.index)).length;
        const metric = coverage(expected, keyCounts(attempted)), returnedMetric = coverage(expected, keyCounts(returned));
        const orderErrors = outOfOrder(attempted.map(eventKey).filter((key): key is string => key !== null));
        if (metric.missing || metric.duplicated || metric.outsideExpected || returnedMetric.missing || returnedMetric.duplicated || returnedMetric.outsideExpected || orderErrors || causalOrderErrors || thrown.length) violations.push(`subscriber_integrity:${window.label}:${add.subscriptionId}`);
        subscriptions.push({ subscriptionId: add.subscriptionId, consumerId: add.consumerId, hookId: add.hookId,
          startTimeMs: add.timeMs, endTimeMs: remove?.timeMs ?? null, attempted: metric, returned: returnedMetric, outOfOrder: orderErrors, causalOrderErrors, threw: thrown.length });
      }
    }
    const guards = settled?.filter((event) => event.kind.startsWith("session.sample.")) ?? null;
    const rejectionReasons: Record<string, number> | null = guards ? {} : null;
    for (const event of guards ?? []) if (event.kind === "session.sample.rejected") { const reason = String(event.reason ?? "unknown"); rejectionReasons![reason] = (rejectionReasons![reason] ?? 0) + 1; }
    const react = events?.filter((event) => event.kind === "react.commit" && Number(event.commitTime) >= window.t0 && Number(event.commitTime) < window.t1) ?? null;
    const profilers = react ? Object.fromEntries([...new Set(react.map((event) => String(event.profilerId)))].map((id) => {
      const commits = react.filter((event) => event.profilerId === id);
      return [id, { callbackCount: commits.length, callbackHz: commits.length / ((window.t1 - window.t0) / 1000), renderMs: distribution(commits.map((event) => Number(event.actualDuration))), renderTotalMs: commits.reduce((sum, event) => sum + Number(event.actualDuration), 0) }];
    })) : null;
    const workbenchTimes = new Map<unknown, number>();
    for (const event of react ?? []) if (event.profilerId === "workbench") workbenchTimes.set(event.commitTime, (workbenchTimes.get(event.commitTime) ?? 0) + 1);
    const repeatedWorkbenchCommitTimeCount = [...workbenchTimes.values()].reduce((count, occurrences) => count + Math.max(0, occurrences - 1), 0);
    let eligibleKeys = keys;
    let recordingSavedKeys = savedKeys;
    let recordingGates: Array<Record<string, unknown>> | null = null;
    if (run.condition.scenario === "S2" && events) {
      const starts = events.filter((event) => event.kind === "session.start.confirmed");
      const startedId = starts.length === 1 ? starts[0].sessionId : null;
      const frozen = events.find((event) => event.kind === "session.stop.frozen" && event.sessionId === startedId && event.index > (starts[0]?.index ?? Infinity));
      const completed = events.find((event) => event.kind === "session.complete.confirmed" && event.sessionId === startedId && event.index > (frozen?.index ?? Infinity));
      const session = run.sessions.length === 1 ? run.sessions[0] : null;
      if (typeof startedId !== "string" || !frozen || !completed || session?.id !== startedId) violations.push(`recording_session_identity:${window.label}`);
      recordingSavedKeys = new Map<string, number>();
      if (session && session.id === startedId) for (const sample of session.samples) { const key = fixtureFrameKey(sample.channelsUs); if (key) recordingSavedKeys.set(key, (recordingSavedKeys.get(key) ?? 0) + 1); }
      recordingGates = starts.map((start) => ({ sessionId: start.sessionId, startTimeMs: start.timeMs,
        freezeTimeMs: events.find((event) => event.kind === "session.stop.frozen" && event.sessionId === start.sessionId && event.index > start.index)?.timeMs ?? null }));
      eligibleKeys = new Set(cohort.filter((frame) => recordingGates!.some((gate) => frame.deliveredAtMs! >= Number(gate.startTimeMs) && (gate.freezeTimeMs === null || frame.deliveredAtMs! < Number(gate.freezeTimeMs)))).map(frameKey));
      const rejected = new Set((guards ?? []).filter((event) => event.kind === "session.sample.rejected").map(eventKey));
      for (const key of rejected) if (key) eligibleKeys.delete(key);
      if (!starts.length || eligibleKeys.size !== keys.size) violations.push(`steady_recording_gate_changed:${window.label}`);
      const appends = (guards ?? []).filter((event) => event.kind === "session.sample.appended");
      if (appends.some((event) => event.sessionId !== startedId || event.index <= (starts[0]?.index ?? Infinity) || event.index >= (frozen?.index ?? -Infinity))) violations.push(`recording_append_causality:${window.label}`);
      const consumerKey = (event: ProbeEvent) => `${event.consumerId}:${eventKey(event)}`;
      const attempts = new Map((settled ?? []).filter((event) => event.kind === "sample.delivery.attempted").map((event) => [consumerKey(event), event]));
      const returns = new Map((settled ?? []).filter((event) => event.kind === "sample.delivery.returned").map((event) => [consumerKey(event), event]));
      if (appends.some((event) => {
        const attempt = attempts.get(consumerKey(event)), returned = returns.get(consumerKey(event));
        return typeof event.consumerId !== "string" || !attempt || !returned || attempt.index >= event.index || returned.index <= event.index;
      })) violations.push(`recording_dispatch_causality:${window.label}`);
      const appended = coverage(eligibleKeys, keyCounts(appends.filter((event) => event.sessionId === startedId)));
      if (appended.missing || appended.duplicated) violations.push(`recording_append_integrity:${window.label}`);
    }
    const persisted = run.condition.scenario === "S2" ? coverage(eligibleKeys, recordingSavedKeys) : null;
    if (persisted && (persisted.missing || persisted.duplicated)) violations.push(`recording_cohort_mismatch:${window.label}`);
    return { ...window, actualDurationMs: window.t1 - window.t0, fixtureTiming: { eligibilityToGenerationMs: distribution(cohort.map((frame) => frame.generatedAtMs - frame.plannedAtMs)), generatedToDeliveryMs: distribution(cohort.map((frame) => frame.deliveredAtMs! - frame.generatedAtMs)), requestedToDeliveryMs: distribution(cohort.map((frame) => frame.deliveredAtMs! - frame.requestedAtMs)) }, cohortFrames: cohort.length, perStream, stages, pipelineCausalOrderErrors,
      productCounts: timed ? counts(timed) : null, subscriberLifetimes: events ? subscriptions : null, recordingGuardReasons: rejectionReasons,
      recordingGates, recordingEligibility: run.condition.scenario === "S2" ? events ? "Independent delivered cohort intersect start-confirmed/frozen interval; guard exclusions reported and invalidate steady recording" : "Internal gates unavailable; normal UI establishes steady active interval and final files independently reconcile delivered IDs" : "not a recording cohort", persisted,
      profilers, repeatedWorkbenchCommitTimeCount: react ? repeatedWorkbenchCommitTimeCount : null, workbenchTimestampAmbiguous: react ? repeatedWorkbenchCommitTimeCount > 0 : null, persistedOutsideExpectedMeaning: "Full Session may include valid warmup and tail IDs outside the measured cohort", commitTimeGroupingCaveat: "Timestamp groups associate nested callbacks; clock resolution can also group distinct commits. Boundary callback counts remain primary.", distinctCommitTimestamps: react ? new Set(react.map((event) => event.commitTime)).size : null };
  });
  if (unknownSaved || foreignSaved.length) violations.push("unmatched_saved_input_keys");
  return { runId: run.runId, condition: run.condition.id, mode: run.mode, repeat: run.repeat, exploratory: run.exploratory,
    valid: violations.length === 0, violations, windows, saved: { sessions: run.sessions.length, keys: savedKeys.size, outOfOrder: savedOrderErrors, timestampOrderErrors: savedTimeErrors, unknownKeys: unknownSaved, foreignKeys: foreignSaved.length },
    instrumentation: events ? "on" : "unavailable", evidenceBoundary: "synthetic local software measurement, not RF/hardware throughput or production profiling" };
}
