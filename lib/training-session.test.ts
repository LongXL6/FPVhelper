import { describe, expect, it } from "vitest";
import { EMPTY_TELEMETRY } from "./telemetry";
import {
  appendTrainingSessionSample,
  createTrainingSessionDraft,
  finishTrainingSession,
  parseTrainingSession,
  recoverInterruptedTrainingSession,
  serializeTrainingSession,
  trainingSessionFilename,
  type TrainingSessionDraft,
} from "./training-session";

const STARTED_AT = 1_700_000_000_000;
const STARTED_MONOTONIC = 1_000;

function createDraft(source: "demo" | "serial" = "serial", athleteCode = "PILOT-07") {
  return createTrainingSessionDraft({
    id: "session-12345678",
    athleteCode,
    source,
    startedAtEpochMs: STARTED_AT,
    startedMonotonicMs: STARTED_MONOTONIC,
  });
}

function addSample(draft: TrainingSessionDraft, sequence: number, source: "demo" | "serial" = "serial") {
  return appendTrainingSessionSample(draft, {
    ...EMPTY_TELEMETRY,
    timestamp: STARTED_AT + sequence * 200,
    monotonicTimestampMs: STARTED_MONOTONIC + sequence * 200,
    sequence,
    rcChannelsUs: [1520, 1480, 1500, 1600, 1800, 1000],
    rollStickPercent: 4,
    throttleStickPercent: 60,
    rcThrottleUs: 1600,
    groundMspRssiPercent: 92,
    groundBridgeVoltage: 5,
  }, source);
}

function createValidSessionDraft() {
  const draft = createDraft();
  for (let sequence = 1; sequence <= 300; sequence += 1) addSample(draft, sequence);
  return draft;
}

describe("local training session schema v2", () => {
  it("records unique samples with raw RC channels and local wall-clock time", () => {
    const draft = createDraft();

    expect(addSample(draft, 1)).toBe(true);
    expect(addSample(draft, 1)).toBe(false);
    expect(draft.wallClockStartedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    expect(draft.samples[0]).toMatchObject({
      elapsedMs: 200,
      sequence: 1,
      source: "ground_rc",
      channelsUs: [1520, 1480, 1500, 1600, 1800, 1000],
      rc: { rollStickPercent: 4, throttleStickPercent: 60, throttleUs: 1600 },
      groundBridge: { mspRssiPercent: 92, voltage: 5 },
    });
  });

  it("accepts only a real, long enough, strictly monotonic, identified ground RC session", () => {
    const session = finishTrainingSession(
      createValidSessionDraft(),
      STARTED_AT + 60_000,
      STARTED_MONOTONIC + 60_000,
    );

    expect(session).toMatchObject({
      schemaVersion: 2,
      athleteCode: "PILOT-07",
      durationMs: 60_000,
      dataSources: ["ground_rc"],
      sampleCount: 300,
      interrupted: false,
      validity: { valid: true, reasons: [] },
      video: { recorded: false, synchronized: false },
      timing: { clock: "performance.now", videoOffsetCalibrated: false },
    });
    expect(parseTrainingSession(serializeTrainingSession(session))).toEqual(session);
    expect(serializeTrainingSession(session)).not.toContain("\n  \"");
    expect(trainingSessionFilename(session)).toMatch(/^fpv-session-\d{8}-\d{6}-PILOT-07-12345678\.json$/);
  });

  it("reports mixed, short, duplicate, non-monotonic, anonymous and interrupted records", () => {
    const draft = createDraft("serial", "   ");
    addSample(draft, 1);
    addSample(draft, 2, "demo");
    draft.samples.push({ ...draft.samples[1], elapsedMs: draft.samples[0].elapsedMs });
    const session = finishTrainingSession(draft, STARTED_AT + 1_000, STARTED_MONOTONIC + 1_000, { interrupted: true });

    expect(session.validity).toEqual({
      valid: false,
      reasons: [
        "source_not_ground_rc",
        "mixed_sources",
        "too_short",
        "too_few_unique_samples",
        "non_monotonic",
        "no_athlete_code",
        "interrupted",
      ],
    });
  });

  it("recovers a persisted draft as an interrupted session", () => {
    const draft = createDraft();
    addSample(draft, 1);
    const recovered = recoverInterruptedTrainingSession(draft);

    expect(recovered.interrupted).toBe(true);
    expect(recovered.durationMs).toBe(200);
    expect(recovered.endedAt).toBe(new Date(STARTED_AT + 200).toISOString());
    expect(recovered.validity.reasons).toContain("interrupted");
  });

  it("migrates exported schema v1 sessions and derives the four legacy RC channels", () => {
    const migrated = parseTrainingSession({
      schemaVersion: 1,
      id: "legacy-session",
      startedAt: new Date(STARTED_AT).toISOString(),
      endedAt: new Date(STARTED_AT + 1_000).toISOString(),
      durationMs: 1_000,
      initialSource: "ground_rc",
      samples: [{
        elapsedMs: 100,
        sequence: 1,
        source: "ground_rc",
        rc: {
          rollStickPercent: 20,
          pitchStickPercent: -10,
          yawStickPercent: 0,
          throttleStickPercent: 60,
          throttleUs: 1600,
        },
        groundBridge: { mspRssiPercent: null, voltage: null },
      }],
    });

    expect(migrated).toMatchObject({
      schemaVersion: 2,
      migratedFromSchemaVersion: 1,
      athleteCode: null,
      markers: [],
      sampleCount: 1,
    });
    expect(migrated.samples[0].channelsUs).toEqual([1600, 1450, 1500, 1600]);
    expect(migrated.validity.reasons).toContain("no_athlete_code");
  });
});
