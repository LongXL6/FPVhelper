import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fixtureFrameKey } from "../e2e/fixtures/measurement-hardware";
import { analyzeMeasurementRun, parseMeasurementPlan, type MeasurementResult, type ProbeEvent } from "./phase1a-analysis";

const channels = (index: number, stream = 1, generation = 1) => [1600, 1500, 1500, 1250, 1000 + index % 1001, 1000 + Math.floor(index / 1001), 1000 + stream, 1000 + generation];
function fixture(recording = false): MeasurementResult {
  const events: ProbeEvent[] = [];
  const add = (kind: string, timeMs: number, fields = {}) => events.push({ index: events.length, kind, timeMs, ...fields });
  add("sample.subscription.add", 80, { hookId: "hook-1", subscriptionId: "sub-1", consumerId: "consumer-1", added: true });
  if (recording) add("session.start.confirmed", 90, { sessionId: "session-1" });
  for (const index of [0, 1, 2, 3]) {
    const fields = { hookId: "hook-1", channelsUs: channels(index), source: "serial", sequence: 777 + index, subscriptionId: "sub-1", consumerId: "consumer-1" };
    add("rc.decoded", 100 + index * 10, fields);
    add("sample.published", 100 + index * 10, fields);
    add("sample.delivery.attempted", 100 + index * 10, fields);
    if (recording) add("session.sample.appended", 100 + index * 10, { ...fields, sessionId: "session-1" });
    add("sample.delivery.returned", 100 + index * 10, fields);
  }
  add("react.commit", 140, { profilerId: "workbench", commitTime: 120, phase: "update", actualDuration: 2 });
  add("react.commit", 141, { profilerId: "recording-ui", commitTime: 120, phase: "update", actualDuration: 1 });
  if (recording) { add("session.stop.frozen", 150, { sessionId: "session-1" }); add("session.complete.confirmed", 170, { sessionId: "session-1" }); }
  return {
    runId: "test", condition: { id: recording ? "S2" : "S1-100", scenario: recording ? "S2" : "S1", inputHz: 100, modes: ["P1"] }, mode: "P1", repeat: 1, exploratory: true,
    windows: [{ label: "steady", t0: 100, t1: 130, drainEnd: 160, steady: true }],
    hardware: { timeOriginEpochMs: 1000, timeMs: 200, frames: [0, 1, 2, 3].map((frameIndex) => ({ streamId: 1, generation: 1, frameIndex, plannedAtMs: 100 + frameIndex * 10, requestedAtMs: 99 + frameIndex * 10, generatedAtMs: 100 + frameIndex * 10, deliveredAtMs: 100 + frameIndex * 10 })), detailed: [], overflowCount: 0, protocolErrors: [], ports: [], media: { requests: 0, tracks: [] } },
    probe: { mode: "on", enabled: true, timeOriginEpochMs: 1000, overflowCount: 0, events },
    sessions: recording ? [{ id: "session-1", samples: [0, 1, 2, 3].map((index) => ({ channelsUs: channels(index), sequence: 777 + index, elapsedMs: index * 10 })) }] : [], errors: [], networkViolations: [],
  };
}

