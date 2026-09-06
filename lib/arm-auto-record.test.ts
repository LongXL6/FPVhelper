import { describe, expect, it, vi } from "vitest";
import {
  ArmAutoRecordController,
  detectArmSwitch,
  isValidArmSwitchConfig,
  type ArmAutoRecordOptions,
  type ArmAutoRecordSnapshot,
} from "./arm-auto-record";

const config = { auxIndex: 0, min: 1700, max: 2100 };
const channels = (aux: number) => [1500, 1500, 1000, 1500, aux];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setup(overrides: Partial<ArmAutoRecordOptions> = {}) {
  const start = vi.fn<ArmAutoRecordOptions["start"]>().mockResolvedValue(true);
  const stop = vi.fn<ArmAutoRecordOptions["stop"]>().mockResolvedValue(undefined);
  const onState = vi.fn<(snapshot: ArmAutoRecordSnapshot) => void>();
  const controller = new ArmAutoRecordController({ start, stop, onState, ...overrides });
  controller.enable(config);
  const observe = (aux: number, timestampMs: number, nowMs = timestampMs) => {
    controller.observe({ channels: channels(aux), timestampMs }, nowMs);
  };
  const ready = () => {
    observe(1000, 0);
    observe(1000, 120);
  };
  const arm = () => {
    ready();
    observe(1800, 130);
    observe(1800, 250);
  };
  return { controller, start, stop, onState, observe, ready, arm };
}

async function flush() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function feedDisarm(observe: (aux: number, timestampMs: number) => void, from: number, through: number) {
  for (let timestampMs = from; timestampMs < through; timestampMs += 500) observe(1000, timestampMs);
  observe(1000, through);
}

describe("ARM AUX detection", () => {
  it("uses the explicit AUX index and Betaflight's half-open range", () => {
    expect(detectArmSwitch(config, channels(1699))).toBe(false);
    expect(detectArmSwitch(config, channels(1700))).toBe(true);
    expect(detectArmSwitch(config, channels(2099))).toBe(true);
    expect(detectArmSwitch(config, channels(2100))).toBe(false);
    expect(detectArmSwitch({ ...config, auxIndex: 1 }, [...channels(1000), 1800])).toBe(true);
  });

  it.each([
    { ...config, auxIndex: -1 },
    { ...config, auxIndex: 14 },
    { ...config, auxIndex: 0.5 },
    { ...config, min: 749 },
    { ...config, min: Number.NaN },
    { ...config, max: 2251 },
    { ...config, min: 2100 },
  ])("rejects invalid config %o", (invalid) => {
    expect(isValidArmSwitchConfig(invalid)).toBe(false);
    expect(detectArmSwitch(invalid, channels(1800))).toBeNull();
  });

  it("treats missing or invalid RC samples as unknown", () => {
    expect(detectArmSwitch(config, [])).toBeNull();
    for (const value of [Number.NaN, Infinity, 0, 749, 2251]) {
      expect(detectArmSwitch(config, channels(value))).toBeNull();
    }
  });
});

