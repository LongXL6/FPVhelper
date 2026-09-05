import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MSP, type FlightTelemetry } from "../lib/telemetry";
import { useBetaflightTelemetry, type TelemetryController } from "./use-betaflight-telemetry";

vi.mock("@/lib/telemetry", () => import("../lib/telemetry"));
vi.mock("@/lib/hardware-errors", () => import("../lib/hardware-errors"));
vi.mock("@/lib/stick-motion", () => import("../lib/stick-motion"));
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

function frame(command: number, payload: number[]) {
  let checksum = payload.length ^ command;
  for (const byte of payload) checksum ^= byte;
  return [36, 77, 62, payload.length, command, ...payload, checksum];
}

function rcFrame(throttle = 1400) {
  const payload = [1500, 1500, 1500, throttle].flatMap((value) => [value & 255, value >> 8]);
  return frame(MSP.RC, payload);
}

async function receive(bytes: number[]) {
  await act(async () => { received.enqueue(Uint8Array.from(bytes)); });
}

beforeEach(() => {
  vi.useFakeTimers();
  nowMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { isSecureContext: true });
  write = vi.fn<(chunk: Uint8Array) => Promise<void>>().mockResolvedValue(undefined);
  const port = Object.assign(new EventTarget(), {
    connected: true,
    readable: new ReadableStream<Uint8Array>({ start(stream) { received = stream; } }),
    writable: new WritableStream<Uint8Array>({ write }),
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getInfo: () => ({}),
  });
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
});
