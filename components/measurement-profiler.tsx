"use client";

import { Profiler, version, type ProfilerOnRenderCallback, type ReactNode } from "react";
import { measurementEnabled, measurementEvent } from "@/lib/capture-measurement";

const onRender: ProfilerOnRenderCallback = (profilerId, phase, actualDuration, baseDuration, startTime, commitTime) => {
  if (!measurementEnabled()) return;
  measurementEvent("react.commit", { profilerId, phase, actualDuration, baseDuration, startTime, commitTime, reactVersion: version });
};

// Normal builds return the original element without adding a React boundary.
export function withMeasurementProfiler(id: string, children: ReactNode) {
  if (process.env.NEXT_PUBLIC_FPV_MEASUREMENT !== "true") return children;
  return <Profiler key={id} id={id} onRender={onRender}>{children}</Profiler>;
}

export function MeasurementProfiler({ id, children }: { id: string; children: ReactNode }) {
  return withMeasurementProfiler(id, children);
}