describe("ARM auto recording lifecycle", () => {
  it("requires a fresh, debounced DISARM before allowing the first ARM", async () => {
    const { controller, observe, start } = setup();
    observe(1800, 0);
    observe(1800, 120);
    expect(controller.getSnapshot().phase).toBe("waiting_disarm");
    expect(start).not.toHaveBeenCalled();
    observe(1000, 130);
    expect(controller.getSnapshot().phase).toBe("waiting_disarm");
    observe(1000, 249);
    expect(controller.getSnapshot().phase).toBe("waiting_disarm");
    observe(1000, 250);
    expect(controller.getSnapshot().phase).toBe("ready");
    observe(1800, 260);
    observe(1800, 380);
    await flush();
    expect(start).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().phase).toBe("recording");
  });

  it("ignores repeated and out-of-order timestamps and resets debounce on bounce", async () => {
    const { controller, ready, observe, start } = setup();
    ready();
    observe(1800, 130);
    observe(1800, 130, 400);
    observe(1000, 129, 401);
    expect(controller.getSnapshot().phase).toBe("ready");
    observe(1000, 200);
    observe(1800, 210);
    observe(1800, 329);
    expect(start).not.toHaveBeenCalled();
    observe(1800, 330);
    await flush();
    expect(start).toHaveBeenCalledOnce();
  });

  it("keeps brief DISARM and repeated ARM cycles in one capture", async () => {
    const { controller, arm, observe, start, stop } = setup();
    arm();
    await flush();
    observe(1800, 260);
    observe(1800, 380);
    observe(1000, 390);
    observe(1800, 400);
    observe(1000, 410);
    observe(1000, 529);
    expect(stop).not.toHaveBeenCalled();
    observe(1000, 530);
    await flush();
    expect(start).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe("recording");
    observe(1000, 540);
    observe(1000, 660);
    observe(1800, 670);
    observe(1800, 790);
    await flush();
    expect(start).toHaveBeenCalledOnce();
    await controller.disable();
    expect(stop).toHaveBeenCalledExactlyOnceWith("disabled");
    expect(controller.getSnapshot().phase).toBe("disabled");
    observe(1000, 800);
    observe(1000, 920);
    observe(1800, 930);
    observe(1800, 1050);
    await flush();
    expect(start).toHaveBeenCalledOnce();
  });

  it.each(["false", "throw"])("locks a failed startup (%s) until another DISARM", async (failure) => {
    const start = vi.fn<ArmAutoRecordOptions["start"]>();
    if (failure === "false") start.mockResolvedValueOnce(false);
    else start.mockRejectedValueOnce(new Error("Capture unavailable"));
    start.mockResolvedValue(true);
    const { controller, arm, observe } = setup({ start });
    arm();
    await flush();
    expect(controller.getSnapshot()).toEqual({ phase: "error", enabled: true, error: "start_failed", disarmRemainingMs: null });
    observe(1800, 260);
    observe(1800, 500);
    await flush();
    expect(start).toHaveBeenCalledOnce();
    observe(1000, 510);
    observe(1000, 630);
    observe(1800, 640);
    observe(1800, 760);
    await flush();
    expect(start).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().phase).toBe("recording");
  });

  it.each(["disarm", "disconnect", "timeout", "invalid_aux", "missing_aux"] as const)(
    "continues pending startup through %s without aborting or stopping",
    async (event) => {
      const pending = deferred<boolean>();
      const start = vi.fn<ArmAutoRecordOptions["start"]>().mockReturnValue(pending.promise);
      const { controller, arm, observe, stop } = setup({ start });
      arm();
      await flush();
      const signal = start.mock.calls[0][0];
      if (event === "disarm") {
        observe(1000, 260);
        observe(1000, 380);
      }
      if (event === "disconnect") controller.tick(300, false);
      if (event === "timeout") controller.tick(1250, true);
      if (event === "invalid_aux") observe(Number.NaN, 300);
      if (event === "missing_aux") controller.observe({ channels: [], timestampMs: 300 }, 300);
      expect(signal.aborted).toBe(false);
      expect(controller.getSnapshot().phase).toBe("starting");
      expect(stop).not.toHaveBeenCalled();
      expect(controller.enable(config)).toBe(false);
      pending.resolve(true);
      await flush();
      expect(stop).not.toHaveBeenCalled();
      expect(controller.getSnapshot().phase).toBe("recording");
      await controller.disable();
      expect(stop).toHaveBeenCalledExactlyOnceWith("disabled");
    },
  );

  it("aborts startup on manual stop and waits for startup cleanup before stop", async () => {
    const pending = deferred<boolean>();
    const start = vi.fn<ArmAutoRecordOptions["start"]>().mockReturnValue(pending.promise);
    const { controller, arm, stop } = setup({ start });
    arm();
    await flush();
    const disabled = controller.disable();
    expect(start.mock.calls[0][0].aborted).toBe(true);
    expect(controller.getSnapshot().phase).toBe("stopping");
    expect(stop).not.toHaveBeenCalled();
    expect(controller.enable(config)).toBe(false);
    pending.resolve(true);
    await disabled;
    expect(stop).toHaveBeenCalledExactlyOnceWith("disabled");
    expect(controller.getSnapshot().phase).toBe("disabled");
  });

  it("still calls stop when cancelled startup rejects", async () => {
    const pending = deferred<boolean>();
    const { controller, arm, stop } = setup({ start: () => pending.promise });
    arm();
    await flush();
    const disabled = controller.disable();
    pending.reject(new Error("Aborted"));
    await expect(disabled).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledExactlyOnceWith("disabled");
  });

  it.each(["disconnect", "timeout", "invalid_aux", "missing_aux"])(
    "continues recording through %s and signal recovery",
    async (loss) => {
      const { controller, arm, observe, start, stop } = setup();
      arm();
      await flush();
      if (loss === "disconnect") controller.tick(300, false);
      if (loss === "timeout") controller.tick(1250, true);
      if (loss === "invalid_aux") observe(Number.NaN, 300);
      if (loss === "missing_aux") controller.observe({ channels: [], timestampMs: 300 }, 300);
      await flush();
      expect(stop).not.toHaveBeenCalled();
      observe(1800, 1400);
      observe(1800, 1520);
      await flush();
      expect(start).toHaveBeenCalledOnce();
      expect(controller.getSnapshot().phase).toBe("recording");
      observe(1000, 1530);
      observe(1000, 1650);
      observe(1800, 1660);
      observe(1800, 1780);
      await flush();
      expect(start).toHaveBeenCalledOnce();
      expect(controller.getSnapshot().phase).toBe("recording");
      expect(stop).not.toHaveBeenCalled();
    },
  );

  it("does not bridge a missing-data gap to satisfy ARM debounce", async () => {
    const { controller, ready, observe, start } = setup();
    ready();
    observe(1800, 130);
    observe(1800, 1500);
    observe(1800, 1620);
    await flush();
    expect(start).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe("waiting_disarm");
  });

  it("does not let repeated frames keep ARM detection ready before recording", async () => {
    const { controller, ready, observe, start } = setup();
    ready();
    observe(1000, 120, 1100);
    controller.tick(1120, true);
    await flush();
    expect(start).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe("waiting_disarm");
  });

  it("rejects stale or future samples without arming", async () => {
    const { controller, ready, observe, start } = setup();
    ready();
    observe(1800, 130, 1500);
    observe(1800, 1800, 1600);
    await flush();
    expect(start).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe("waiting_disarm");
  });

  it("keeps stop failure visible and prevents automatic restart", async () => {
    const pendingStop = deferred<void>();
    const stop = vi.fn<ArmAutoRecordOptions["stop"]>().mockReturnValue(pendingStop.promise);
    const { controller, arm, observe, start } = setup({ stop });
    arm();
    await flush();
    const disabled = controller.disable();
    expect(controller.enable(config)).toBe(false);
    await flush();
    pendingStop.reject(new Error("Save failed"));
    await expect(disabled).resolves.toBeUndefined();
    expect(controller.getSnapshot()).toEqual({ phase: "error", enabled: false, error: "stop_failed", disarmRemainingMs: null });
    observe(1000, 260);
    observe(1000, 380);
    observe(1800, 390);
    observe(1800, 510);
    await controller.disable();
    expect(controller.getSnapshot().error).toBe("stop_failed");
    expect(start).toHaveBeenCalledOnce();
    expect(controller.enable(config)).toBe(true);
    expect(controller.getSnapshot().phase).toBe("waiting_disarm");
  });

  it("notifies disabled state during manual stop and shares repeated cleanup requests", async () => {
    const pendingStop = deferred<void>();
    const stop = vi.fn<ArmAutoRecordOptions["stop"]>().mockReturnValue(pendingStop.promise);
    const { controller, arm, onState } = setup({ stop });
    arm();
    await flush();
    const first = controller.disable();
    const second = controller.disable();
    expect(first).toBe(second);
    expect(onState).toHaveBeenLastCalledWith({ phase: "stopping", enabled: false, error: null, disarmRemainingMs: null });
    pendingStop.resolve();
    await first;
    expect(controller.getSnapshot().phase).toBe("disabled");
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each(["disconnect", "timeout", "invalid_aux", "missing_aux"])(
    "requires DISARM again after %s before the first recording",
    async (loss) => {
      const { controller, ready, observe, start, stop } = setup();
      ready();
      if (loss === "disconnect") controller.tick(130, false);
      if (loss === "timeout") controller.tick(1120, true);
      if (loss === "invalid_aux") observe(Number.NaN, 130);
      if (loss === "missing_aux") controller.observe({ channels: [], timestampMs: 130 }, 130);
      observe(1800, 1200);
      observe(1800, 1320);
      await flush();
      expect(controller.getSnapshot().phase).toBe("waiting_disarm");
      expect(start).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      observe(1000, 1330);
      observe(1000, 1450);
      observe(1800, 1460);
      observe(1800, 1580);
      await flush();
      expect(start).toHaveBeenCalledOnce();
    },
  );

  it("rejects invalid enable settings without running capture callbacks", () => {
    const start = vi.fn<ArmAutoRecordOptions["start"]>();
    const controller = new ArmAutoRecordController({ start, stop: async () => {} });
    expect(controller.enable({ ...config, auxIndex: -1 })).toBe(false);
    expect(controller.getSnapshot()).toEqual({ phase: "error", enabled: false, error: "invalid_arm_config", disarmRemainingMs: null });
    expect(start).not.toHaveBeenCalled();
  });
});

