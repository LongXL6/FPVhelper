"use client";

import { memo, useCallback, useEffect, useSyncExternalStore } from "react";
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
    listeners.get(pilotChannelId)?.forEach((listener) => listener());
  };

  const updateNames = (pilotChannelId: string, names: BetaflightDeviceNames) => {
    const previous = namesSnapshot[pilotChannelId] ?? EMPTY_BETAFLIGHT_DEVICE_NAMES;
    if (previous.pilotName === names.pilotName && previous.craftName === names.craftName && previous.status === names.status) return;
    const next = { ...namesSnapshot };
    if (names.status === "idle" && !names.pilotName && !names.craftName) delete next[pilotChannelId];
    else next[pilotChannelId] = { ...names };
    namesSnapshot = Object.keys(next).length ? next : EMPTY_PILOT_TELEMETRY_NAMES;
    namesListeners.forEach((listener) => listener());
  };

  return {
    getNamesSnapshot: () => namesSnapshot,
    subscribeNames(listener) {
      namesListeners.add(listener);
      return () => { namesListeners.delete(listener); };
    },
    getSnapshot(pilotChannelId) {
      return pilotChannelId ? controllers.get(pilotChannelId) ?? UNAVAILABLE_TELEMETRY_CONTROLLER : UNAVAILABLE_TELEMETRY_CONTROLLER;
    },
    publish(pilotChannelId, controller) {
      if (controllers.get(pilotChannelId) === controller) return;
      controllers.set(pilotChannelId, controller);
      updateNames(pilotChannelId, controller.deviceNames);
      notify(pilotChannelId);
    },
    remove(pilotChannelId) {
      if (!controllers.delete(pilotChannelId)) return;
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
      channelListeners.add(listener);
      return () => {
        channelListeners?.delete(listener);
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
  const controller = useBetaflightTelemetry({ demoPlaybackActive });

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
  return pilotChannelIds.map((pilotChannelId) => (
    <PilotTelemetryBridge
      key={pilotChannelId}
      pilotChannelId={pilotChannelId}
      demoPlaybackActive={pilotChannelId === activePilotChannelId}
      store={store}
    />
  ));
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
