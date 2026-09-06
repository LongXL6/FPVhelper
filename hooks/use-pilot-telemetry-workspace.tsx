"use client";

import { memo, useCallback, useEffect, useSyncExternalStore } from "react";
import { withMeasurementProfiler } from "@/components/measurement-profiler";
import {
  measurementEnabled, measurementEvent, measurementIdentity, measurementRegisterSubscription,
  measurementRemoveSubscription, measurementSampleFields, measurementSubscriptionFields,
} from "../lib/capture-measurement";
import { useBetaflightTelemetry, type TelemetryController } from "./use-betaflight-telemetry";
import type { RawSerialCaptureState } from "./use-raw-serial-capture";
import { EMPTY_STICK_MOTION } from "../lib/stick-motion";
import { EMPTY_MSP_PARSER_STATS, EMPTY_TELEMETRY } from "../lib/telemetry";
import { EMPTY_BETAFLIGHT_DEVICE_NAMES, type BetaflightDeviceNames } from "../lib/betaflight-device-name";

const IDLE_RAW_CAPTURE: RawSerialCaptureState = {
  state: "idle",
  startedAt: null,
  remainingMs: 0,
  byteLength: 0,
  stopReason: null,
};

const connectUnavailable = async () => undefined;
const noAction = () => undefined;
const returnFalse = () => false;

const UNAVAILABLE_TELEMETRY_CONTROLLER: TelemetryController = {
  deviceNames: EMPTY_BETAFLIGHT_DEVICE_NAMES,
  telemetry: EMPTY_TELEMETRY,
  throttleHistory: [],
  stickMotion: EMPTY_STICK_MOTION,
  connection: "demo",
  source: "demo",
  error: null,
  errorCode: null,
  parserStats: EMPTY_MSP_PARSER_STATS,
  parserQuality: "unknown",
  rcReceiveHz: null,
  linkState: "unknown",
  rawCapture: IDLE_RAW_CAPTURE,
  serialSupported: false,
  connectSerial: connectUnavailable,
  useDemo: connectUnavailable,
  startRawCapture: returnFalse,
  cancelRawCapture: noAction,
  downloadRawCapture: returnFalse,
  subscribeSamples: () => noAction,
};

export type PilotTelemetryNamesSnapshot = Readonly<Record<string, BetaflightDeviceNames>>;
const EMPTY_PILOT_TELEMETRY_NAMES: PilotTelemetryNamesSnapshot = Object.freeze({});

export interface PilotTelemetryWorkspaceStore {
  getSnapshot: (pilotChannelId: string | undefined) => TelemetryController;
  getNamesSnapshot: () => PilotTelemetryNamesSnapshot;
  subscribeNames: (listener: () => void) => () => void;
  publish: (pilotChannelId: string, controller: TelemetryController) => void;
  remove: (pilotChannelId: string) => void;
  subscribe: (pilotChannelId: string | undefined, listener: () => void) => () => void;
}