describe("continuous DISARM finish delay", () => {
  it("finishes after 15 seconds of fresh DISARM samples and can arm the next session", async () => {
    const { controller, arm, observe, start, stop } = setup();
    arm();
    await flush();
    observe(1000, 260);
    expect(controller.getSnapshot().disarmRemainingMs).toBeNull();
    observe(1000, 380);
    expect(controller.getSnapshot().disarmRemainingMs).toBe(15000);
    feedDisarm(observe, 760, 15259);
    expect(stop).not.toHaveBeenCalled();
    observe(1000, 15260);
    expect(controller.getSnapshot().phase).toBe("stopping");
    await flush();
    expect(stop).toHaveBeenCalledExactlyOnceWith("disarm");
    expect(controller.getSnapshot()).toEqual({ phase: "waiting_disarm", enabled: true, error: null, disarmRemainingMs: null });
    observe(1000, 15270);
    observe(1000, 15390);
    observe(1800, 15400);
    observe(1800, 15520);
    await flush();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("cancels the countdown on ARM and requires a whole new DISARM interval", async () => {
    const { controller, arm, observe, start, stop } = setup();
    arm();
    await flush();
    feedDisarm(observe, 260, 14800);
    expect(controller.getSnapshot().disarmRemainingMs).toBe(1000);
    observe(1800, 14900);
    expect(controller.getSnapshot().disarmRemainingMs).toBeNull();
    observe(1800, 15020);
    feedDisarm(observe, 15100, 30099);
    await flush();
    expect(stop).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
    observe(1000, 30100);
    await flush();
    expect(stop).toHaveBeenCalledExactlyOnceWith("disarm");
  });

  it.each(["disconnect", "timeout", "invalid_aux", "missing_aux"])(
    "cancels the countdown on %s without ending the recording",
    async (loss) => {
      const { controller, arm, observe, start, stop } = setup({ disarmDelayMs: 1200 });
      arm();
      await flush();
      observe(1000, 260);
      observe(1000, 380);
      expect(controller.getSnapshot().disarmRemainingMs).not.toBeNull();
      if (loss === "disconnect") controller.tick(400, false);
      if (loss === "timeout") controller.tick(1460, true);
      if (loss === "invalid_aux") observe(Number.NaN, 400);
      if (loss === "missing_aux") controller.observe({ channels: [], timestampMs: 400 }, 400);
      expect(controller.getSnapshot().disarmRemainingMs).toBeNull();
      expect(controller.getSnapshot().phase).toBe("recording");
      controller.tick(2000, true);
      await flush();
      expect(stop).not.toHaveBeenCalled();
      feedDisarm(observe, 2010, 3209);
      expect(stop).not.toHaveBeenCalled();
      observe(1000, 3210);
      await flush();
      expect(stop).toHaveBeenCalledExactlyOnceWith("disarm");
      expect(start).toHaveBeenCalledOnce();
    },
  );

  it("checks stale data before a deadline and repeated frames cannot extend freshness", async () => {
    const { controller, arm, observe, stop } = setup({ disarmDelayMs: 1200 });
    arm();
    await flush();
    observe(1000, 260);
    observe(1000, 380);
    observe(1000, 380, 1400);
    controller.tick(1460, true);
    await flush();
    expect(stop).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe("recording");
    expect(controller.getSnapshot().disarmRemainingMs).toBeNull();
  });

  it("allows the timer tick to finish while fresh DISARM samples remain valid", async () => {
    const { controller, arm, observe, stop } = setup({ disarmDelayMs: 1200 });
    arm();
    await flush();
    feedDisarm(observe, 260, 1360);
    controller.tick(1460, true);
    await flush();
    expect(stop).toHaveBeenCalledExactlyOnceWith("disarm");
  });

  it("aborts pending startup only after the full DISARM delay and waits for cleanup", async () => {
    const pending = deferred<boolean>();
    const start = vi.fn<ArmAutoRecordOptions["start"]>().mockReturnValue(pending.promise);
    const { controller, arm, observe, stop } = setup({ start });
    arm();
    await flush();
    feedDisarm(observe, 260, 15259);
    expect(start.mock.calls[0][0].aborted).toBe(false);
    observe(1000, 15260);
    expect(start.mock.calls[0][0].aborted).toBe(true);
    expect(controller.getSnapshot().phase).toBe("stopping");
    expect(stop).not.toHaveBeenCalled();
    pending.resolve(true);
    await flush();
    expect(stop).toHaveBeenCalledExactlyOnceWith("disarm");
  });

  it("keeps automatic save failure locked until a deliberate reset", async () => {
    const stop = vi.fn<ArmAutoRecordOptions["stop"]>().mockRejectedValue(new Error("Save failed"));
    const { controller, arm, observe, start } = setup({ stop, disarmDelayMs: 500 });
    arm();
    await flush();
    feedDisarm(observe, 260, 760);
    await flush();
    expect(controller.getSnapshot()).toEqual({ phase: "error", enabled: true, error: "stop_failed", disarmRemainingMs: null });
    observe(1000, 800);
    observe(1000, 920);
    observe(1800, 930);
    observe(1800, 1050);
    controller.tick(2000, false);
    await flush();
    expect(controller.getSnapshot().error).toBe("stop_failed");
    expect(start).toHaveBeenCalledOnce();
  });

  it("updates the visible countdown by seconds without notifying every raw frame", async () => {
    const { controller, arm, observe, onState } = setup();
    arm();
    await flush();
    onState.mockClear();
    for (let timestampMs = 260; timestampMs <= 5260; timestampMs += 10) observe(1000, timestampMs);
    expect(controller.getSnapshot().disarmRemainingMs).toBe(10000);
    expect(onState).toHaveBeenCalledTimes(6);
  });
});
