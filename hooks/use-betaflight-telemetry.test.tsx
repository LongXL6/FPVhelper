import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MSP, type FlightTelemetry } from "../lib/telemetry";
import { useBetaflightTelemetry, type TelemetryController } from "./use-betaflight-telemetry";

vi.mock("@/lib/telemetry", () => import("../lib/telemetry"));
vi.mock("@/lib/hardware-errors", () => import("../lib/hardware-errors"));
vi.mock("@/lib/stick-motion", () => import("../lib/stick-motion"));
vi.mock("@/lib/betaflight-device-name", () => import("../lib/betaflight-device-name"));
vi.mock("@/hooks/use-raw-serial-capture", () => import("./use-raw-serial-capture"));

let controller: TelemetryController;
let renderer: ReactTestRenderer | null = null;
let received: ReadableStreamDefaultController<Uint8Array>;
let nowMs = 0;
let requestPort: ReturnType<typeof vi.fn>;
let write: ReturnType<typeof vi.fn<(chunk: Uint8Array) => Promise<void>>>;

function Harness() {
  const nextController = useBetaflightTelemetry();
  useEffect(() => { controller = nextController; }, [nextController]);
  return null;
}

function frame(command: number, payload: number[], error = false) {
  let checksum = payload.length ^ command;
  for (const byte of payload) checksum ^= byte;
  return [36, 77, error ? 33 : 62, payload.length, command, ...payload, checksum];
}

function rcFrame(throttle = 1400) {
  const payload = [1500, 1500, 1500, throttle].flatMap((value) => [value & 255, value >> 8]);
  return frame(MSP.RC, payload);
}

async function receive(bytes: number[]) {
  await act(async () => { received.enqueue(Uint8Array.from(bytes)); });
}

async function advance(ms = 10) {
  nowMs += ms;
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

function createPort() {
  return Object.assign(new EventTarget(), {
    connected: true,
    readable: new ReadableStream<Uint8Array>({ start(stream) { received = stream; } }),
    writable: new WritableStream<Uint8Array>({ write }),
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getInfo: () => ({}),
  });
}

function commandsWritten() {
  return write.mock.calls.map(([bytes]) => bytes[1] === 88 ? bytes[4] | bytes[5] << 8 : bytes[4]);
}

beforeEach(() => {
  vi.useFakeTimers();
  nowMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { isSecureContext: true });
  write = vi.fn<(chunk: Uint8Array) => Promise<void>>().mockResolvedValue(undefined);
  const port = createPort();
  requestPort = vi.fn().mockResolvedValue(port);
  vi.stubGlobal("navigator", { serial: Object.assign(new EventTarget(), { requestPort, getPorts: async () => [] }) });
  act(() => { renderer = create(<Harness />); });
});

