import { describe, expect, it } from "vitest";
import { EMPTY_TELEMETRY } from "./telemetry";
import {
  assessTrainingAttemptCandidate,
  appendTrainingSessionSample,
  appendTrainingSessionMarker,
  createTrainingSessionDraft,
  finishTrainingSession,
  markTrainingSessionExported,
  parseTrainingSession,
  parseTrainingSessionDraft,
  recoverInterruptedTrainingSession,
  resolveTrainingSessionTermination,
  serializeTrainingSession,
  trainingSessionFilename,
  withTrainingSessionTermination,
  withTrainingSessionNotes,
  type TrainingSessionDraft,
} from "./training-session";

const STARTED_AT = 1_700_000_000_000;
const STARTED_MONOTONIC = 1_000;
const WORKSTATION_ID = "10000000-0000-4000-8000-000000000001";
const BUILD = "0.2.0+test";

function createDraft(source: "demo" | "serial" = "serial", athleteCode = "PILOT-07") {
  return createTrainingSessionDraft({
    id: "session-12345678",
    workstationId: WORKSTATION_ID,
    build: BUILD,
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
      notes: null,
      exportedAt: null,
      exportCount: 0,
      durationMs: 60_000,
      dataSources: ["ground_rc"],
      sampleCount: 300,
      interrupted: false,
      interruptionReason: null,
      validity: { valid: true, reasons: [] },
      video: { recorded: false, synchronized: false },
      timing: { clock: "performance.now", videoOffsetCalibrated: false },
    });
    expect(parseTrainingSession(serializeTrainingSession(session))).toEqual(session);
    expect(serializeTrainingSession(session)).not.toContain("\n  \"");
    expect(trainingSessionFilename(session)).toMatch(/^fpv-session-\d{8}-\d{6}-PILOT-07-12345678\.json$/);
  });

  it("writes workstation and trusted public-build metadata into new schema v2 JSON", () => {
    const draft = createTrainingSessionDraft({
      id: "session-metadata",
      workstationId: WORKSTATION_ID,
      build: "0.2.0+1234567",
      athleteCode: "PILOT-07",
      source: "serial",
      startedAtEpochMs: STARTED_AT,
      startedMonotonicMs: STARTED_MONOTONIC,
    });
    for (let sequence = 1; sequence <= 300; sequence += 1) addSample(draft, sequence);

    const session = finishTrainingSession(draft, STARTED_AT + 60_000, STARTED_MONOTONIC + 60_000);
    expect(session).toMatchObject({
      schemaVersion: 2,
      workstationId: "10000000-0000-4000-8000-000000000001",
      build: "0.2.0+1234567",
    });
    expect(parseTrainingSession(serializeTrainingSession(session))).toEqual(session);
  });

  it("rejects untrusted workstation and public-build metadata before recording", () => {
    const baseOptions = {
      id: "session-invalid-metadata",
      athleteCode: "PILOT-07",
      source: "serial" as const,
      startedAtEpochMs: STARTED_AT,
      startedMonotonicMs: STARTED_MONOTONIC,
    };

    expect(() => createTrainingSessionDraft({
      ...baseOptions,
      workstationId: "machine-name",
      build: BUILD,
    })).toThrow("workstationId 必须是 UUID");
    expect(() => createTrainingSessionDraft({
      ...baseOptions,
      workstationId: WORKSTATION_ID,
      build: "<script>alert(1)</script>",
    })).toThrow("build 必须是可信的公开构建标识");
  });

  it("records typed manual markers with monotonic elapsed and local wall-clock timestamps", () => {
    const draft = createDraft();

    const marker = appendTrainingSessionMarker(draft, {
      id: "marker-1",
      kind: "crash",
      wallClockEpochMs: STARTED_AT + 1_250,
      monotonicMs: STARTED_MONOTONIC + 1_250.4567,
    });

    expect(marker).toMatchObject({ id: "marker-1", kind: "crash", elapsedMs: 1_250.457 });
    expect(marker.wallClockAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    expect(draft.markers).toEqual([marker]);
  });

  it("persists normalized notes and repeatable export metadata without mutating the source session", () => {
    const session = finishTrainingSession(createValidSessionDraft(), STARTED_AT + 60_000, STARTED_MONOTONIC + 60_000);
    const noted = withTrainingSessionNotes(session, "  第一轮\r\n压弯过早  ");
    const firstExport = markTrainingSessionExported(noted, STARTED_AT + 61_000);
    const secondExport = markTrainingSessionExported(firstExport, STARTED_AT + 62_000);

    expect(session.notes).toBeNull();
    expect(noted.notes).toBe("第一轮\n压弯过早");
    expect(firstExport).toMatchObject({ exportCount: 1, exportedAt: new Date(STARTED_AT + 61_000).toISOString() });
    expect(secondExport).toMatchObject({ exportCount: 2, exportedAt: new Date(STARTED_AT + 62_000).toISOString() });
    expect(parseTrainingSession(serializeTrainingSession(secondExport))).toEqual(secondExport);
  });

  it("rejects inconsistent exportedAt and exportCount self-reporting", () => {
    const current = finishTrainingSession(createValidSessionDraft(), STARTED_AT + 60_000, STARTED_MONOTONIC + 60_000);
    const raw = JSON.parse(serializeTrainingSession(current)) as Record<string, unknown>;

    expect(() => parseTrainingSession({ ...raw, exportedAt: null, exportCount: 1 })).toThrow("exportedAt 与 exportCount 不一致");
    expect(() => parseTrainingSession({
      ...raw,
      exportedAt: new Date(STARTED_AT + 61_000).toISOString(),
      exportCount: 0,
    })).toThrow("exportedAt 与 exportCount 不一致");
  });

  it("keeps technical validity separate from the 80 percent attempt candidate", () => {
    const valid = finishTrainingSession(createValidSessionDraft(), STARTED_AT + 60_000, STARTED_MONOTONIC + 60_000);
    expect(valid.validity).toEqual({ valid: true, reasons: [] });
    expect(assessTrainingAttemptCandidate(valid)).toEqual({ candidate: false, reasons: ["missing_notes"] });

    const reviewed = withTrainingSessionNotes(valid, "压弯过早，下轮延后入弯");
    expect(reviewed.validity).toEqual(valid.validity);
    expect(assessTrainingAttemptCandidate(reviewed)).toEqual({ candidate: true, reasons: [] });

    const invalidReviewed = withTrainingSessionNotes(
      finishTrainingSession(createDraft("demo"), STARTED_AT + 1_000, STARTED_MONOTONIC + 1_000),
      "演示记录复盘",
    );
    expect(assessTrainingAttemptCandidate(invalidReviewed)).toEqual({ candidate: false, reasons: ["technically_invalid"] });
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
    expect(recovered.interruptionReason).toBe("page_closed");
    expect(recovered.durationMs).toBe(200);
    expect(recovered.endedAt).toBe(new Date(STARTED_AT + 200).toISOString());
    expect(recovered.validity.reasons).toContain("interrupted");
  });

  it("keeps old schema v2 drafts readable when workstation metadata did not exist", () => {
    const currentDraft = createDraft();
    const legacyDraft = { ...currentDraft } as Record<string, unknown>;
    delete legacyDraft.workstationId;
    delete legacyDraft.build;

    expect(parseTrainingSessionDraft(legacyDraft)).toMatchObject({
      schemaVersion: 2,
      workstationId: null,
      build: null,
    });
  });

  it("records ground RX loss as the explicit interruption and invalidity reason", () => {
    const session = finishTrainingSession(
      createValidSessionDraft(),
      STARTED_AT + 60_000,
      STARTED_MONOTONIC + 60_000,
      { interruptionReason: "rx_link_lost" },
    );

    expect(session).toMatchObject({
      interrupted: true,
      interruptionReason: "rx_link_lost",
      validity: { valid: false, reasons: ["rx_link_lost"] },
    });
    expect(parseTrainingSession(serializeTrainingSession(session))).toEqual(session);
  });

  it("upgrades a manual stop when RX loss wins the same termination race", () => {
    const manualStop = resolveTrainingSessionTermination(null, {
      interrupted: false,
      interruptionReason: null,
    });
    const rxLoss = resolveTrainingSessionTermination(manualStop, {
      interrupted: true,
      interruptionReason: "rx_link_lost",
    });
    const lateManualStop = resolveTrainingSessionTermination(rxLoss, {
      interrupted: false,
      interruptionReason: null,
    });
    const manuallyFinished = finishTrainingSession(
      createValidSessionDraft(),
      STARTED_AT + 60_000,
      STARTED_MONOTONIC + 60_000,
    );
    const upgraded = withTrainingSessionTermination(manuallyFinished, lateManualStop);

    expect(lateManualStop).toEqual({ interrupted: true, interruptionReason: "rx_link_lost" });
    expect(upgraded).toMatchObject({
      interrupted: true,
      interruptionReason: "rx_link_lost",
      validity: { valid: false },
    });
    expect(upgraded.validity.reasons).toContain("rx_link_lost");
  });

  it("persists a channel change as an interrupted schema v2 session", () => {
    const channelChange = resolveTrainingSessionTermination(null, {
      interrupted: true,
      interruptionReason: "channel_changed",
    });
    const laterTelemetryEffect = resolveTrainingSessionTermination(channelChange, {
      interrupted: true,
      interruptionReason: "telemetry_unavailable",
    });
    const session = finishTrainingSession(
      createValidSessionDraft(),
      STARTED_AT + 60_000,
      STARTED_MONOTONIC + 60_000,
      {
        interrupted: laterTelemetryEffect.interrupted,
        ...(laterTelemetryEffect.interruptionReason
          ? { interruptionReason: laterTelemetryEffect.interruptionReason }
          : {}),
      },
    );

    expect(laterTelemetryEffect).toEqual({ interrupted: true, interruptionReason: "channel_changed" });
    expect(session).toMatchObject({
      interrupted: true,
      interruptionReason: "channel_changed",
      validity: { valid: false },
    });
    expect(session.validity.reasons).toContain("interrupted");
    expect(parseTrainingSession(serializeTrainingSession(session))).toEqual(session);
  });

  it("keeps existing schema v2 sessions without interruptionReason readable", () => {
    const session = finishTrainingSession(createValidSessionDraft(), STARTED_AT + 60_000, STARTED_MONOTONIC + 60_000);
    const storedBeforeLinkIntegrity = { ...session } as Partial<typeof session>;
    delete storedBeforeLinkIntegrity.interruptionReason;

    expect(parseTrainingSession(storedBeforeLinkIntegrity).interruptionReason).toBeNull();
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
      workstationId: null,
      build: null,
      athleteCode: null,
      markers: [],
      sampleCount: 1,
    });
    expect(migrated.samples[0].channelsUs).toEqual([1600, 1450, 1500, 1600]);
    expect(migrated.validity.reasons).toContain("no_athlete_code");
  });

  it("keeps existing schema v2 records readable when additive metadata is absent", () => {
    const current = finishTrainingSession(createValidSessionDraft(), STARTED_AT + 60_000, STARTED_MONOTONIC + 60_000);
    const legacyV2 = JSON.parse(serializeTrainingSession(current)) as Record<string, unknown>;
    delete legacyV2.workstationId;
    delete legacyV2.build;

    const parsed = parseTrainingSession(legacyV2);
    expect(parsed).toMatchObject({
      schemaVersion: 2,
      workstationId: null,
      build: null,
      id: current.id,
      validity: current.validity,
    });

    expect(parseTrainingSession({
      ...legacyV2,
      workstationId: "old-local-machine-label",
      build: "old debug build",
    })).toMatchObject({ workstationId: null, build: null, id: current.id });
  });
});
