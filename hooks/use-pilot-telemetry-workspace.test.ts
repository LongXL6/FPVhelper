import { describe, expect, it, vi } from "vitest";
import type { TelemetryController } from "./use-betaflight-telemetry";
import { createPilotTelemetryWorkspaceStore } from "./use-pilot-telemetry-workspace";

vi.mock("./use-betaflight-telemetry", () => ({
  useBetaflightTelemetry: vi.fn(),
}));

function controller(id: string) {
  return { id } as unknown as TelemetryController;
}

describe("pilot telemetry workspace store", () => {
  it("keeps each pilot controller and subscriber isolated", () => {
    const store = createPilotTelemetryWorkspaceStore();
    const pilotOne = controller("pilot-one");
    const pilotTwo = controller("pilot-two");
    const pilotOneListener = vi.fn();
    const pilotTwoListener = vi.fn();
    const unsubscribePilotOne = store.subscribe("pilot-one", pilotOneListener);
    store.subscribe("pilot-two", pilotTwoListener);

    store.publish("pilot-one", pilotOne);
    store.publish("pilot-two", pilotTwo);

    expect(store.getSnapshot("pilot-one")).toBe(pilotOne);
    expect(store.getSnapshot("pilot-two")).toBe(pilotTwo);
    expect(pilotOneListener).toHaveBeenCalledTimes(1);
    expect(pilotTwoListener).toHaveBeenCalledTimes(1);

    store.remove("pilot-one");
    expect(store.getSnapshot("pilot-one")).not.toBe(pilotOne);
    expect(store.getSnapshot("pilot-two")).toBe(pilotTwo);
    expect(pilotOneListener).toHaveBeenCalledTimes(2);
    expect(pilotTwoListener).toHaveBeenCalledTimes(1);

    unsubscribePilotOne();
    store.publish("pilot-one", controller("pilot-one-reconnected"));
    expect(pilotOneListener).toHaveBeenCalledTimes(2);
  });

  it("does not notify when a bridge republishes the same controller object", () => {
    const store = createPilotTelemetryWorkspaceStore();
    const listener = vi.fn();
    const stableController = controller("stable");
    store.subscribe("pilot-one", listener);

    store.publish("pilot-one", stableController);
    store.publish("pilot-one", stableController);

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
