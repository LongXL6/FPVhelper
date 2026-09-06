import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile, readdir, lstat, realpath, statfs } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { childRunId, childRunIndex, inside, legacyProjection, parseBuildReceipt, parsePhase1BPlan, uniqueBudgetRoots, type Arm, type ArmBuild } from "./phase1b-measurement.ts";

// This driver never builds or patches an arm. Each product runs its own accepted Phase1A tool.
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  if (!["--plan", "--builds", "--output", "--dry-run"].includes(key) || args.has(key)) throw new Error(`Invalid/duplicate argument ${key}`);
  if (key === "--dry-run") args.set(key, "true");
  else {
    const value = process.argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    args.set(key, value);
  }
}
const driverRoot = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const planPath = resolve(driverRoot, args.get("--plan") ?? "benchmarks/capture/phase1b-plan.json");
const planText = await readFile(planPath, "utf8"), plan = parsePhase1BPlan(JSON.parse(planText));
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const planSha256 = sha256(planText);
const roots: Record<Arm, string> = { A: await realpath(resolve(driverRoot, plan.roots.A)), B: await realpath(resolve(driverRoot, plan.roots.B)) };
if (roots.A === roots.B || roots.B !== driverRoot) throw new Error("A/B must be separate worktrees; driver must belong to B");
async function canonicalPath(path: string) {
  try { return await realpath(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return path; throw error; }
}
const budgetRoots = uniqueBudgetRoots(await Promise.all([
  ...Object.values(roots).map((root) => canonicalPath(resolve(root, "output/playwright"))),
  ...plan.priorEvidenceRoots.map((path) => canonicalPath(resolve(driverRoot, path))),
]));
const childPlanText = JSON.stringify(legacyProjection(plan, planSha256), null, 2) + "\n";
const childPlanSha256 = sha256(childPlanText);
const mapping = plan.runOrder.map((run, globalIndex) => ({ globalIndex, ...run, childRunIndex: childRunIndex(run), childRunId: childRunId(run), productRoot: roots[run.arm] }));
if (args.has("--dry-run")) {
  console.log(JSON.stringify({ status: "dry_run_only", planStatus: plan.status, planSha256, childPlanSha256, roots, budgetRoots, runCount: mapping.length, mapping, limitations: "No builds/source cleanliness/port/browser checks; no files or processes created." }, null, 2));
  process.exit(0);
}
if (plan.status !== "frozen" || !plan.formalMeasurementAllowed) throw new Error("Formal Phase1B plan must be frozen and committed");
if (!args.get("--builds") || !args.get("--output")) throw new Error("Formal run requires --builds and a new --output directory");
const buildsPath = resolve(driverRoot, args.get("--builds")!);
const buildsText = await readFile(buildsPath, "utf8"), builds = parseBuildReceipt(JSON.parse(buildsText));
const output = resolve(driverRoot, args.get("--output")!);
if (!inside(resolve(driverRoot, "output/playwright"), output)) throw new Error("Driver output must be inside B output/playwright");
const batchName = output.split("/").at(-1)!;
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,90}$/.test(batchName)) throw new Error("Use a short unique batch directory name");
const armOutputs = { A: resolve(roots.A, "output/playwright/phase1b", batchName), B: resolve(output, "arm-B") };
const inspectGit = (root: string, command: string[]) => execFileSync("git", command, { cwd: root, encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 }).trim();
const sourceIdentity = (root: string) => ({ sourceSha: inspectGit(root, ["rev-parse", "HEAD"]), treeSha: inspectGit(root, ["rev-parse", "HEAD^{tree}"]) });
const driverIdentity = sourceIdentity(driverRoot);
const driverFiles = ["scripts/run-phase1b-batch.mts", "scripts/phase1b-measurement.ts", "scripts/phase1b-measurement.test.ts", "benchmarks/capture/phase1b-plan.json"];
const driverHashes = Object.fromEntries(await Promise.all(driverFiles.map(async (path) => [path, sha256(await readFile(resolve(driverRoot, path)))])));
const immutableFiles = ["scripts/measure-phase1a.mts", "scripts/run-phase1a-batch.mts", "scripts/phase1a-analysis.ts", "e2e/fixtures/measurement-hardware.ts", "e2e/fixtures/fpv-hardware.ts", "lib/capture-measurement.ts", "components/measurement-profiler.tsx", "benchmarks/capture/measurement-plan.json"];
const legacyHashes = Object.fromEntries(immutableFiles.map((path) => [path, sha256(execFileSync("git", ["show", `${plan.baselineSha}:${path}`], { cwd: driverRoot, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }))]));
async function verifyArm(arm: Arm) {
  const root = roots[arm], build = builds.arms[arm], identity = sourceIdentity(root);
  if (await realpath(build.root) !== root || identity.sourceSha !== build.sourceSha || identity.treeSha !== build.treeSha) throw new Error(`${arm} product identity differs from build receipt`);
  if (arm === "A" && identity.sourceSha !== plan.baselineSha) throw new Error("A is not the reviewed baseline");
  if (inspectGit(root, ["status", "--porcelain"])) throw new Error(`${arm} source is not clean`);
  for (const path of immutableFiles) if (sha256(await readFile(resolve(root, path))) !== legacyHashes[path]) throw new Error(`${arm} modified immutable Phase1A file ${path}`);
  for (const [name, directory] of [["normal", ".next"], ["profiling", ".next-measurement"]] as const) {
    if ((await readFile(resolve(root, directory, "BUILD_ID"), "utf8")).trim() !== build[name].buildId) throw new Error(`${arm} ${name} BUILD_ID mismatch`);
  }
  return identity;
}
async function verifySources() {
  await verifyArm("A"); await verifyArm("B");
  if (sourceIdentity(driverRoot).sourceSha !== driverIdentity.sourceSha || sha256(await readFile(planPath)) !== planSha256) throw new Error("Driver or frozen plan changed");
  for (const path of driverFiles) if (sha256(await readFile(resolve(driverRoot, path))) !== driverHashes[path]) throw new Error(`Driver file changed: ${path}`);
}
async function treeBytes(path: string): Promise<number> {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  let total = 0;
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink in evidence budget root: ${full}`);
    total += entry.isDirectory() ? await treeBytes(full) : (await lstat(full)).size;
  }
  return total;
}
async function availableDisk(path: string) {
  try { const disk = await statfs(path); return disk.bavail * disk.bsize; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return availableDisk(dirname(path)); throw error; }
}
async function checkBudget() {
  const rows = await Promise.all(budgetRoots.map(async (root) => ({ root, bytes: await treeBytes(root), freeDiskBytes: await availableDisk(root) })));
  if (rows.some((row) => row.freeDiskBytes < plan.minDiskFreeBytes)) throw new Error("Free disk below 2 GiB guard");
  const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  if (totalBytes > plan.maxOutputBytes) throw new Error(`Cumulative A/B/history artifact budget exceeded (${totalBytes})`);
  return { roots: rows, totalBytes, maxBytes: plan.maxOutputBytes };
}
await verifySources();
const initialBudget = await checkBudget();
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
await mkdir(dirname(armOutputs.A), { recursive: true });
await mkdir(armOutputs.A, { recursive: false });
await mkdir(armOutputs.B, { recursive: false });
const childPlanPath = resolve(output, "derived-phase1a-plan.json");
await writeFile(childPlanPath, childPlanText, { flag: "wx" });
const runs: Array<Record<string, unknown>> = [], serverEvents: Array<Record<string, unknown>> = [];
const receipt: Record<string, unknown> = { protocol: plan.protocol, status: "running", parentPlan: { path: planPath, sha256: planSha256 }, childPlan: { path: childPlanPath, sha256: childPlanSha256 }, driver: { root: driverRoot, ...driverIdentity, files: driverHashes }, arms: builds.arms, buildsReceipt: { path: buildsPath, sha256: sha256(buildsText) }, legacyToolFiles: legacyHashes, roots, armOutputs, initialBudget, plannedRuns: mapping, runs, serverEvents, startedAtUtc: new Date().toISOString() };
const save = () => writeFile(resolve(output, "phase1b-orchestrator.json"), JSON.stringify(receipt, null, 2) + "\n");
const beganBatch = Date.now(), workDeadline = beganBatch + plan.maxBatchMs - plan.cleanupMs;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
let server: ChildProcess | null = null, runner: ChildProcess | null = null, currentServer: string | null = null, interrupted = false;
const ownedServerPid = () => server?.pid;
const closed = new WeakSet<ChildProcess>(), errors = new WeakMap<ChildProcess, Error>();
function track(child: ChildProcess) { child.once("close", () => closed.add(child)); child.once("error", (error) => errors.set(child, error)); return child; }
function groupAlive(child: ChildProcess) {
  if (!child.pid) return false;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
function signal(child: ChildProcess, value: NodeJS.Signals) {
  if (!child.pid) return;
  try { process.kill(-child.pid, value); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
async function stopOwned(child: ChildProcess, label: string) {
  const stopped = () => closed.has(child) && !groupAlive(child);
  if (stopped()) return { pid: child.pid, forced: false };
  signal(child, "SIGTERM"); let deadline = Date.now() + 8000;
  while (!stopped() && Date.now() < deadline) await sleep(100);
  const forced = !stopped(); if (forced) signal(child, "SIGKILL"); deadline = Date.now() + 2000;
  while (!stopped() && Date.now() < deadline) await sleep(100);
  if (!stopped()) throw new Error(`${label} cleanup unconfirmed; retain PID ${child.pid ?? "unknown"}`);
  return { pid: child.pid, forced };
}
async function stopServer() {
  if (!server) return;
  const result = await stopOwned(server, "server"); serverEvents.push({ event: "stopped", category: currentServer, ...result, atUtc: new Date().toISOString() }); server = null; currentServer = null;
  if (result.forced) throw new Error("Server required forced termination; not product cleanup proof");
}
const url = `http://127.0.0.1:${plan.port}`;
async function startServer(arm: Arm, mode: "N" | "P1", index: number) {
  const category = `${arm}:${mode}`;
  if (currentServer === category && server && server.exitCode === null && server.signalCode === null) return;
  await stopServer();
  await new Promise<void>((done, reject) => { const probe = createServer(); probe.once("error", reject); probe.listen(plan.port, "127.0.0.1", () => probe.close((error) => error ? reject(error) : done())); });
  const log = await open(resolve(output, `server-${String(index).padStart(2, "0")}-${arm}-${mode}.log`), "wx");
  server = track(spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(plan.port)], { cwd: roots[arm], detached: true, stdio: ["ignore", log.fd, log.fd], env: { ...process.env, FPV_MEASUREMENT_BUILD: mode === "N" ? "0" : "1", NEXT_PUBLIC_ANALYTICS_ENABLED: "false", NEXT_TELEMETRY_DISABLED: "1" } }));
  await log.close(); currentServer = category;
  serverEvents.push({ event: "started", globalIndex: index, arm, mode, root: roots[arm], pid: server.pid, port: plan.port, buildId: buildFor(builds.arms[arm], mode), atUtc: new Date().toISOString() }); await save();
  const deadline = Math.min(Date.now() + 20000, workDeadline);
  while (!interrupted && Date.now() < deadline) {
    if (errors.has(server) || server.exitCode !== null || server.signalCode !== null) throw new Error("Owned server exited before readiness");
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Only the owned loopback server is polled. */ }
    await sleep(200);
  }
  throw new Error("Owned server readiness deadline");
}
function buildFor(build: ArmBuild, mode: "N" | "P1") { return mode === "N" ? build.normal.buildId : build.profiling.buildId; }
process.once("SIGINT", () => { interrupted = true; }); process.once("SIGTERM", () => { interrupted = true; });
await save();
try {
  for (const run of mapping) {
    if (interrupted || Date.now() >= workDeadline) throw new Error("Batch interrupted/work deadline; reserved cleanup begins");
    receipt.activeGlobalIndex = run.globalIndex; await save();
    await verifySources(); const beforeBudget = await checkBudget(); await startServer(run.arm, run.mode, run.globalIndex);
    const product = builds.arms[run.arm], actualOutput = armOutputs[run.arm];
    const row: Record<string, unknown> = { ...run, product, servedBuildId: buildFor(product, run.mode), actualOutput, childPlanSha256, status: "running", beforeBudget, startedAtUtc: new Date().toISOString() };
    runs.push(row); await save();
    const args = ["--experimental-transform-types", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/measure-phase1a.mts", "--plan", childPlanPath, "--normal-url", url, "--profile-url", url, "--output", actualOutput, "--run-index", String(run.childRunIndex)];
    const began = Date.now(); runner = track(spawn(process.execPath, args, { cwd: roots[run.arm], detached: true, stdio: ["ignore", "inherit", "inherit"] }));
    const owned = runner; Object.assign(row, { runnerPid: owned.pid, command: [process.execPath, ...args], runnerRoot: roots[run.arm] }); await save();
    const deadline = Math.min(began + plan.maxRunMs + plan.cleanupMs, workDeadline); let nextBudget = Date.now() + 1000;
    while (!closed.has(owned)) {
      if (interrupted || Date.now() >= deadline || errors.has(owned)) throw new Error(`Run ${run.globalIndex} deadline/interruption/start failure`);
      if (Date.now() >= nextBudget) { await checkBudget(); nextBudget = Date.now() + 1000; }
      await sleep(100);
    }
    if (groupAlive(owned)) throw new Error(`Run ${run.globalIndex} left owned process group alive`);
    runner = null; Object.assign(row, { exitCode: owned.exitCode, wallMs: Date.now() - began });
    if (owned.exitCode !== 0) throw new Error(`Run ${run.globalIndex} returned ${owned.exitCode}`);
    const artifact = resolve(actualOutput, `${run.childRunId}.json.gz`), summaryPath = resolve(actualOutput, `${run.childRunId}.summary.json`);
    const bytes = await readFile(artifact), decoded = gunzipSync(bytes, { maxOutputLength: plan.maxTraceBytes });
    const raw = JSON.parse(decoded.toString()), summaryBytes = await readFile(summaryPath), summary = JSON.parse(summaryBytes.toString());
    if (raw.runId !== run.childRunId || raw.sourceSha !== product.sourceSha || raw.sourceDiffSha256 !== sha256("") || raw.planSha256 !== childPlanSha256 || raw.mode !== run.mode || raw.condition.id !== run.condition || raw.exploratory || summary.valid !== true || summary.rawBytes !== decoded.length || summary.compressedBytes !== bytes.length) throw new Error(`Run ${run.globalIndex} raw product/plan/result identity mismatch`);
    await verifySources(); const afterBudget = await checkBudget();
    Object.assign(row, { status: "completed", afterBudget, artifact: { path: artifact, bytes: bytes.length, sha256: sha256(bytes), decodedBytes: decoded.length, decodedSha256: sha256(decoded) }, summary: { path: summaryPath, bytes: summaryBytes.length, sha256: sha256(summaryBytes) } });
    await save(); console.log(JSON.stringify({ completed: runs.length, planned: mapping.length, globalIndex: run.globalIndex, arm: run.arm, condition: run.condition, mode: run.mode, repeat: run.repeat }));
  }
  receipt.status = "needs_review";
} catch (error) {
  receipt.status = "partial"; receipt.stopReason = error instanceof Error ? error.message : "Unknown driver failure";
  if (runs.at(-1)?.status === "running") Object.assign(runs.at(-1)!, { status: "failed", stopReason: receipt.stopReason });
  process.exitCode = 1;
} finally {
  if (runner) {
    const owned = runner;
    try { receipt.runnerCleanup = { ...await stopOwned(owned, "runner"), productResources: "unverified_after_abnormal_exit" }; runner = null; }
    catch (error) { receipt.runnerCleanup = { retainedPid: owned.pid, error: String(error) }; }
    receipt.status = "partial"; process.exitCode = 1;
  }
  try { await stopServer(); receipt.serverCleanup = "owned_server_process_closed"; }
  catch (error) { receipt.serverCleanup = { retainedPid: ownedServerPid(), error: String(error) }; receipt.status = "partial"; process.exitCode = 1; }
  try { receipt.finalBudget = await checkBudget(); }
  catch (error) { receipt.finalBudget = { error: String(error) }; receipt.status = "partial"; process.exitCode = 1; }
  receipt.finishedAtUtc = new Date().toISOString(); receipt.wallMs = Date.now() - beganBatch; await save();
  console.log(JSON.stringify({ status: receipt.status, completed: runs.filter((run) => run.status === "completed").length, planned: mapping.length, receipt: resolve(output, "phase1b-orchestrator.json") }));
}
