import type { VisionModelCandidate } from "./vision-model";
import type { createVisionCandidateTracker } from "./vision-timing";

type TrackerDiagnostics = ReturnType<ReturnType<typeof createVisionCandidateTracker>["getDiagnostics"]>;
export interface LiveVisionObservationDiagnostics {
  captureMs: number;
  roundTripMs: number;
  preprocessMs: number | null;
  modelMs: number | null;
  matchingMs: number | null;
  bestMatch: VisionModelCandidate | null;
  acceptedMatches: number;
}
export interface LiveVisionDiagnosticSample extends LiveVisionObservationDiagnostics {
  timeMs: number;
  inferenceMs: number;
  tracker: TrackerDiagnostics;
}
export interface LiveVisionDiagnostics {
  runId: string;
  backend: string;
  fallbackReason: string | null;
  targetFps: number;
  threshold: number;
  inputFps: number | null;
  analysisFps: number | null;
  inferenceP50Ms: number | null;
  inferenceP95Ms: number | null;
  lastSample: LiveVisionDiagnosticSample | null;
  counters: { presented: number; analyzed: number; busy: number; throttled: number; duplicate: number; unreported: number };
}

const LIMIT = 120;
const WINDOW_MS = 5000;
function fps(times: number[], now: number) {
  const recent = times.filter((value) => value >= now - WINDOW_MS);
  if (recent.length < 2 || now - recent.at(-1)! > 1500) return null;
  return (recent.length - 1) * 1000 / (recent.at(-1)! - recent[0]);
}
function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** Bounded local diagnostics. Images are never retained or included in the export. */
export function createLiveVisionDiagnostics(identity: Pick<LiveVisionDiagnostics, "runId" | "backend" | "fallbackReason" | "targetFps" | "threshold">) {
  const counters: LiveVisionDiagnostics["counters"] = { presented: 0, analyzed: 0, busy: 0, throttled: 0, duplicate: 0, unreported: 0 };
  const inputs: number[] = [];
  const completions: number[] = [];
  const samples: LiveVisionDiagnosticSample[] = [];
  const append = <T,>(list: T[], value: T) => { list.push(value); if (list.length > LIMIT) list.shift(); };
  const increment = (name: keyof typeof counters, by = 1) => { counters[name] = Math.min(Number.MAX_SAFE_INTEGER, counters[name] + by); };
  const snapshot = (now: number): LiveVisionDiagnostics => ({ ...identity, counters: { ...counters }, inputFps: fps(inputs, now), analysisFps: fps(completions, now), inferenceP50Ms: percentile(samples.map((sample) => sample.inferenceMs), .5), inferenceP95Ms: percentile(samples.map((sample) => sample.inferenceMs), .95), lastSample: samples.at(-1) ?? null });
  return {
    increment,
    observe: (now: number) => { increment("presented"); append(inputs, now); },
    complete: (sample: LiveVisionDiagnosticSample, now: number) => { increment("analyzed"); append(completions, now); append(samples, sample); },
    snapshot,
    export: (now: number) => ({ schemaVersion: 1, kind: "fpvhelper-live-vision-diagnostics", capturedAt: new Date().toISOString(), sampleLimit: LIMIT, imageDataIncluded: false, diagnostics: snapshot(now), samples: [...samples] }),
  };
}
