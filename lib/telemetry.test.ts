import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMspV1Request,
  buildMspV2GetTextRequest,
  canIssueMspRcRequest,
  createRcReceiveRate,
  connectionStateAfterRcSilence,
  createStatusExFreshnessWatchdog,
  createDemoTelemetry,
  decodeAnalog,
  decodeRc,
  decodeStatusExLinkState,
  EMPTY_TELEMETRY,
  MSP,
  MSP_ANALOG_POLL_INTERVAL_MS,
  MSP_RC_POLL_INTERVAL_MS,
  MSP_RC_RESPONSE_TIMEOUT_MS,
  MSP_RC_TARGET_HZ,
  MSP_STATUS_EX_POLL_INTERVAL_MS,
  mspParserQuality,
  MspV1StreamParser,
  STATUS_EX_STALE_TIMEOUT_MS,
  type ReadOnlyMspCommand,
} from "./telemetry";

afterEach(() => {
  vi.useRealTimers();
});

function responseFrame(command: number, payload: number[]) {
  let checksum = payload.length ^ command;
  for (const byte of payload) checksum ^= byte;
  return Uint8Array.from([36, 77, 62, payload.length, command, ...payload, checksum]);
}

function uint16Payload(values: number[]) {
  return values.flatMap((value) => [value & 0xff, value >> 8]);
}

// Native MSPv2 GET_TEXT reply: pilot name "LongXL", CRC8-DVB-S2 = 0x49.
const pilotNameFrame = Uint8Array.of(36, 88, 62, 0, 6, 48, 8, 0, 1, 6, 76, 111, 110, 103, 88, 76, 0x49);

