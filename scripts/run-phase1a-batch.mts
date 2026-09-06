import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, sep } from "node:path";
import { parseMeasurementPlan } from "./phase1a-analysis.ts";

const args = process.argv.slice(2);
function option(name: string, fallback?: string) {
  const index = args.indexOf(name);
  if (index < 0) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing ${name}`);
  }
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing value for ${name}`);
  return args[index + 1];
}
const cwd = process.cwd();
const planPath = resolve(option("--plan", "benchmarks/capture/measurement-plan.json"));
const output = resolve(option("--output"));
const port = Number(option("--port", "3124"));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid owned server port");
if (!output.startsWith(resolve("output/playwright") + sep)) throw new Error("Output must be inside this worktree's ignored Playwright directory");
const planText = await readFile(planPath, "utf8");
const plan = parseMeasurementPlan(JSON.parse(planText));
if (plan.status !== "frozen" || JSON.parse(planText).formalMeasurementAllowed !== true) throw new Error("Formal plan must be frozen before this orchestrator runs");
const planSha256 = createHash("sha256").update(planText).digest("hex");
const url = `http://127.0.0.1:${port}`;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
let server: ChildProcess | null = null;
let runner: ChildProcess | null = null;
let category: "N" | "P" | null = null;
let interrupted = false;
const closedChildren = new WeakSet<ChildProcess>();
const spawnErrors = new WeakMap<ChildProcess, Error>();
function track(child: ChildProcess) {
  child.once("close", () => closedChildren.add(child));
  child.once("error", (error) => spawnErrors.set(child, error));
  return child;
}
function groupAlive(child: ChildProcess) {
  if (!child.pid) return false;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
async function stopOwned(child: ChildProcess, label: string) {
  const stopped = () => closedChildren.has(child) && !groupAlive(child);
  if (stopped()) return { pid: child.pid, forced: false };
  signalGroup(child, "SIGTERM");
  let deadline = Date.now() + 8000;
  while (!stopped() && Date.now() < deadline) await sleep(100);
  const forced = !stopped();
  if (forced) signalGroup(child, "SIGKILL");
  deadline = Date.now() + 2000;
  while (!stopped() && Date.now() < deadline) await sleep(100);
  if (!stopped()) throw new Error(`${label} cleanup unconfirmed; retain owned PID ${child.pid ?? "unavailable"} for inspection`);
  return { pid: child.pid, forced };
}

async function commandText(command: string, commandArgs: string[]) {
  const child = spawn(command, commandArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  child.stdout.on("data", (value: Buffer) => { text += value.toString(); });
  const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
  if (code !== 0) throw new Error(`${command} inspection failed (${code})`);
  return text.trim();
}
const sourceSha = await commandText("git", ["rev-parse", "HEAD"]);
if (await commandText("git", ["status", "--porcelain"])) throw new Error("Formal measurements require a clean tested source commit");
const builds = JSON.parse(await readFile("output/playwright/phase1a-builds/builds.json", "utf8")) as { sourceSha: string; normal: { buildId: string }; profiling: { buildId: string } };
if (builds.sourceSha !== sourceSha) throw new Error("Build receipt source differs from tested commit");
if ((await readFile(".next/BUILD_ID", "utf8")).trim() !== builds.normal.buildId
  || (await readFile(".next-measurement/BUILD_ID", "utf8")).trim() !== builds.profiling.buildId) throw new Error("Served build identity differs from receipt");
await mkdir(output, { recursive: false });
const receipt: Record<string, unknown> = {
  sourceSha, planSha256, builds, port, startedAtUtc: new Date().toISOString(), status: "running", runs: [], cleanup: null,
};
const serverEvents: Array<Record<string, unknown>> = [];
receipt.serverEvents = serverEvents;
const runReceipts: Array<Record<string, unknown>> = [];
receipt.runs = runReceipts;
const saveReceipt = () => writeFile(resolve(output, "orchestrator.json"), JSON.stringify(receipt, null, 2) + "\n");
const batchStarted = Date.now();
const batchWorkDeadline = batchStarted + plan.maxBatchMs - plan.cleanupMs;
await saveReceipt();

async function stopServer() {
  const owned = server;
  if (!owned) return;
  const outcome = await stopOwned(owned, "server");
  serverEvents.push({ event: "stopped", category, ...outcome, atUtc: new Date().toISOString() });
  server = null;
  category = null;
  if (outcome.forced) throw new Error("Owned server required forced termination; cleanup is not a product resource-release proof");
}
async function startServer(nextCategory: "N" | "P", runIndex: number) {
  if (category === nextCategory && server && server.exitCode === null && server.signalCode === null) return;
  await stopServer();
  await new Promise<void>((done, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close((error) => error ? reject(error) : done()));
  });
  const log = await open(resolve(output, `server-${runIndex}-${nextCategory}.log`), "wx");
  server = track(spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd, detached: true, stdio: ["ignore", log.fd, log.fd],
    env: { ...process.env, FPV_MEASUREMENT_BUILD: nextCategory === "N" ? "0" : "1", NEXT_PUBLIC_ANALYTICS_ENABLED: "false", NEXT_TELEMETRY_DISABLED: "1" },
  }));
  await log.close();
  category = nextCategory;
  serverEvents.push({ event: "started", category, pid: server.pid, runIndex, atUtc: new Date().toISOString() });
  await saveReceipt();
  const deadline = Math.min(Date.now() + 20_000, batchWorkDeadline);
  while (Date.now() < deadline && !interrupted) {
    if (spawnErrors.has(server) || server.exitCode !== null || server.signalCode !== null) throw new Error("Owned server exited before readiness");
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Bounded startup polling. */ }
    await sleep(200);
  }
  throw new Error("Owned server readiness deadline exceeded");
}
function interrupt() {
  interrupted = true;
}
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