describe("independent fixture identity", () => {
  it("distinguishes repeated primary axes, rollover, stream and generation without product sequence", () => {
    expect(channels(0).slice(0, 4)).toEqual(channels(1).slice(0, 4));
    expect([channels(0), channels(1), channels(1001), channels(0, 2), channels(0, 1, 2)].map(fixtureFrameKey)).toEqual(["1:1:0", "1:1:1", "1:1:1001", "2:1:0", "1:2:0"]);
    expect(fixtureFrameKey([1500, 1500, 1500, 1500])).toBeNull();
    expect(fixtureFrameKey(channels(0, 3))).toBeNull();
    expect(fixtureFrameKey(channels(0, 1, 0))).toBeNull();
  });
});
describe("measurement reconciliation", () => {
  it("uses delivered [t0,t1), retains late completions within drain, and uses React commitTime", () => {
    const run = fixture();
    run.probe!.events.find((event) => event.kind === "sample.delivery.returned" && fixtureFrameKey(event.channelsUs as number[]) === "1:1:2")!.timeMs = 150;
    const report = analyzeMeasurementRun(run);
    expect(report.valid).toBe(true);
    expect(report.windows[0].cohortFrames).toBe(3);
    expect(report.windows[0].profilers?.workbench.callbackCount).toBe(1);
    expect(report.windows[0].distinctCommitTimestamps).toBe(1);
    expect(report.windows[0].persisted).toBeNull();
  });
  it("fails a lost publication, retaining the independent input in subscriber denominator", () => {
    const run = fixture();
    run.probe!.events = run.probe!.events.filter((event) => !(event.kind === "sample.published" && fixtureFrameKey(event.channelsUs as number[]) === "1:1:1"));
    const report = analyzeMeasurementRun(run);
    expect(report.valid).toBe(false);
    expect(report.violations).toContain("raw_integrity:steady:sample.published");
    expect(report.windows[0].subscriberLifetimes?.[0].attempted).toMatchObject({ expected: 3 });
  });
  it("fails missing delivery and callback throws after drain", () => {
    const run = fixture();
    run.probe!.events.find((event) => event.kind === "sample.delivery.returned")!.timeMs = 161;
    const report = analyzeMeasurementRun(run);
    expect(report.valid).toBe(false);
    expect(report.violations).toContain("subscriber_integrity:steady:sub-1");
  });
  it("does not expect delivery after a real subscription ended", () => {
    const run = fixture();
    const insertion = run.probe!.events.findIndex((event) => event.kind === "rc.decoded" && event.timeMs === 110);
    run.probe!.events.splice(insertion, 0, { index: 0, kind: "sample.subscription.remove", timeMs: 105, subscriptionId: "sub-1", deleted: true });
    run.probe!.events = run.probe!.events.filter((event) => !(event.kind.startsWith("sample.delivery.") && event.timeMs >= 110));
    run.probe!.events.forEach((event, index) => { event.index = index; });
    const report = analyzeMeasurementRun(run);
    expect(report.valid).toBe(true);
    expect(report.windows[0].subscriberLifetimes?.[0].attempted).toMatchObject({ expected: 1, missing: 0 });
  });
  it("fails duplicate and reversed raw observations", () => {
    const run = fixture();
    const decoded = run.probe!.events.filter((event) => event.kind === "rc.decoded");
    [decoded[0].channelsUs, decoded[1].channelsUs] = [decoded[1].channelsUs, decoded[0].channelsUs];
    run.probe!.events.push({ ...decoded[0], index: 100 });
    const report = analyzeMeasurementRun(run);
    expect(report.valid).toBe(false);
    expect(report.windows[0].stages?.["rc.decoded"]).toMatchObject({ duplicated: 1, outOfOrder: 2 });
  });
  it("matches completed recording and rejects missing, reversed or foreign persisted inputs", () => {
    expect(analyzeMeasurementRun(fixture(true)).valid).toBe(true);
    const missing = fixture(true); missing.sessions[0].samples.splice(1, 1);
    expect(analyzeMeasurementRun(missing).violations).toContain("recording_cohort_mismatch:steady");
    const reversed = fixture(true); reversed.sessions[0].samples.reverse();
    expect(analyzeMeasurementRun(reversed).violations).toContain("saved_input_out_of_order");
    const foreign = fixture(true); foreign.sessions[0].samples[0].channelsUs = channels(0, 2);
    expect(analyzeMeasurementRun(foreign).violations).toContain("unmatched_saved_input_keys");
  });
  it("reports recording gates independently, and invalidates an unexpected steady guard exclusion", () => {
    const run = fixture(true);
    const append = run.probe!.events.find((event) => event.kind === "session.sample.appended")!;
    append.kind = "session.sample.rejected"; append.reason = "connection_not_live";
    const report = analyzeMeasurementRun(run);
    expect(report.valid).toBe(false);
    expect(report.windows[0].recordingGuardReasons).toEqual({ connection_not_live: 1 });
    expect(report.windows[0].recordingGates?.[0]).toMatchObject({ startTimeMs: 90, freezeTimeMs: 150 });
  });
  it("keeps N/P0 internal counts unavailable while still checking final S2 persisted data", () => {
    for (const mode of ["N", "P0"] as const) {
      const run = fixture(true); run.mode = mode;
      run.probe = mode === "N" ? null : { ...run.probe!, mode: "off", enabled: false, events: [] };
      const report = analyzeMeasurementRun(run);
      expect(report.valid).toBe(true);
      expect(report.windows[0].stages).toBeNull(); expect(report.windows[0].profilers).toBeNull();
      expect(report.windows[0].productCounts).toBeNull(); expect(report.windows[0].persisted?.observedUnique).toBe(3);
    }
  });
  it("rejects clock reversal without treating product sequence as fixture input truth", () => {
    const run = fixture(true); run.sessions[0].samples[2].elapsedMs = -1;
    run.hardware.frames[1].deliveredAtMs = run.hardware.frames[1].generatedAtMs - 1;
    expect(analyzeMeasurementRun(run).violations).toEqual(expect.arrayContaining(["saved_timestamp_order_error", "fixture_clock_order_error"]));
  });
  it("rejects two simultaneous source identities routed through the same hook", () => {
    const run = fixture(); run.condition = { id: "S3", scenario: "S3", inputHz: 100, modes: ["P1"] };
    for (const event of run.probe!.events) if (event.channelsUs && fixtureFrameKey(event.channelsUs as number[]) === "1:1:1") event.channelsUs = channels(1, 2);
    run.hardware.frames[1].streamId = 2;
    expect(analyzeMeasurementRun(run).violations).toContain("cross_source_hook_mix:steady");
  });
  it("fails extra deliveries after a subscription was removed, including a wholly inactive subscription", () => {
    for (const cutoff of [95, 105]) {
      const run = fixture();
      const insertion = run.probe!.events.findIndex((event) => event.timeMs > cutoff);
      run.probe!.events.splice(insertion, 0, { index: 0, kind: "sample.subscription.remove", timeMs: cutoff, subscriptionId: "sub-1", deleted: true });
      run.probe!.events.forEach((event, index) => { event.index = index; });
      const report = analyzeMeasurementRun(run);
      expect(report.violations).toContain("subscriber_integrity:steady:sub-1");
      expect(report.windows[0].subscriberLifetimes?.[0].attempted).toMatchObject({ outsideExpected: cutoff === 95 ? 3 : 2 });
    }
  });
  it("rejects a required active source with an empty cohort without asserting an ideal 100 Hz count", () => {
    const run = fixture(); run.hardware.frames = []; run.probe!.events = run.probe!.events.filter((event) => !event.channelsUs);
    expect(analyzeMeasurementRun(run).violations).toContain("missing_active_source:steady:1");
    run.condition = { id: "S0", scenario: "S0", inputHz: 0, modes: ["P1"] };
    expect(analyzeMeasurementRun(run).valid).toBe(true);
  });
  it("rejects callback return preceding its attempt even with equal timeMs", () => {
    const run = fixture();
    const attempted = run.probe!.events.findIndex((event) => event.kind === "sample.delivery.attempted");
    const returned = run.probe!.events.findIndex((event) => event.kind === "sample.delivery.returned");
    [run.probe!.events[attempted], run.probe!.events[returned]] = [run.probe!.events[returned], run.probe!.events[attempted]];
    run.probe!.events.forEach((event, index) => { event.index = index; });
    expect(analyzeMeasurementRun(run).windows[0].subscriberLifetimes?.[0].causalOrderErrors).toBe(1);
    expect(analyzeMeasurementRun(run).valid).toBe(false);
  });
  it("binds committed Session identity and append events to the actual started/frozen/completed session", () => {
    const run = fixture(true); run.sessions[0].id = "other-session";
    expect(analyzeMeasurementRun(run).violations).toContain("recording_session_identity:steady");
    const append = fixture(true); append.probe!.events.find((event) => event.kind === "session.sample.appended")!.sessionId = "wrong";
    expect(analyzeMeasurementRun(append).violations).toContain("recording_append_causality:steady");
    const incomplete = fixture(true); incomplete.probe!.events = incomplete.probe!.events.filter((event) => event.kind !== "session.complete.confirmed");
    expect(analyzeMeasurementRun(incomplete).violations).toContain("recording_session_identity:steady");
  });
  it("requires decoded then published then attempted order for the same input", () => {
    for (const [firstKind, secondKind] of [["rc.decoded", "sample.published"], ["sample.published", "sample.delivery.attempted"]]) {
      const run = fixture();
      const first = run.probe!.events.findIndex((event) => event.kind === firstKind);
      const second = run.probe!.events.findIndex((event) => event.kind === secondKind);
      [run.probe!.events[first], run.probe!.events[second]] = [run.probe!.events[second], run.probe!.events[first]];
      run.probe!.events.forEach((event, index) => { event.index = index; });
      expect(analyzeMeasurementRun(run).violations).toContain("pipeline_causality:steady");
    }
  });
  it("requires Session append inside its same consumer/input attempted-to-returned interval", () => {
    for (const outsideKind of ["sample.delivery.attempted", "sample.delivery.returned"]) {
      const run = fixture(true);
      const append = run.probe!.events.findIndex((event) => event.kind === "session.sample.appended");
      const outside = run.probe!.events.findIndex((event) => event.kind === outsideKind);
      [run.probe!.events[append], run.probe!.events[outside]] = [run.probe!.events[outside], run.probe!.events[append]];
      run.probe!.events.forEach((event, index) => { event.index = index; });
      expect(analyzeMeasurementRun(run).violations).toContain("recording_dispatch_causality:steady");
    }
  });
  it("reports repeated workbench timestamps as ambiguity while retaining every callback", () => {
    const run = fixture(); const event = run.probe!.events.find((event) => event.kind === "react.commit" && event.profilerId === "workbench")!;
    run.probe!.events.push({ ...event, index: 100 });
    const report = analyzeMeasurementRun(run);
    expect(report.valid).toBe(true); expect(report.windows[0].profilers?.workbench.callbackCount).toBe(2);
    expect(report.windows[0]).toMatchObject({ repeatedWorkbenchCommitTimeCount: 1, workbenchTimestampAmbiguous: true });
  });
  it("invalidates collector errors, overflow, network writes, and accidental normal build probe", () => {
    const run = fixture(); run.probe!.instrumentationErrorCount = 1; run.hardware.overflowCount = 1;
    run.networkViolations.push({ method: "POST" });
    expect(analyzeMeasurementRun(run).violations).toEqual(expect.arrayContaining(["instrumentation_error", "measurement_buffer_overflow", "unexpected_network_request"]));
    run.mode = "N";
    expect(analyzeMeasurementRun(run).violations).toContain("normal_build_exposed_probe");
  });
});
describe("frozen plan bounds", () => {
  const load = () => JSON.parse(readFileSync(new URL("../benchmarks/capture/measurement-plan.json", import.meta.url), "utf8"));
  it("reads explicit rotated order without generating a replacement order", () => {
    const plan = parseMeasurementPlan(load());
    expect(plan.runOrder).toHaveLength(30);
    expect(plan.runOrder.filter((run) => run.condition === "S1-100").map((run) => run.mode)).toEqual(["N", "P0", "P1", "P0", "P1", "N", "P1", "N", "P0"]);
  });
  it("rejects omitted/duplicate runs, oversized buffers, and excessive drain", () => {
    const missing = load(); missing.runOrder.pop(); expect(() => parseMeasurementPlan(missing)).toThrow(/cover/);
    const duplicate = load(); duplicate.runOrder[1] = duplicate.runOrder[0]; expect(() => parseMeasurementPlan(duplicate)).toThrow(/duplicate/);
    for (const [key, value] of [["cleanupMs", 20001], ["maxEvents", 200001], ["maxTraceBytes", 67108865], ["drainMs", 3001]] as const) { const plan = load(); plan[key] = value; expect(() => parseMeasurementPlan(plan)).toThrow(/budget/); }
  });
});
