import { resolve, relative, isAbsolute } from "node:path";
import { parseMeasurementPlan, type MeasurementPlan } from "./phase1a-analysis.ts";

export type Arm = "A" | "B";
export interface ArmRun { arm: Arm; condition: "S1-100" | "S2"; mode: "N" | "P1"; repeat: number }
export interface Phase1BPlan extends Omit<MeasurementPlan, "conditions" | "runOrder"> {
  protocol: "fpvhelper-phase1b-ab/v1";
  formalMeasurementAllowed: boolean;
  baselineSha: string;
  roots: Record<Arm, string>;
  priorEvidenceRoots: string[];
  port: number;
  fixtureMaxFrames: number;
  runOrder: ArmRun[];
}
export interface ArmBuild {
  root: string; sourceSha: string; treeSha: string;
  normal: { buildId: string }; profiling: { buildId: string };
}
export interface BuildReceipt { schemaVersion: 1; arms: Record<Arm, ArmBuild> }

export function canonicalArmRuns(): Omit<ArmRun, "arm">[] {
  return [1, 2, 3].flatMap((repeat) => [
    { condition: "S1-100" as const, mode: "P1" as const, repeat },
    { condition: "S2" as const, mode: "P1" as const, repeat },
    { condition: "S2" as const, mode: "N" as const, repeat },
  ]);
}

export function balancedRunOrder(): ArmRun[] {
  return canonicalArmRuns().flatMap((run, pairIndex) => {
    const arms: Arm[] = pairIndex % 2 === 0 ? ["A", "B"] : ["B", "A"];
    return arms.map((arm) => ({ ...run, arm }));
  });
}

export function legacyProjection(plan: Phase1BPlan, parentPlanSha256: string) {
  const projected = {
    schemaVersion: 1 as const, status: plan.status, warmupMs: plan.warmupMs,
    windowMs: plan.windowMs, repeats: plan.repeats, lifecyclePhaseMs: plan.lifecyclePhaseMs,
    drainMs: plan.drainMs, cleanupMs: plan.cleanupMs, maxEvents: plan.maxEvents,
    maxTraceBytes: plan.maxTraceBytes, maxRunMs: plan.maxRunMs, maxBatchMs: plan.maxBatchMs,
    maxOutputBytes: plan.maxOutputBytes, minDiskFreeBytes: plan.minDiskFreeBytes, maxHeapBytes: plan.maxHeapBytes,
    conditions: [
      { id: "S1-100", scenario: "S1" as const, inputHz: 100 as const, modes: ["P1" as const] },
      { id: "S2", scenario: "S2" as const, inputHz: 100 as const, modes: ["P1" as const, "N" as const] },
    ],
    runOrder: canonicalArmRuns(),
    phase1bParentPlanSha256: parentPlanSha256,
    provenance: "Deterministic nine-run projection for each arm's unchanged Phase1A runner; outer receipt maps the 18 global indices to arm and child index.",
  };
  parseMeasurementPlan(projected);
  return projected;
}

export function parsePhase1BPlan(value: unknown): Phase1BPlan {
  if (!value || typeof value !== "object") throw new Error("Expected Phase1B plan");
  const plan = value as Phase1BPlan;
  if (plan.schemaVersion !== 1 || plan.protocol !== "fpvhelper-phase1b-ab/v1"
    || !["draft_pending_checks", "frozen"].includes(plan.status)
    || typeof plan.formalMeasurementAllowed !== "boolean") throw new Error("Invalid Phase1B protocol/status");
  if ((plan.status === "frozen") !== plan.formalMeasurementAllowed) throw new Error("Plan status/permission mismatch");
  if (plan.baselineSha !== "9ab7d90b6d4a8f3eac3c0c2e7825fc6a75846b84") throw new Error("Unreviewed A baseline");
  if (!plan.roots || typeof plan.roots.A !== "string" || !plan.roots.A || typeof plan.roots.B !== "string" || !plan.roots.B || !Array.isArray(plan.priorEvidenceRoots)
    || !plan.priorEvidenceRoots.length || plan.priorEvidenceRoots.some((path) => typeof path !== "string" || !path)) throw new Error("Missing arm/history budget roots");
  if (plan.warmupMs !== 5000 || plan.windowMs !== 20000 || plan.drainMs !== 3000 || plan.repeats !== 3
    || plan.fixtureMaxFrames !== 30000 || plan.maxHeapBytes !== null) throw new Error("Unexpected measurement conditions");
  if (!Number.isInteger(plan.port) || plan.port < 1024 || plan.port > 65535 || [3101, 3107].includes(plan.port)) throw new Error("Invalid owned server port");
  const expected = balancedRunOrder();
  if (!Array.isArray(plan.runOrder) || plan.runOrder.length !== expected.length || plan.runOrder.some((run, index) =>
    !run || run.arm !== expected[index].arm || run.condition !== expected[index].condition || run.mode !== expected[index].mode || run.repeat !== expected[index].repeat)) throw new Error("Expected fixed balanced 18-run order");
  legacyProjection(plan, "validation-only");
  return plan;
}

export function childRunIndex(run: ArmRun) {
  const index = canonicalArmRuns().findIndex((candidate) => candidate.repeat === run.repeat
    && candidate.condition === run.condition && candidate.mode === run.mode);
  if (index < 0) throw new Error("Unplanned child run");
  return index;
}

export function childRunId(run: ArmRun) {
  return `formal-${String(childRunIndex(run)).padStart(2, "0")}-${run.condition}-${run.mode}-r${run.repeat}`;
}

export function inside(parent: string, child: string) {
  const path = relative(resolve(parent), resolve(child));
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

export function uniqueBudgetRoots(paths: string[]) {
  const unique = [...new Set(paths.map((path) => resolve(path)))];
  return unique.filter((path) => !unique.some((other) => other !== path && inside(other, path))).sort();
}

export function parseBuildReceipt(value: unknown): BuildReceipt {
  if (!value || typeof value !== "object") throw new Error("Expected build receipt");
  const receipt = value as BuildReceipt;
  if (receipt.schemaVersion !== 1 || !receipt.arms) throw new Error("Invalid build receipt version");
  for (const arm of ["A", "B"] as const) {
    const build = receipt.arms[arm];
    if (!build || typeof build.root !== "string" || !/^[a-f0-9]{40}$/.test(build.sourceSha)
      || !/^[a-f0-9]{40}$/.test(build.treeSha) || !build.normal?.buildId || !build.profiling?.buildId) throw new Error(`Invalid ${arm} build identity`);
  }
  return receipt;
}