describe("read-only MSP name queries and native v2 frames", () => {
  it("builds only the allowed metadata reads with fixed wire checksums", () => {
    expect([...buildMspV1Request(MSP.API_VERSION)]).toEqual([36, 77, 60, 0, 1, 1]);
    expect([...buildMspV1Request(MSP.NAME)]).toEqual([36, 77, 60, 0, 10, 10]);
    expect([...buildMspV2GetTextRequest(1)]).toEqual([36, 88, 60, 0, 6, 48, 1, 0, 1, 0x6f]);
    expect([...buildMspV2GetTextRequest(2)]).toEqual([36, 88, 60, 0, 6, 48, 1, 0, 2, 0xc5]);
    expect(() => buildMspV1Request(11 as ReadOnlyMspCommand)).toThrow(RangeError);
    expect(() => buildMspV1Request(MSP.GET_TEXT as ReadOnlyMspCommand)).toThrow(RangeError);
    expect(() => buildMspV2GetTextRequest(3 as 1 | 2)).toThrow(RangeError);
  });

  it("parses a native v2 name frame at every USB split point", () => {
    for (let split = 1; split < pilotNameFrame.length; split += 1) {
      const parser = new MspV1StreamParser();
      expect(parser.push(pilotNameFrame.subarray(0, split))).toEqual([]);
      expect(parser.push(pilotNameFrame.subarray(split))).toEqual([{
        command: MSP.GET_TEXT,
        payload: Uint8Array.of(1, 6, 76, 111, 110, 103, 88, 76),
        error: false,
      }]);
      expect(parser.getStats().checksumErrors).toBe(0);
    }
  });

  it("keeps v1 telemetry and v2 metadata in order in the same USB chunk", () => {
    const parser = new MspV1StreamParser();
    const rc = responseFrame(MSP.RC, uint16Payload([1500, 1250, 1750, 1600]));
    const analog = responseFrame(MSP.ANALOG, [50, 0, 0, 200, 0]);
    expect(parser.push(Uint8Array.from([...rc, ...pilotNameFrame, ...analog])).map((frame) => frame.command)).toEqual([
      MSP.RC, MSP.GET_TEXT, MSP.ANALOG,
    ]);
    expect(parser.getStats()).toMatchObject({ checksumValidFrames: 3, checksumErrors: 0, resyncs: 0 });
  });

  it("retains a native v2 header prefix after noisy input", () => {
    const parser = new MspV1StreamParser();
    expect(parser.push(Uint8Array.of(9, 2, 36, 88))).toEqual([]);
    expect(parser.push(pilotNameFrame.subarray(2))).toHaveLength(1);
    expect(parser.getStats()).toMatchObject({ discardedBytes: 2, resyncs: 1 });
  });

  it("checks native v2 flags as well as payload and recovers to a subsequent v1 frame", () => {
    const parser = new MspV1StreamParser();
    const corrupt = pilotNameFrame.slice();
    corrupt[3] = 1;
    const rc = responseFrame(MSP.RC, uint16Payload([1500, 1500, 1500, 1000]));
    expect(parser.push(Uint8Array.from([...corrupt, ...rc])).map((frame) => frame.command)).toEqual([MSP.RC]);
    expect(parser.getStats()).toMatchObject({ checksumErrors: 1, checksumValidFrames: 1 });
  });

  it("recovers from a corrupt v1 frame to a native v2 frame", () => {
    const parser = new MspV1StreamParser();
    const corrupt = responseFrame(MSP.RC, [0, 1]);
    corrupt[corrupt.length - 1] ^= 1;
    expect(parser.push(Uint8Array.from([...corrupt, ...pilotNameFrame])).map((frame) => frame.command)).toEqual([MSP.GET_TEXT]);
  });

  it("abandons an oversized v2 length only when a later checksummed frame is complete", () => {
    const parser = new MspV1StreamParser();
    expect(parser.push(Uint8Array.of(36, 88, 62, 0, 6, 48, 255, 255))).toEqual([]);
    expect(parser.push(pilotNameFrame.subarray(0, 10))).toEqual([]);
    expect(parser.push(pilotNameFrame.subarray(10))).toHaveLength(1);
    expect(parser.getStats()).toMatchObject({ discardedBytes: 8, checksumValidFrames: 1 });
  });

  it("preserves a following partial header when a corrupt length consumes its first bytes", () => {
    const parser = new MspV1StreamParser();
    const corrupt = Uint8Array.of(36, 77, 62, 4, MSP.NAME, 1, 2, 0);
    expect(parser.push(Uint8Array.from([...corrupt, 36, 88]))).toEqual([]);
    expect(parser.push(pilotNameFrame.subarray(2))).toHaveLength(1);
    expect(parser.getStats().checksumErrors).toBe(1);
  });

  it("surfaces a valid native v2 error without mistaking it for a CRC failure", () => {
    const parser = new MspV1StreamParser();
    expect(parser.push(Uint8Array.of(36, 88, 33, 0, 6, 48, 0, 0, 0x60))).toEqual([
      { command: MSP.GET_TEXT, payload: new Uint8Array(), error: true },
    ]);
    expect(parser.getStats()).toMatchObject({ protocolErrors: 1, checksumErrors: 0, checksumValidFrames: 1 });
  });

  it("reads the full little-endian 16-bit native v2 payload length", () => {
    const parser = new MspV1StreamParser();
    const payload = new Uint8Array(300).fill(65);
    const frame = Uint8Array.from([36, 88, 62, 0, 6, 48, 44, 1, ...payload, 0xc0]);
    expect(parser.push(frame.subarray(0, 270))).toEqual([]);
    expect(parser.push(frame.subarray(270))).toEqual([{ command: MSP.GET_TEXT, payload, error: false }]);
  });

  it("clears partially received native v2 frames on reset", () => {
    const parser = new MspV1StreamParser();
    parser.push(pilotNameFrame.subarray(0, 10));
    parser.reset();
    expect(parser.push(pilotNameFrame)).toHaveLength(1);
    expect(parser.getStats()).toMatchObject({ bytesReceived: pilotNameFrame.length, resyncs: 0 });
  });
});