export function createPilotTelemetryWorkspaceStore(): PilotTelemetryWorkspaceStore {
  const controllers = new Map<string, TelemetryController>();
  const listeners = new Map<string, Set<() => void>>();
  const namesListeners = new Set<() => void>();
  let namesSnapshot = EMPTY_PILOT_TELEMETRY_NAMES;

  const notify = (pilotChannelId: string) => {
    const channelListeners = listeners.get(pilotChannelId);
    if (measurementEnabled()) measurementEvent("store.notify", {
      storeId: measurementIdentity(controllers, "store"), pilotChannelId, listenerCount: channelListeners?.size ?? 0,
    });
    channelListeners?.forEach((listener) => {
      if (!measurementEnabled()) { listener(); return; }
      const fields = { storeId: measurementIdentity(controllers, "store"), pilotChannelId,
        ...measurementSubscriptionFields(channelListeners, listener) };
      measurementEvent("store.listener.attempted", fields);
      try { listener(); }
      catch (error) { measurementEvent("store.listener.threw", fields); throw error; }
      measurementEvent("store.listener.returned", fields);
    });
  };

  const updateNames = (pilotChannelId: string, names: BetaflightDeviceNames) => {
    const previous = namesSnapshot[pilotChannelId] ?? EMPTY_BETAFLIGHT_DEVICE_NAMES;
    if (previous.pilotName === names.pilotName && previous.craftName === names.craftName && previous.status === names.status) return;
    const next = { ...namesSnapshot };
    if (names.status === "idle" && !names.pilotName && !names.craftName) delete next[pilotChannelId];
    else next[pilotChannelId] = { ...names };
    namesSnapshot = Object.keys(next).length ? next : EMPTY_PILOT_TELEMETRY_NAMES;
    if (measurementEnabled()) measurementEvent("store.names.updated", {
      storeId: measurementIdentity(controllers, "store"), pilotChannelId, listenerCount: namesListeners.size,
    });
    namesListeners.forEach((listener) => {
      if (!measurementEnabled()) { listener(); return; }
      const fields = { storeId: measurementIdentity(controllers, "store"),
        ...measurementSubscriptionFields(namesListeners, listener) };
      measurementEvent("store.names.listener.attempted", fields);
      try { listener(); }
      catch (error) { measurementEvent("store.names.listener.threw", fields); throw error; }
      measurementEvent("store.names.listener.returned", fields);
    });
  };

  return {
    getNamesSnapshot: () => {
      if (measurementEnabled()) measurementEvent("store.names.read", {
        storeId: measurementIdentity(controllers, "store"), snapshotId: measurementIdentity(namesSnapshot, "snapshot"),
      });
      return namesSnapshot;
    },
    subscribeNames(listener) {
      const registration = measurementEnabled() ? measurementRegisterSubscription(namesListeners, listener) : null;
      namesListeners.add(listener);
      if (measurementEnabled()) measurementEvent("store.names.subscription.add", { ...registration, storeId: measurementIdentity(controllers, "store") });
      return () => {
        namesListeners.delete(listener);
        if (measurementEnabled()) measurementEvent("store.names.subscription.remove", {
          ...measurementRemoveSubscription(namesListeners, listener, registration?.registrationId ?? null),
          storeId: measurementIdentity(controllers, "store"),
        });
      };
    },
    getSnapshot(pilotChannelId) {
      const controller = pilotChannelId ? controllers.get(pilotChannelId) ?? UNAVAILABLE_TELEMETRY_CONTROLLER : UNAVAILABLE_TELEMETRY_CONTROLLER;
      if (measurementEnabled()) measurementEvent("store.read", {
        storeId: measurementIdentity(controllers, "store"), pilotChannelId: pilotChannelId ?? null,
        snapshotId: measurementIdentity(controller, "snapshot"), ...measurementSampleFields(controller.telemetry),
      });
      return controller;
    },
    publish(pilotChannelId, controller) {
      if (measurementEnabled()) measurementEvent("store.publish.attempted", {
        storeId: measurementIdentity(controllers, "store"), pilotChannelId,
        snapshotId: measurementIdentity(controller, "snapshot"), ...measurementSampleFields(controller.telemetry),
      });
      if (controllers.get(pilotChannelId) === controller) {
        if (measurementEnabled()) measurementEvent("store.publish.skipped", {
          storeId: measurementIdentity(controllers, "store"), pilotChannelId, reason: "identical_snapshot",
        });
        return;
      }
      controllers.set(pilotChannelId, controller);
      if (measurementEnabled()) measurementEvent("store.updated", {
        storeId: measurementIdentity(controllers, "store"), pilotChannelId,
        snapshotId: measurementIdentity(controller, "snapshot"), ...measurementSampleFields(controller.telemetry),
      });
      updateNames(pilotChannelId, controller.deviceNames);
      notify(pilotChannelId);
    },
    remove(pilotChannelId) {
      if (!controllers.delete(pilotChannelId)) return;
      if (measurementEnabled()) measurementEvent("store.removed", { storeId: measurementIdentity(controllers, "store"), pilotChannelId });
      updateNames(pilotChannelId, EMPTY_BETAFLIGHT_DEVICE_NAMES);
      notify(pilotChannelId);
    },
    subscribe(pilotChannelId, listener) {
      if (!pilotChannelId) return noAction;
      let channelListeners = listeners.get(pilotChannelId);
      if (!channelListeners) {
        channelListeners = new Set();
        listeners.set(pilotChannelId, channelListeners);
      }
      const registration = measurementEnabled() ? measurementRegisterSubscription(channelListeners, listener) : null;
      channelListeners.add(listener);
      if (measurementEnabled()) measurementEvent("store.subscription.add", {
        ...registration, storeId: measurementIdentity(controllers, "store"), pilotChannelId,
      });
      return () => {
        channelListeners?.delete(listener);
        if (measurementEnabled() && channelListeners) measurementEvent("store.subscription.remove", {
          ...measurementRemoveSubscription(channelListeners, listener, registration?.registrationId ?? null),
          storeId: measurementIdentity(controllers, "store"), pilotChannelId,
        });
        if (channelListeners?.size === 0) listeners.delete(pilotChannelId);
      };
    },
  };
}

export function usePilotTelemetryNames(store: PilotTelemetryWorkspaceStore) {
  return useSyncExternalStore(store.subscribeNames, store.getNamesSnapshot, () => EMPTY_PILOT_TELEMETRY_NAMES);
}

const PilotTelemetryBridge = memo(function PilotTelemetryBridge({
  pilotChannelId,
  demoPlaybackActive,
  store,
}: {
  pilotChannelId: string;
  demoPlaybackActive: boolean;
  store: PilotTelemetryWorkspaceStore;
}) {
  const controller = useBetaflightTelemetry({ demoPlaybackActive, measurementChannelId: pilotChannelId });

  useEffect(() => {
    store.publish(pilotChannelId, controller);
  }, [controller, pilotChannelId, store]);

  useEffect(() => () => store.remove(pilotChannelId), [pilotChannelId, store]);
  return null;
});

export function PilotTelemetryWorkspaceHost({
  pilotChannelIds,
  activePilotChannelId,
  store,
}: {
  pilotChannelIds: readonly string[];
  activePilotChannelId: string | undefined;
  store: PilotTelemetryWorkspaceStore;
}) {
  return pilotChannelIds.map((pilotChannelId) => withMeasurementProfiler(`pilot-bridge:${pilotChannelId}`, (
    <PilotTelemetryBridge
      key={pilotChannelId}
      pilotChannelId={pilotChannelId}
      demoPlaybackActive={pilotChannelId === activePilotChannelId}
      store={store}
    />
  )));
}

export function usePilotTelemetryController(
  store: PilotTelemetryWorkspaceStore,
  pilotChannelId: string | undefined,
) {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(pilotChannelId, listener),
    [pilotChannelId, store],
  );
  const getSnapshot = useCallback(
    () => store.getSnapshot(pilotChannelId),
    [pilotChannelId, store],
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => UNAVAILABLE_TELEMETRY_CONTROLLER);
}
