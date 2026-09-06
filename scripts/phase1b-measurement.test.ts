import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { balancedRunOrder, childRunId, childRunIndex, inside, legacyProjection, parseBuildReceipt, parsePhase1BPlan, uniqueBudgetRoots } from "./phase1b-measurement";

function plan() { return JSON.parse(readFileSync(new URL("../benchmarks/capture/phase1b-plan.json", import.meta.url), "utf8")); }

describe("Phase1B arm identity and fixed plan", () => {
  it("covers every arm/condition/mode/repeat exactly once with adjacent balanced pairs", () => {
    const parsed = parsePhase1BPlan(plan());
    expect(parsed.runOrder).toHaveLength(18);
    expect(new Set(parsed.runOrder.map((run) => `${run.arm}:${run.condition}:${run.mode}:${run.repeat}`)).size).toBe(18);
    expect(parsed.runOrder.filter((_, index) => index % 2 === 0).map((run) => run.arm)).toEqual(["A", "B", "A", "B", "A", "B", "A", "B", "A"]);
  });
  it("projects a valid nine-run child plan without changing sampling, timing or analysis", () => {
    const parsed = parsePhase1BPlan(plan()), child = legacyProjection(parsed, "parent-hash");
    expect(child.runOrder).toHaveLength(9);
    expect(child).toMatchObject({ phase1bParentPlanSha256: "parent-hash", warmupMs: 5000, windowMs: 20000, drainMs: 3000, maxEvents: 200000 });
    for (const run of balancedRunOrder()) {
      expect(child.runOrder[childRunIndex(run)]).toEqual({ condition: run.condition, mode: run.mode, repeat: run.repeat });
      expect(childRunId(run)).toMatch(/^formal-0[0-8]-(S1-100|S2)-(P1|N)-r[1-3]$/);
    }
  });
  it("rejects an omitted/duplicated/reordered arm, unsafe port, timing change and false freeze", () => {
    const missing = plan(); missing.runOrder.pop(); expect(() => parsePhase1BPlan(missing)).toThrow();
    const duplicate = plan(); duplicate.runOrder[1] = duplicate.runOrder[0]; expect(() => parsePhase1BPlan(duplicate)).toThrow();
    const reordered = plan(); reordered.runOrder.reverse(); expect(() => parsePhase1BPlan(reordered)).toThrow();
    for (const patch of [{ port: 3101 }, { warmupMs: 2000 }, { formalMeasurementAllowed: true }, { baselineSha: "bad" }]) expect(() => parsePhase1BPlan({ ...plan(), ...patch })).toThrow();
  });
  it("accepts only frozen/allowed together and keeps child status bound to the parent", () => {
    const frozen = parsePhase1BPlan({ ...plan(), status: "frozen", formalMeasurementAllowed: true });
    expect(legacyProjection(frozen, "frozen-hash").status).toBe("frozen");
  });
  it("does not let output escape its product worktree and avoids counting overlapping budget roots twice", () => {
    expect(inside("/a/output/playwright", "/b/output/playwright/run")).toBe(false);
    expect(inside("/a/output/playwright", "/a/output/playwright")).toBe(false);
    expect(inside("/a/output/playwright", "/a/output/playwright/run")).toBe(true);
    expect(uniqueBudgetRoots(["/a/output", "/a/output/run", "/b/output", "/a/output"])).toEqual(["/a/output", "/b/output"]);
  });
  it("requires separate complete A/B build identities", () => {
    const build = { root: "/arm", sourceSha: "a".repeat(40), treeSha: "b".repeat(40), normal: { buildId: "normal" }, profiling: { buildId: "profile" } };
    expect(parseBuildReceipt({ schemaVersion: 1, arms: { A: build, B: build } }).arms.A.sourceSha).toHaveLength(40);
    expect(() => parseBuildReceipt({ schemaVersion: 1, arms: { A: build } })).toThrow();
    expect(() => parseBuildReceipt({ schemaVersion: 1, arms: { A: build, B: { ...build, sourceSha: "wrong" } } })).toThrow();
  });
});