describe("MSP v1 telemetry", () => {
  it("counts received RC frames in a rolling second without extrapolating startup or render rate", () => {
    const rate = createRcReceiveRate();
    expect(rate.getHz(0)).toBe(0);
    for (let timestamp = 10; timestamp <= 1_000; timestamp += 10) rate.observe(timestamp);
    expect(rate.getHz(1_000)).toBe(100);
    expect(rate.getHz(1_500)).toBe(50);
    expect(rate.getHz(2_000)).toBe(0);
    rate.observe(2_100);
    rate.observe(2_100);
    expect(rate.getHz(2_100)).toBe(2);
    rate.reset();
    expect(rate.getHz(2_100)).toBe(0);
  });

  it("targets 100 Hz RC polling without stacking unanswered requests", () => {
    expect(MSP_RC_TARGET_HZ).toBe(100);
    expect(MSP_RC_POLL_INTERVAL_MS).toBe(10);
    expect(MSP_STATUS_EX_POLL_INTERVAL_MS).toBe(100);
    expect(MSP_ANALOG_POLL_INTERVAL_MS).toBe(500);
    expect(canIssueMspRcRequest(1_000, null)).toBe(true);
    expect(canIssueMspRcRequest(1_099, 1_000)).toBe(false);
    expect(canIssueMspRcRequest(1_000 + MSP_RC_RESPONSE_TIMEOUT_MS, 1_000)).toBe(true);
  });

  it("builds a read-only request", () => {
    expect(Array.from(buildMspV1Request(MSP.RC))).toEqual([36, 77, 60, 0, 105, 105]);
    expect(Array.from(buildMspV1Request(MSP.STATUS_EX))).toEqual([36, 77, 60, 0, 150, 150]);
  });

  it("parses frames split across USB chunks", () => {
    const parser = new MspV1StreamParser();
    const frame = responseFrame(MSP.RC, uint16Payload([1500, 1250, 1750, 1600]));
    expect(parser.push(frame.slice(0, 4))).toEqual([]);
    const parsed = parser.push(frame.slice(4));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].command).toBe(MSP.RC);
  });

  it("discards a noisy prefix and retains a header split across chunks", () => {
    const parser = new MspV1StreamParser();
    const frame = responseFrame(MSP.RC, uint16Payload([1500, 1500, 1500, 1000]));

    expect(parser.push(Uint8Array.from([99, 0, 36, 77]))).toEqual([]);
    const parsed = parser.push(frame.slice(2));

    expect(parsed).toHaveLength(1);
    expect(parser.getStats()).toMatchObject({
      checksumValidFrames: 1,
      resyncs: 1,
      discardedBytes: 2,
    });
    expect(mspParserQuality(parser.getStats())).toBe("degraded");
  });

  it("recovers after a bad checksum without losing the following frame", () => {
    const parser = new MspV1StreamParser();
    const corrupted = responseFrame(MSP.RC, uint16Payload([1500, 1500, 1500, 1200]));
    corrupted[corrupted.length - 1] ^= 0xff;
    const recovered = responseFrame(MSP.ANALOG, [50, 0, 0, 200, 0]);
    const parsed = parser.push(Uint8Array.from([...corrupted, ...recovered]));

    expect(parsed.map((frame) => frame.command)).toEqual([MSP.ANALOG]);
    expect(parser.getStats()).toMatchObject({ checksumValidFrames: 1, checksumErrors: 1 });
  });

  it("abandons a truncated frame only when a later complete valid frame is available", () => {
    const parser = new MspV1StreamParser();
    const truncated = Uint8Array.from([36, 77, 62, 40, MSP.RC, 1, 2, 3]);
    const recovered = responseFrame(MSP.RC, uint16Payload([1500, 1250, 1750, 1600]));

    expect(parser.push(truncated)).toEqual([]);
    const parsed = parser.push(recovered);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].command).toBe(MSP.RC);
    expect(parser.getStats()).toMatchObject({
      checksumValidFrames: 1,
      resyncs: 1,
      discardedBytes: 8,
    });
  });

  it("counts FC protocol errors separately from checksum failures", () => {
    const parser = new MspV1StreamParser();
    const errorFrame = responseFrame(MSP.RC, []);
    errorFrame[2] = 33;
    const parsed = parser.push(errorFrame);

    expect(parsed).toEqual([{ command: MSP.RC, payload: new Uint8Array(), error: true }]);
    expect(parser.getStats()).toMatchObject({
      checksumValidFrames: 1,
      protocolErrors: 1,
      checksumErrors: 0,
    });
  });

  it("reports poor quality after repeated frame failures", () => {
    const parser = new MspV1StreamParser();
    for (let index = 0; index < 3; index += 1) {
      const corrupted = responseFrame(MSP.RC, [index]);
      corrupted[corrupted.length - 1] ^= 0xff;
      parser.push(corrupted);
    }
    expect(mspParserQuality(parser.getStats())).toBe("poor");
    parser.reset();
    expect(mspParserQuality(parser.getStats())).toBe("unknown");
  });

  it("decodes sticks and keeps RC throttle separate", () => {
    expect(decodeRc(Uint8Array.from(uint16Payload([1500, 1250, 1750, 1600, 988, 2012])))).toEqual({
      rollStickPercent: 0,
      pitchStickPercent: -50,
      yawStickPercent: 50,
      throttleStickPercent: 60,
      rcThrottleUs: 1600,
      rcChannelsUs: [1500, 1250, 1750, 1600, 988, 2012],
    });
  });

  it("marks live RC telemetry stale after 1.5 seconds of silence", () => {
    expect(connectionStateAfterRcSilence("live", 1499)).toBe("live");
    expect(connectionStateAfterRcSilence("live", 1500)).toBe("stale");
    expect(connectionStateAfterRcSilence("connecting", 5000)).toBe("connecting");
  });

  it("provides raw RC channels for empty and demo telemetry", () => {
    expect(EMPTY_TELEMETRY.rcChannelsUs).toEqual([]);
    expect(createDemoTelemetry(1000, 1).rcChannelsUs).toHaveLength(4);
  });

  it("decodes ground bridge analog values", () => {
    const analog = decodeAnalog(Uint8Array.from([159, 0, 0, 0xff, 0x03]));
    expect(analog).toEqual({ groundBridgeVoltage: 15.9, groundMspRssiPercent: 100 });
  });

  it("decodes Betaflight STATUS_EX arming flags at the official dynamic offset", () => {
    // Betaflight 3.5.7 API 1.40 through master 8303ba5 API 1.49 serialize 15 fixed bytes,
    // a flight-mode extension byte count, optional extension bytes, a flag count, then U32 LE flags.
    const okFixture = Uint8Array.from([
      0xe8, 0x03, 0, 0, 0x21, 0, 0, 0, 0, 0, 0, 50, 0, 3, 0,
      0,
      30, 0, 0, 0, 0,
    ]);
    const rxFailsafeFixture = Uint8Array.from([
      0xe8, 0x03, 0, 0, 0x21, 0, 0, 0, 0, 0, 0, 50, 0, 3, 0,
      0,
      30, 0x04, 0, 0, 0,
    ]);
    const failsafeWithExtendedModesFixture = Uint8Array.from([
      0xe8, 0x03, 0, 0, 0x21, 0, 0, 0, 0, 0, 0, 50, 0, 3, 0,
      2, 0xaa, 0x55,
      30, 0x02, 0, 0, 0,
    ]);

    expect(decodeStatusExLinkState(okFixture)).toBe("ok");
    expect(decodeStatusExLinkState(rxFailsafeFixture)).toBe("lost");
    expect(decodeStatusExLinkState(failsafeWithExtendedModesFixture)).toBe("lost");
  });

  it("keeps legacy, short, and malformed STATUS_EX payloads unknown", () => {
    // Betaflight 3.5.7's OSD-slave path returns only the 15-byte prefix and has no arming flags.
    expect(decodeStatusExLinkState(Uint8Array.from([
      0xe8, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 50, 0, 1, 0,
    ]))).toBe("unknown");
    expect(decodeStatusExLinkState(Uint8Array.from([
      0xe8, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 50, 0, 3, 0,
      3, 0xaa,
    ]))).toBe("unknown");
    expect(decodeStatusExLinkState(Uint8Array.from([
      0xe8, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 50, 0, 3, 0,
      0,
      2, 0, 0, 0, 0,
    ]))).toBe("unknown");
  });

  it("expires STATUS_EX freshness even while other telemetry can continue", () => {
    vi.useFakeTimers();
    const onStale = vi.fn();
    const watchdog = createStatusExFreshnessWatchdog(onStale);

    watchdog.observe();
    vi.advanceTimersByTime(STATUS_EX_STALE_TIMEOUT_MS - 1);
    expect(onStale).not.toHaveBeenCalled();

    watchdog.observe();
    vi.advanceTimersByTime(STATUS_EX_STALE_TIMEOUT_MS - 1);
    expect(onStale).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it("resets the STATUS_EX watchdog across disconnect and reconnect", () => {
    vi.useFakeTimers();
    const firstConnectionStale = vi.fn();
    const firstConnection = createStatusExFreshnessWatchdog(firstConnectionStale);

    firstConnection.observe();
    firstConnection.reset();
    vi.advanceTimersByTime(STATUS_EX_STALE_TIMEOUT_MS);
    expect(firstConnectionStale).not.toHaveBeenCalled();

    const reconnectedStale = vi.fn();
    const reconnected = createStatusExFreshnessWatchdog(reconnectedStale);
    reconnected.observe();
    vi.advanceTimersByTime(STATUS_EX_STALE_TIMEOUT_MS);
    expect(reconnectedStale).toHaveBeenCalledTimes(1);
  });
});
