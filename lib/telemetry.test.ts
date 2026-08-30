import { describe, expect, it } from "vitest";
import {
  buildMspV1Request,
  connectionStateAfterRcSilence,
  createDemoTelemetry,
  decodeAnalog,
  decodeMotors,
  decodeRc,
  EMPTY_TELEMETRY,
  MSP,
  MspV1StreamParser,
} from "./telemetry";

function responseFrame(command: number, payload: number[]) {
  let checksum = payload.length ^ command;
  for (const byte of payload) checksum ^= byte;
  return Uint8Array.from([36, 77, 62, payload.length, command, ...payload, checksum]);
}

function uint16Payload(values: number[]) {
  return values.flatMap((value) => [value & 0xff, value >> 8]);
}

describe("MSP v1 telemetry", () => {
  it("builds a read-only request", () => {
    expect(Array.from(buildMspV1Request(MSP.RC))).toEqual([36, 77, 60, 0, 105, 105]);
  });

  it("parses frames split across USB chunks", () => {
    const parser = new MspV1StreamParser();
    const frame = responseFrame(MSP.RC, uint16Payload([1500, 1250, 1750, 1600]));
    expect(parser.push(frame.slice(0, 4))).toEqual([]);
    const parsed = parser.push(frame.slice(4));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].command).toBe(MSP.RC);
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

  it("decodes motor output and ground bridge analog values", () => {
    expect(decodeMotors(Uint8Array.from(uint16Payload([1200, 1300, 1400, 1500]))).motorAveragePercent).toBe(35);
    const analog = decodeAnalog(Uint8Array.from([159, 0, 0, 0xff, 0x03]));
    expect(analog).toEqual({ groundBridgeVoltage: 15.9, groundMspRssiPercent: 100 });
  });
});
