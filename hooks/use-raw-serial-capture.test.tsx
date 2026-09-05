import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RAW_SERIAL_CAPTURE_DURATION_MS,
  RAW_SERIAL_CAPTURE_MAX_BYTES,
} from "../lib/local-diagnostics";
import { useRawSerialCapture } from "./use-raw-serial-capture";

type CaptureController = ReturnType<typeof useRawSerialCapture>;

let controller: CaptureController;
let renderer: ReactTestRenderer | null = null;

function Harness() {
  const nextController = useRawSerialCapture();
  useEffect(() => {
    controller = nextController;
  }, [nextController]);
  return null;
}

function renderHarness() {
  act(() => {
    renderer = create(<Harness />);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockReturnValue(0);
  renderHarness();
});

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useRawSerialCapture", () => {
  it("enforces the 60 second deadline inside ingest when background timers are delayed", () => {
    expect(controller.start()).toBe(true);
    vi.mocked(performance.now).mockReturnValue(RAW_SERIAL_CAPTURE_DURATION_MS + 1);

    act(() => controller.ingest(Uint8Array.of(1, 2, 3)));

    expect(controller.capture).toMatchObject({
      state: "ready",
      byteLength: 0,
      stopReason: "completed",
    });
  });

  it("cancels an active capture and ignores its old timer", () => {
    expect(controller.start()).toBe(true);
    act(() => controller.ingest(Uint8Array.of(1, 2, 3)));
    act(() => controller.cancel());
    vi.advanceTimersByTime(RAW_SERIAL_CAPTURE_DURATION_MS);

    expect(controller.capture).toMatchObject({ state: "idle", byteLength: 0, stopReason: null });
  });

  it("keeps bytes captured before a serial disconnect ready for download", () => {
    expect(controller.start()).toBe(true);
    act(() => controller.ingest(Uint8Array.of(1, 2, 3)));
    act(() => {
      controller.finish("disconnected");
    });

    expect(controller.capture).toMatchObject({
      state: "ready",
      byteLength: 3,
      stopReason: "disconnected",
    });
  });

  it("stops at the local size limit without waiting for the timer", () => {
    expect(controller.start()).toBe(true);
    act(() => controller.ingest(new Uint8Array(RAW_SERIAL_CAPTURE_MAX_BYTES + 1)));

    expect(controller.capture).toMatchObject({
      state: "ready",
      byteLength: RAW_SERIAL_CAPTURE_MAX_BYTES,
      stopReason: "size_limit",
    });
  });

  it("fails closed instead of overwriting capturing or ready data", () => {
    expect(controller.start()).toBe(true);
    expect(controller.start()).toBe(false);
    act(() => controller.ingest(Uint8Array.of(1, 2, 3)));
    act(() => {
      controller.finish("completed");
    });
    const readyCapture = controller.capture;

    expect(controller.start()).toBe(false);
    expect(controller.capture).toEqual(readyCapture);
  });

  it("clears timers and buffered state on unmount", () => {
    expect(controller.start()).toBe(true);
    act(() => controller.ingest(Uint8Array.of(1, 2, 3)));
    expect(vi.getTimerCount()).toBe(1);

    act(() => renderer?.unmount());
    renderer = null;

    expect(vi.getTimerCount()).toBe(0);
    expect(controller.start()).toBe(false);
    expect(controller.download()).toBe(false);
  });
});
