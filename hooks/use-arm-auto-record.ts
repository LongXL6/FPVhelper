"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArmAutoRecordController,
  type ArmAutoRecordSnapshot,
  type ArmAutoRecordStopReason,
  type ArmSwitchConfig,
} from "@/lib/arm-auto-record";
import type {
  ConnectionState,
  LinkState,
  SubscribeTelemetrySamples,
  TelemetrySource,
} from "@/lib/telemetry";

export interface UseArmAutoRecordOptions {
  subscribeSamples: SubscribeTelemetrySamples;
  source: TelemetrySource;
  connection: ConnectionState;
  linkState: LinkState;
  inputKey: string;
  start: (signal: AbortSignal) => Promise<boolean>;
  stop: (reason: ArmAutoRecordStopReason) => Promise<void>;
  canEnable: boolean | (() => boolean);
  canObserve?: boolean;
}

export function useArmAutoRecord({
  subscribeSamples,
  source,
  connection,
  linkState,
  inputKey,
  start,
  stop,
  canEnable,
  canObserve = true,
}: UseArmAutoRecordOptions) {
  const [state, setState] = useState<ArmAutoRecordSnapshot>({
    phase: "disabled",
    enabled: false,
    error: null,
    disarmRemainingMs: null,
  });
  const [config, updateConfig] = useState<ArmSwitchConfig>({ auxIndex: 0, min: 1700, max: 2100 });
  const operationsRef = useRef({ start, stop });
  const canObserveRef = useRef(false);
  const previousInputKeyRef = useRef(inputKey);
  const mountedRef = useRef(false);
  const controllerRef = useRef<ArmAutoRecordController | null>(null);

  useEffect(() => {
    operationsRef.current = { start, stop };
  }, [start, stop]);

  useEffect(() => {
    mountedRef.current = true;
    controllerRef.current ??= new ArmAutoRecordController({
      start: (signal) => operationsRef.current.start(signal),
      stop: (reason) => operationsRef.current.stop(reason),
      onState: (snapshot) => {
        if (mountedRef.current) setState(snapshot);
      },
    });
    const controller = controllerRef.current;
    return () => {
      mountedRef.current = false;
      void controller.disable();
    };
  }, []);

  useEffect(() => {
    canObserveRef.current = canObserve && source === "serial" && connection === "live" && linkState === "ok";
    controllerRef.current?.tick(performance.now(), canObserveRef.current);
  }, [canObserve, connection, linkState, source]);

  useEffect(() => {
    if (previousInputKeyRef.current === inputKey) return;
    previousInputKeyRef.current = inputKey;
    void controllerRef.current?.disable();
  }, [inputKey]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    const unsubscribe = subscribeSamples((sample, sampleSource) => {
      const nowMs = performance.now();
      if (!canObserveRef.current || sampleSource !== "serial") {
        controller.tick(nowMs, false);
        return;
      }
      controller.observe({ channels: sample.rcChannelsUs, timestampMs: sample.monotonicTimestampMs }, nowMs);
    });
    const timer = setInterval(() => {
      controller.tick(performance.now(), canObserveRef.current);
    }, 100);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [subscribeSamples]);

  const setConfig = useCallback((next: ArmSwitchConfig) => {
    if (mountedRef.current && !controllerRef.current?.getSnapshot().enabled) updateConfig({ ...next });
  }, []);

  const enable = useCallback(() => {
    return mountedRef.current &&
      (typeof canEnable === "function" ? canEnable() : canEnable) &&
      (controllerRef.current?.enable(config) ?? false);
  }, [canEnable, config]);

  const disable = useCallback(() => controllerRef.current?.disable() ?? Promise.resolve(), []);

  return { state, config, setConfig, enable, disable };
}
