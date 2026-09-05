import { describe, expect, it } from "vitest";
import {
  BETAFLIGHT_NAME_RESPONSE_TIMEOUT_MS,
  BetaflightNameReader,
  EMPTY_BETAFLIGHT_DEVICE_NAMES,
} from "./betaflight-device-name";
import { buildMspV1Request, buildMspV2GetTextRequest, MSP, type MspFrame } from "./telemetry";

function reply(command: number, payload: number[], error = false): MspFrame {
  return { command, payload: Uint8Array.from(payload), error };
}

function textReply(type: 1 | 2, text: string) {
  const bytes = [...text].map((character) => character.charCodeAt(0));
  return reply(MSP.GET_TEXT, [type, bytes.length, ...bytes]);
}

function modernReader() {
  const reader = new BetaflightNameReader();
  reader.nextRequest(0);
  reader.acceptFrame(reply(MSP.API_VERSION, [0, 1, 45]));
  return reader;
}

describe("optional Betaflight device name reads", () => {
  it("starts with a stable idle snapshot and publishes only changed values", () => {
    const reader = new BetaflightNameReader();
    expect(reader.getSnapshot()).toBe(EMPTY_BETAFLIGHT_DEVICE_NAMES);
    expect(reader.nextRequest(Number.NaN)).toBeNull();
    expect(reader.getSnapshot()).toBe(EMPTY_BETAFLIGHT_DEVICE_NAMES);
    expect(reader.nextRequest(0)).toEqual(buildMspV1Request(MSP.API_VERSION));
    const reading = reader.getSnapshot();
    expect(reading.status).toBe("reading");
    expect(Object.isFrozen(reading)).toBe(true);
    reader.acceptFrame(reply(MSP.RC, [1, 2, 3, 4]));
    expect(reader.nextRequest(10)).toBeNull();
    expect(reader.getSnapshot()).toBe(reading);
    reader.acceptFrame(reply(MSP.API_VERSION, [0, 1, 45]));
    expect(reader.nextRequest(11)).toEqual(buildMspV2GetTextRequest(1));
    expect(reader.getSnapshot()).toBe(reading);
  });

  it("reads pilot and craft names separately on API 1.45 and never polls them again", () => {
    const reader = modernReader();
    expect(reader.nextRequest(1)).toEqual(buildMspV2GetTextRequest(1));
    reader.acceptFrame(textReply(1, " LongXL "));
    expect(reader.getSnapshot()).toEqual({ pilotName: "LongXL", craftName: "", status: "reading" });
    expect(reader.nextRequest(2)).toEqual(buildMspV2GetTextRequest(2));
    reader.acceptFrame(textReply(2, "RACE-01"));
    const complete = reader.getSnapshot();
    expect(complete).toEqual({ pilotName: "LongXL", craftName: "RACE-01", status: "ready" });
    expect(reader.nextRequest(3)).toBeNull();
    expect(reader.nextRequest(1_000_000)).toBeNull();
    reader.acceptFrame(textReply(1, "Late name"));
    expect(reader.getSnapshot()).toBe(complete);
  });

  it("uses the legacy craft query for API 1.44 without inventing a pilot name", () => {
    const reader = new BetaflightNameReader();
    reader.nextRequest(0);
    reader.acceptFrame(reply(MSP.API_VERSION, [0, 1, 44]));
    expect(reader.nextRequest(1)).toEqual(buildMspV1Request(MSP.NAME));
    reader.acceptFrame(reply(MSP.NAME, [70, 80, 86, 45, 48, 49]));
    expect(reader.getSnapshot()).toEqual({ pilotName: "", craftName: "FPV-01", status: "ready" });
    expect(reader.nextRequest(2)).toBeNull();
  });

  it.each([
    reply(MSP.API_VERSION, [], true),
    reply(MSP.API_VERSION, [0, 1]),
    reply(MSP.API_VERSION, [0, 1, 45, 99]),
  ])("falls back when the API query is rejected or malformed: %j", (frame) => {
    const reader = new BetaflightNameReader();
    reader.nextRequest(0);
    reader.acceptFrame(frame);
    expect(reader.nextRequest(1)).toEqual(buildMspV1Request(MSP.NAME));
  });

  it("bounds both silent API and legacy queries without retrying forever", () => {
    const reader = new BetaflightNameReader();
    const timeout = BETAFLIGHT_NAME_RESPONSE_TIMEOUT_MS;
    expect(reader.nextRequest(0)).toEqual(buildMspV1Request(MSP.API_VERSION));
    expect(reader.nextRequest(timeout - 1)).toBeNull();
    expect(reader.nextRequest(timeout)).toEqual(buildMspV1Request(MSP.NAME));
    expect(reader.nextRequest(timeout * 2 - 1)).toBeNull();
    expect(reader.nextRequest(timeout * 2)).toBeNull();
    const final = reader.getSnapshot();
    expect(final).toEqual({ pilotName: "", craftName: "", status: "unavailable" });
    expect(reader.nextRequest(timeout * 100)).toBeNull();
    expect(reader.getSnapshot()).toBe(final);
  });

  it("tries at most four distinct requests when modern text queries stay silent", () => {
    const reader = modernReader();
    const timeout = BETAFLIGHT_NAME_RESPONSE_TIMEOUT_MS;
    expect(reader.nextRequest(1)).toEqual(buildMspV2GetTextRequest(1));
    expect(reader.nextRequest(1 + timeout)).toEqual(buildMspV2GetTextRequest(2));
    expect(reader.nextRequest(1 + timeout * 2)).toEqual(buildMspV1Request(MSP.NAME));
    expect(reader.nextRequest(1 + timeout * 3)).toBeNull();
    expect(reader.getSnapshot().status).toBe("unavailable");
  });

  it("ignores unrelated, wrong-type and late pilot frames while awaiting craft", () => {
    const reader = modernReader();
    reader.nextRequest(1);
    const waitingForPilot = reader.getSnapshot();
    reader.acceptFrame(textReply(2, "Wrong type"));
    reader.acceptFrame(reply(MSP.RC, [], true));
    expect(reader.getSnapshot()).toBe(waitingForPilot);
    reader.acceptFrame(textReply(1, "Pilot"));
    reader.nextRequest(2);
    const waitingForCraft = reader.getSnapshot();
    reader.acceptFrame(textReply(1, "Late pilot"));
    reader.acceptFrame(reply(MSP.GET_TEXT, [], true));
    expect(reader.nextRequest(3)).toBeNull();
    expect(reader.getSnapshot()).toBe(waitingForCraft);
    reader.acceptFrame(textReply(2, "Craft"));
    expect(reader.getSnapshot()).toEqual({ pilotName: "Pilot", craftName: "Craft", status: "ready" });
  });

  it("times out untyped text errors and can still recover the legacy craft name", () => {
    const reader = modernReader();
    const timeout = BETAFLIGHT_NAME_RESPONSE_TIMEOUT_MS;
    reader.nextRequest(1);
    reader.acceptFrame(reply(MSP.GET_TEXT, [], true));
    expect(reader.nextRequest(timeout)).toBeNull();
    expect(reader.nextRequest(timeout + 1)).toEqual(buildMspV2GetTextRequest(2));
    reader.acceptFrame(reply(MSP.GET_TEXT, [], true));
    expect(reader.nextRequest(timeout * 2 + 1)).toEqual(buildMspV1Request(MSP.NAME));
    reader.acceptFrame(reply(MSP.NAME, [67, 114, 97, 102, 116]));
    expect(reader.getSnapshot()).toEqual({ pilotName: "", craftName: "Craft", status: "ready" });
  });

  it("preserves a valid pilot name when craft and legacy reads fail", () => {
    const reader = modernReader();
    reader.nextRequest(1);
    reader.acceptFrame(textReply(1, "Pilot"));
    reader.nextRequest(2);
    reader.acceptFrame(reply(MSP.GET_TEXT, [2, 10, 65]));
    expect(reader.nextRequest(3)).toEqual(buildMspV1Request(MSP.NAME));
    reader.acceptFrame(reply(MSP.NAME, [], true));
    expect(reader.getSnapshot()).toEqual({ pilotName: "Pilot", craftName: "", status: "ready" });
  });

  it.each([[1], [1, 5, 65], [1, 1, 65, 66]].map((payload) => ({ payload })))("rejects malformed text lengths $payload and proceeds to the other name", ({ payload }) => {
    const reader = modernReader();
    reader.nextRequest(1);
    reader.acceptFrame(reply(MSP.GET_TEXT, payload));
    expect(reader.nextRequest(2)).toEqual(buildMspV2GetTextRequest(2));
    reader.acceptFrame(textReply(2, "Craft"));
    expect(reader.getSnapshot()).toEqual({ pilotName: "", craftName: "Craft", status: "ready" });
  });

  it("leaves genuinely empty names unavailable without filling in a fabricated identity", () => {
    const reader = modernReader();
    reader.nextRequest(1);
    reader.acceptFrame(textReply(1, ""));
    reader.nextRequest(2);
    reader.acceptFrame(textReply(2, "  "));
    expect(reader.getSnapshot()).toEqual({ pilotName: "", craftName: "", status: "unavailable" });
    expect(reader.nextRequest(3)).toBeNull();
  });

  it("decodes the Configurator's single-byte characters without UTF-8 reinterpretation", () => {
    const reader = modernReader();
    reader.nextRequest(1);
    reader.acceptFrame(reply(MSP.GET_TEXT, [1, 4, 67, 97, 102, 233]));
    reader.nextRequest(2);
    reader.acceptFrame(textReply(2, ""));
    expect(reader.getSnapshot().pilotName).toBe("Caf\u00e9");
  });

  it("rejects control characters rather than exposing a misleading device identity", () => {
    const reader = new BetaflightNameReader();
    reader.nextRequest(0);
    reader.acceptFrame(reply(MSP.API_VERSION, [0, 1, 44]));
    reader.nextRequest(1);
    reader.acceptFrame(reply(MSP.NAME, [65, 0, 66]));
    expect(reader.getSnapshot().status).toBe("unavailable");
  });

  it("resets names and pending requests before a new connection", () => {
    const reader = modernReader();
    reader.nextRequest(1);
    reader.acceptFrame(textReply(1, "Previous pilot"));
    reader.nextRequest(2);
    reader.reset();
    reader.acceptFrame(textReply(2, "Previous craft"));
    expect(reader.getSnapshot()).toBe(EMPTY_BETAFLIGHT_DEVICE_NAMES);
    expect(reader.nextRequest(3)).toEqual(buildMspV1Request(MSP.API_VERSION));
    expect(reader.getSnapshot()).toEqual({ pilotName: "", craftName: "", status: "reading" });
  });
});