try {
  for (const [index, run] of plan.runOrder.entries()) {
    if (interrupted) throw new Error("Batch interrupted");
    if (Date.now() >= batchWorkDeadline) throw new Error("Batch work deadline exceeded; reserved cleanup begins");
    if (await commandText("git", ["rev-parse", "HEAD"]) !== sourceSha || await commandText("git", ["status", "--porcelain"])) throw new Error("Source changed during formal batch");
    await startServer(run.mode === "N" ? "N" : "P", index);
    const began = Date.now();
    runner = track(spawn(process.execPath, ["--experimental-transform-types", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/measure-phase1a.mts", "--plan", planPath, "--normal-url", url, "--profile-url", url, "--output", output, "--run-index", String(index)], { cwd, detached: true, stdio: ["ignore", "inherit", "inherit"] }));
    const ownedRunner = runner;
    const runReceipt: Record<string, unknown> = { index, ...run, pid: ownedRunner.pid, status: "running", startedAtUtc: new Date().toISOString() };
    runReceipts.push(runReceipt);
    await saveReceipt();
    const deadline = Math.min(began + plan.maxRunMs + plan.cleanupMs, batchWorkDeadline);
    while (!closedChildren.has(ownedRunner)) {
      if (interrupted || Date.now() >= deadline || spawnErrors.has(ownedRunner)) throw new Error(`Run ${index} interrupted, timed out or failed to start; browser cleanup requires separate evidence`);
      await sleep(100);
    }
    const code = ownedRunner.exitCode;
    if (groupAlive(ownedRunner)) throw new Error(`Run ${index} left its owned process group alive`);
    runner = null;
    Object.assign(runReceipt, { exitCode: code, wallMs: Date.now() - began, status: code === 0 ? "completed" : "failed" });
    await saveReceipt();
    if (code !== 0) throw new Error(`Run ${index} stopped the batch (exit ${code})`);
    console.log(JSON.stringify({ completed: index + 1, planned: plan.runOrder.length, ...run }));
  }
  receipt.status = "measurements_completed_pending_review";
} catch (error) {
  receipt.status = "partial";
  receipt.stopReason = error instanceof Error ? error.message : "Unknown orchestrator failure";
  process.exitCode = 1;
} finally {
  if (runner) {
    const unfinishedRunner = runner;
    try { receipt.runnerCleanup = { ...await stopOwned(unfinishedRunner, "runner"), browserResources: "unverified_after_abnormal_exit" }; runner = null; }
    catch (error) { receipt.runnerCleanup = { error: error instanceof Error ? error.message : "Unknown runner cleanup failure", retainedPid: unfinishedRunner.pid }; }
    receipt.status = "partial";
    process.exitCode = 1;
  }
  try { await stopServer(); receipt.cleanup = "owned_server_process_closed"; }
  catch (error) { receipt.cleanup = error instanceof Error ? error.message : "Unknown cleanup failure"; receipt.status = "partial"; process.exitCode = 1; }
  receipt.finishedAtUtc = new Date().toISOString();
  receipt.wallMs = Date.now() - batchStarted;
  await saveReceipt();
  console.log(JSON.stringify({ status: receipt.status, stopReason: receipt.stopReason ?? null, cleanup: receipt.cleanup, completed: runReceipts.filter((run) => run.exitCode === 0).length, planned: plan.runOrder.length }));
}