afterEach(async () => {
  if (renderer) await act(async () => { renderer?.unmount(); });
  renderer = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Betaflight telemetry fidelity", () => {
  it("keeps the picker in the user gesture and clears demo analog values on the first real RC frame", async () => {
    await act(async () => { vi.advanceTimersByTime(50); });
    expect(controller.telemetry.groundBridgeVoltage).not.toBeNull();
    expect(controller.rcReceiveHz).toBeNull();

    await act(async () => {
      const connecting = controller.connectSerial();
      expect(requestPort).toHaveBeenCalledTimes(1);
      await connecting;
    });
    await receive(rcFrame());

    expect(controller.source).toBe("serial");
    expect(controller.connection).toBe("live");
    expect(controller.telemetry.groundBridgeVoltage).toBeNull();
    expect(controller.telemetry.groundMspRssiPercent).toBeNull();
    await receive(frame(MSP.ANALOG, [51, 0, 0, 0xff, 0x03]));
    await receive(rcFrame());
    expect(controller.telemetry.groundBridgeVoltage).toBe(5.1);
  });

  it("publishes every batched RC frame while keeping 20 Hz visual history at a 100 Hz input", async () => {
    await act(async () => { await controller.connectSerial(); });
    const samples: FlightTelemetry[] = [];
    const unsubscribe = controller.subscribeSamples((sample, source) => {
      if (source === "serial") samples.push(sample);
    });
    nowMs = 500;
    await receive(Array.from({ length: 100 }, (_, index) => rcFrame(1000 + index)).flat());

    expect(samples).toHaveLength(100);
    expect(new Set(samples.map((sample) => sample.sequence)).size).toBe(100);
    expect(samples[0].rcThrottleUs).toBe(1000);
    expect(samples[99].rcThrottleUs).toBe(1099);
    expect(controller.throttleHistory).toHaveLength(20);
    expect(controller.stickMotion.samples).toHaveLength(20);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(controller.rcReceiveHz).toBe(100);

    nowMs = 1_500;
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(controller.rcReceiveHz).toBe(0);
    expect(controller.connection).toBe("live");
    unsubscribe();
    await receive(rcFrame());
    expect(samples).toHaveLength(100);
    await act(async () => { await controller.useDemo(); });
    expect(controller.rcReceiveHz).toBeNull();
  });

  it("retains the 10 ms RC poll and does not stack requests before a response", async () => {
    await act(async () => { await controller.connectSerial(); });
    nowMs = 10;
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(write.mock.calls.filter(([bytes]) => bytes[4] === MSP.RC)).toHaveLength(1);
    nowMs = 20;
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(write.mock.calls.filter(([bytes]) => bytes[4] === MSP.RC)).toHaveLength(1);
    await receive(rcFrame());
    nowMs = 30;
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(write.mock.calls.filter(([bytes]) => bytes[4] === MSP.RC)).toHaveLength(2);
  });

  it("excludes non-RC and malformed frames from receive rate and retains stale recovery", async () => {
    await act(async () => { await controller.connectSerial(); });
    await receive(frame(MSP.ANALOG, [51, 0, 0, 0xff, 0x03]));
    await receive(frame(MSP.RC, [0, 0]));
    expect(controller.rcReceiveHz).toBeNull();
    expect(controller.connection).toBe("connecting");
    await receive(rcFrame());
    nowMs = 1_600;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(controller.rcReceiveHz).toBe(0);
    expect(controller.connection).toBe("stale");
    await receive(rcFrame());
    expect(controller.connection).toBe("live");
  });

  it("probes names only after real RC and keeps metadata behind the in-flight RC request", async () => {
    await act(async () => { await controller.connectSerial(); });
    await advance();
    expect(commandsWritten()).toEqual([MSP.RC]);
    expect(controller.deviceNames.status).toBe("idle");

    await receive(rcFrame());
    await advance();
    expect(commandsWritten()).toEqual([MSP.RC, MSP.RC, MSP.API_VERSION]);
    expect(controller.deviceNames.status).toBe("reading");
    const sample = controller.telemetry;
    await receive(frame(MSP.API_VERSION, [0, 1, 44]));
    await advance();
    expect(commandsWritten()).toEqual([MSP.RC, MSP.RC, MSP.API_VERSION]);
    expect(controller.telemetry).toBe(sample);

    await receive(rcFrame());
    await advance();
    expect(commandsWritten().slice(-2)).toEqual([MSP.RC, MSP.NAME]);
  });

  it("publishes a legacy craft name without publishing a telemetry sample and clears it on reconnect", async () => {
    await act(async () => { await controller.connectSerial(); });
    await receive(rcFrame());
    await advance();
    await receive([...frame(MSP.API_VERSION, [0, 1, 44]), ...rcFrame()]);
    await advance();
    const samples: FlightTelemetry[] = [];
    const unsubscribe = controller.subscribeSamples((sample) => { samples.push(sample); });
    const latestRc = controller.telemetry;
    await receive(frame(MSP.NAME, Array.from("PILOT-OLD", (character) => character.charCodeAt(0))));
    expect(controller.deviceNames).toEqual({ pilotName: "", craftName: "PILOT-OLD", status: "ready" });
    expect(controller.telemetry).toBe(latestRc);
    expect(samples).toHaveLength(0);
    const names = controller.deviceNames;
    await receive(Array.from({ length: 100 }, () => rcFrame()).flat());
    expect(samples).toHaveLength(100);
    expect(controller.deviceNames).toBe(names);
    unsubscribe();

    const oldReceived = received;
    requestPort.mockResolvedValueOnce(createPort());
    await act(async () => {
      oldReceived.enqueue(Uint8Array.from(frame(MSP.NAME, Array.from("LATE-OLD", (character) => character.charCodeAt(0)))));
      await controller.connectSerial();
    });
    expect(controller.deviceNames).toEqual({ pilotName: "", craftName: "", status: "idle" });
    await receive(rcFrame());
    await advance();
    expect(controller.deviceNames).toEqual({ pilotName: "", craftName: "", status: "reading" });
    await act(async () => { await controller.useDemo(); });
    expect(controller.deviceNames).toEqual({ pilotName: "", craftName: "", status: "idle" });
  });

  it("finishes unanswered optional probes while sustaining 100 Hz RC requests and 20 Hz visual history", async () => {
    await act(async () => { await controller.connectSerial(); });
    await receive(rcFrame());
    for (let index = 0; index < 150; index += 1) {
      await advance();
      await receive(rcFrame());
    }
    expect(commandsWritten().filter((command) => command === MSP.RC)).toHaveLength(150);
    expect(commandsWritten().filter((command) => command === MSP.API_VERSION)).toHaveLength(1);
    expect(commandsWritten().filter((command) => command === MSP.NAME)).toHaveLength(1);
    expect(controller.deviceNames).toEqual({ pilotName: "", craftName: "", status: "unavailable" });
    expect(controller.connection).toBe("live");
    expect(controller.source).toBe("serial");
    expect(controller.error).toBeNull();
    expect(controller.throttleHistory).toHaveLength(30);
    expect(controller.stickMotion.samples).toHaveLength(20);
    expect(controller.stickMotion.samples.at(-1)?.sequence).toBe(150);
  });

  it("treats unsupported optional commands as name unavailability without failing serial capture", async () => {
    await act(async () => { await controller.connectSerial(); });
    await receive(rcFrame());
    await advance();
    await receive([...frame(MSP.API_VERSION, [], true), ...rcFrame()]);
    await advance();
    expect(commandsWritten().slice(-2)).toEqual([MSP.RC, MSP.NAME]);
    await receive(frame(MSP.NAME, [], true));
    expect(controller.deviceNames).toEqual({ pilotName: "", craftName: "", status: "unavailable" });
    expect(controller.connection).toBe("live");
    expect(controller.error).toBeNull();
    await receive(rcFrame(1700));
    expect(controller.telemetry.rcThrottleUs).toBe(1700);
  });
});
