"use client";

import { useEffect, useState } from "react";
import {
  createWakeLockCoordinator,
  createWorkstationTabLease,
  type ScreenWakeState,
  type WakeLockSentinelLike,
  type WorkstationTabState,
} from "@/lib/workstation-runtime";

interface WakeLockManagerLike {
  request: (type: "screen") => Promise<WakeLockSentinelLike>;
}

interface LockManagerLike {
  request: (
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: object | null) => Promise<void> | void,
  ) => Promise<unknown>;
}

export function useWorkstationRuntime({ keepAwake }: { keepAwake: boolean }) {
  const [tabState, setTabState] = useState<WorkstationTabState>("checking");
  const [wakeState, setWakeState] = useState<ScreenWakeState>("idle");

  useEffect(() => {
    const lockManager = (navigator as Navigator & { locks?: LockManagerLike }).locks;
    if (!lockManager) {
      let active = true;
      queueMicrotask(() => {
        if (active) setTabState("unsupported");
      });
      return () => {
        active = false;
      };
    }
    return createWorkstationTabLease(lockManager, setTabState);
  }, []);

  useEffect(() => {
    if (!keepAwake) return;

    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockManagerLike }).wakeLock;
    if (!wakeLock) {
      let active = true;
      queueMicrotask(() => {
        if (active) setWakeState("unsupported");
      });
      return () => {
        active = false;
      };
    }

    const coordinator = createWakeLockCoordinator({
      request: () => wakeLock.request("screen"),
      isVisible: () => document.visibilityState === "visible",
      onState: setWakeState,
    });
    const handleVisibilityChange = () => coordinator.visibilityChanged();

    document.addEventListener("visibilitychange", handleVisibilityChange);
    void coordinator.acquire();
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      coordinator.dispose();
    };
  }, [keepAwake]);

  return { tabState, wakeState: keepAwake ? wakeState : "idle" as ScreenWakeState };
}
