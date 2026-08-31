"use client";

import { useEffect, useState } from "react";
import {
  createWorkstationTabLease,
  type WorkstationTabState,
} from "@/lib/workstation-runtime";

export type ScreenWakeState = "idle" | "requesting" | "active" | "released" | "unsupported" | "error";

interface WakeLockSentinelLike {
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void, options?: AddEventListenerOptions) => void;
}

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

    let active = true;
    let sentinel: WakeLockSentinelLike | null = null;

    const acquire = async () => {
      if (!active || document.visibilityState !== "visible" || sentinel) return;
      setWakeState("requesting");
      try {
        const nextSentinel = await wakeLock.request("screen");
        if (!active) {
          await nextSentinel.release();
          return;
        }
        sentinel = nextSentinel;
        setWakeState("active");
        nextSentinel.addEventListener("release", () => {
          if (sentinel === nextSentinel) sentinel = null;
          if (active) setWakeState("released");
        }, { once: true });
      } catch {
        if (active) setWakeState("error");
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void acquire();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    void acquire();
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (sentinel) void sentinel.release().catch(() => undefined);
    };
  }, [keepAwake]);

  return { tabState, wakeState: keepAwake ? wakeState : "idle" as ScreenWakeState };
}
