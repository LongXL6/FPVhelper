import { mkdir, readFile, writeFile, readdir, stat, statfs } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { chromium, expect, type Page, type CDPSession } from "@playwright/test";
import { installMeasurementHardware, type MeasurementHardwareControl } from "../e2e/fixtures/measurement-hardware.ts";
import { readStoredTrainingRecords } from "../e2e/fixtures/fpv-hardware.ts";
import { analyzeMeasurementRun, parseMeasurementPlan, type MeasurementMode, type MeasurementResult, type MeasurementWindow } from "./phase1a-analysis.ts";

// Explicit opt-in runner. Servers are owned by the caller; this script never builds or stops them.
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (!["--plan", "--normal-url", "--profile-url", "--output", "--condition", "--mode", "--run-index", "--exploratory", "--product-root", "--build-id", "--trace"].includes(key) || args.has(key)) throw new Error(`Invalid argument ${key}`);
  if (key === "--exploratory" || key === "--trace") args.set(key, "true");
  else { const value = process.argv[++i]; if (!value || value.startsWith("--")) throw new Error(`Missing value ${key}`); args.set(key, value); }
}
const repo = fileURLToPath(new URL("../", import.meta.url));
function explicitLocalUrl(key: string) {
  const url = new URL(args.get(key) ?? "missing:");
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash || ["3101", "3107"].includes(url.port)) throw new Error(`${key} requires an explicit isolated localhost URL (not user ports 3101/3107)`);
  return url.origin;
}
const urls = { N: explicitLocalUrl("--normal-url"), P0: explicitLocalUrl("--profile-url"), P1: explicitLocalUrl("--profile-url") };
const output = resolve(repo, args.get("--output") ?? "missing");
const budgetRoot = resolve(repo, "output/playwright");
const outputRelative = relative(budgetRoot, output);
if (!outputRelative || outputRelative.startsWith("..") || outputRelative.startsWith("/")) throw new Error("--output must be a child of ignored output/playwright/");
if (!args.get("--plan")) throw new Error("--plan is required");
const planText = await readFile(resolve(repo, args.get("--plan")!), "utf8");
const plan = parseMeasurementPlan(JSON.parse(planText));
const exploratory = args.has("--exploratory");
if (!exploratory && plan.status !== "frozen") throw new Error("Formal measurement requires a frozen plan; use --exploratory for draft positive controls");
const planSha256 = createHash("sha256").update(planText).digest("hex");
const productRoot = resolve(args.get("--product-root") ?? "missing");
if (!args.get("--product-root") || !args.get("--build-id")) throw new Error("Explicit product root and build id required");
const driverSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: productRoot, encoding: "utf8" }).trim();
const sourceDiffSha256 = createHash("sha256").update(execFileSync("git", ["diff", "HEAD", "--"], { cwd: productRoot })).digest("hex");
await mkdir(output, { recursive: true });
const clockPath = join(output, "batch-clock.json");
let batchClock: { startedEpochMs: number; planSha256: string; exploratory: boolean };
try { batchClock = JSON.parse(await readFile(clockPath, "utf8")); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; batchClock = { startedEpochMs: Date.now(), planSha256, exploratory }; await writeFile(clockPath, JSON.stringify(batchClock), { flag: "wx" }); }
if (batchClock.planSha256 !== planSha256 || batchClock.exploratory !== exploratory) throw new Error("Output batch already belongs to another plan/mode; use a new output directory");
async function treeBytes(path: string): Promise<number> {
  let total = 0;
  for (const item of await readdir(path, { withFileTypes: true })) { const full = join(path, item.name); if (item.isDirectory()) total += await treeBytes(full); else total += (await stat(full)).size; }
  return total;
}
async function budget() {
  const disk = await statfs(output);
  if (disk.bavail * disk.bsize < plan.minDiskFreeBytes) throw new Error("Free disk below plan minimum");
  if (Date.now() - batchClock.startedEpochMs > plan.maxBatchMs) throw new Error("Batch deadline exceeded");
  const bytes = await treeBytes(budgetRoot);
  if (bytes > plan.maxOutputBytes) throw new Error("Retained artifact budget exceeded");
  return { artifactScope: budgetRoot, freeDiskBytes: disk.bavail * disk.bsize, retainedBytes: bytes };
}
let selected = plan.runOrder.map((run, index) => ({ ...run, index }));
if (args.has("--run-index")) {
  const index = Number(args.get("--run-index"));
  if (!Number.isInteger(index) || index < 0 || index >= selected.length) throw new Error("Invalid --run-index (zero based)");
  selected = [selected[index]];
} else {
  if (args.has("--condition")) selected = selected.filter((run) => run.condition === args.get("--condition"));
  if (args.has("--mode")) selected = selected.filter((run) => run.mode === args.get("--mode"));
  if (exploratory) selected = selected.filter((run) => run.repeat === 1);
}
if (!selected.length) throw new Error("No selected planned run");
const warmupMs = exploratory ? Math.min(2000, plan.warmupMs) : plan.warmupMs;
const windowMs = exploratory ? Math.min(2000, plan.windowMs) : plan.windowMs;
const phaseMs = exploratory ? Math.min(2000, plan.lifecyclePhaseMs) : plan.lifecyclePhaseMs;
const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
type PageGlobals = Window & { __fpvMeasurementHardware: MeasurementHardwareControl; __fpvMeasurement?: { snapshot(): MeasurementResult["probe"]; mark(label: string): { timeMs: number } } };
const summaries: unknown[] = [];
const cdpSessions = new WeakMap<Page, CDPSession>();
const cdpTargets = new WeakMap<Page, unknown>();
const runnerStamp = () => ({ epochMs: Date.now(), monotonicMs: performance.now() });
const traceSettings = { method: "CDP Profiler", samplingIntervalMicroseconds: 1000, maxSamples: 50000, maxEncodedBytes: 8 * 1024 * 1024 };
let traceReceipt: unknown = null;
async function endTrace(page: Page, label: string) {
  const cdp = cdpSessions.get(page)!;
  const { profile } = await cdp.send("Profiler.stop");
  await cdp.send("Profiler.disable");
  const bytes = Buffer.from(JSON.stringify(profile));
  const truncated = bytes.length > traceSettings.maxEncodedBytes || (profile.samples?.length ?? 0) > traceSettings.maxSamples;
  const path = join(output, `${label}.cpuprofile.json.gz`);
  await writeFile(path, gzipSync(bytes.subarray(0, traceSettings.maxEncodedBytes)), {flag: "wx"});
  const positiveControl = !!profile.nodes.length && !!profile.samples?.length && profile.timeDeltas?.length === profile.samples.length && profile.endTime > profile.startTime;
  traceReceipt = { path, bytes: bytes.length, samples: profile.samples?.length, truncated, positiveControl, settings: traceSettings, overhead: "Diagnostic CPU sampling only, excluded from formal no-trace matrix. No exhaustive timeline/layout/GC attribution or peak-memory claim." };
  if (truncated || !positiveControl) throw new Error("CPU profile truncated or positive control missing");
}
async function cdpMetrics(page: Page) {
  const session = cdpSessions.get(page); if (!session) return { available: false, reason: "CDP Performance domain unavailable" };
  try {
    const calledBefore = runnerStamp();
    const result = await session.send("Performance.getMetrics");
    const calledAfter = runnerStamp();
    const names = ["Timestamp", "TaskDuration", "ScriptDuration", "LayoutDuration", "JSHeapUsedSize", "JSHeapTotalSize"];
    const metrics = Object.fromEntries(result.metrics.filter((metric) => names.includes(metric.name)).map((metric) => [metric.name, metric.value]));
    if (plan.maxHeapBytes !== null && metrics.JSHeapUsedSize > plan.maxHeapBytes) throw new Error("Observed renderer JS heap exceeded plan guard");
    return { available: true, metrics, calledBefore, calledAfter, target: cdpTargets.get(page), timeDomain: "timeTicks", method: "Performance.getMetrics", params: {} };
  } catch (error) {
    if (plan.maxHeapBytes !== null) throw error;
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
async function openInputs(page: Page) {
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "飞行工作台", exact: true }).click();
  const settings = page.locator(".video-setup-details");
  if (!await settings.evaluate((element) => (element as HTMLDetailsElement).open)) await settings.locator("summary").click();
}
async function snapshot(page: Page) {
  return page.evaluate(() => { const scope = window as unknown as PageGlobals; return { hardware: scope.__fpvMeasurementHardware.snapshot(), probe: scope.__fpvMeasurement?.snapshot() ?? null }; });
}
async function interval(page: Page, label: string, durationMs: number, steady: boolean, withDrain: boolean): Promise<MeasurementWindow> {
  const trace = args.has("--trace");
  if (trace) { const cdp = cdpSessions.get(page)!; await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", {interval: traceSettings.samplingIntervalMicroseconds}); await cdp.send("Profiler.start"); }
  const before = await cdpMetrics(page);
  const pageCallBefore = runnerStamp();
  const measured = await page.evaluate(async ({ label, durationMs, steady }) => {
    const scope = window as unknown as PageGlobals;
    const stamp = (suffix: string) => scope.__fpvMeasurement?.mark(`${label}:${suffix}`).timeMs ?? performance.now();
    const t0 = stamp("start");
    await new Promise((resolve) => window.setTimeout(resolve, durationMs));
    const t1 = stamp("end");
    return { label, t0, t1, steady };
  }, { label, durationMs, steady });
  const pageCallAfter = runnerStamp();
  const steadyEnd = await cdpMetrics(page);
  const drainCallBefore = runnerStamp();
  const drainEnd = measured.t1 + (withDrain ? plan.drainMs : 0);
  const actualDrainReturn = await page.evaluate(async ({ drainEnd, label }) => {
    const remaining = Math.max(0, drainEnd - performance.now());
    if (remaining) await new Promise((resolve) => window.setTimeout(resolve, remaining));
    const scope = window as unknown as PageGlobals;
    return scope.__fpvMeasurement?.mark(`${label}:drain_observer_returned`).timeMs ?? performance.now();
  }, { drainEnd, label });
  const drainCallAfter = runnerStamp();
  const after = await cdpMetrics(page);
  const deltas = before.metrics && after.metrics ? Object.fromEntries(["Timestamp", "TaskDuration", "ScriptDuration", "LayoutDuration"].map((name) => [name, after.metrics![name] - before.metrics![name]])) : null;
  if (trace) await endTrace(page, label);
  return { ...measured, drainEnd, cdp: { before, steadyEnd, after, deltas, pageCallBefore, pageCallAfter, drainCallBefore, drainCallAfter, actualDrainReturn, domain: "CDP timeTicks seconds; page and runner performance.now are different realms. Calls bracketed by runner epoch/monotonic timestamps. Endpoint boundaries are not simultaneous. Full includes live-source drain, never average subinterval percentages." } };
}
async function waitReal(page: Page, durationMs: number) { await page.evaluate((ms) => new Promise((resolve) => window.setTimeout(resolve, ms)), durationMs); }
async function verifyFiles(page: Page, session: Awaited<ReturnType<typeof readStoredTrainingRecords>>["sessions"][number]) {
  if (!session.video.recorded || !session.video.filename || !session.video.bytes) throw new Error("Session lacks closed nonempty video receipt");
  const evidence = await page.evaluate(async (receipt) => {
    const directory = await navigator.storage.getDirectory();
    const entries: Array<{ filename: string; bytes: number; json?: unknown }> = [];
    for await (const [filename, handle] of (directory as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries()) {
      if (handle.kind !== "file") continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      entries.push({ filename, bytes: file.size, ...(filename.endsWith(".json") ? { json: JSON.parse(await file.text()) } : {}) });
    }
    const file = await (await directory.getFileHandle(receipt.filename!)).getFile();
    const header = [...new Uint8Array(await file.slice(0, 12).arrayBuffer())];
    const video = document.createElement("video"), url = URL.createObjectURL(file);
    video.muted = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("Saved video decode timeout")), 8000);
        video.onloadeddata = () => { clearTimeout(timer); resolve(); };
        video.onerror = () => { clearTimeout(timer); reject(new Error("Saved video decode failed")); };
        video.src = url; video.load();
      });
      await video.play();
      return { entries, header, fileBytes: file.size, width: video.videoWidth, height: video.videoHeight, readyState: video.readyState };
    } finally { video.pause(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
  }, session.video);
  const container = evidence.header.slice(4, 8).join() === "102,116,121,112" ? "mp4" : evidence.header.slice(0, 4).join() === "26,69,223,163" ? "webm" : "unknown";
  if (container === "unknown" || !session.video.filename.endsWith(`.${container}`) || !session.video.mimeType?.startsWith(`video/${container}`) || evidence.fileBytes !== session.video.bytes || !evidence.width || !evidence.height) throw new Error("Saved container/receipt/playback mismatch");
  const exported = evidence.entries.find((entry) => (entry.json as { id?: string } | undefined)?.id === session.id)?.json;
  if (!exported || !isDeepStrictEqual((exported as typeof session).samples, session.samples) || !isDeepStrictEqual((exported as typeof session).video, session.video)) throw new Error("Closed JSON does not match committed Session and video receipt");
  return { ...evidence, container, jsonMatchesPersistedSamplesAndReceipt: true };
}
try {
  for (const planned of selected) {
    const resourcesBefore = await budget();
    const condition = plan.conditions.find((condition) => condition.id === planned.condition)!;
    const runId = `${exploratory ? "explore" : "formal"}-${String(planned.index).padStart(2, "0")}-${condition.id}-${planned.mode}-r${planned.repeat}`;
    const artifact = join(output, `${runId}.json.gz`);
    try { await stat(artifact); throw new Error(`Run artifact already exists: ${runId}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    console.log(`Starting ${runId}`);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, permissions: ["camera"] });
    const errors: string[] = [], networkViolations: unknown[] = [], networkCounts = { get: 0, head: 0 };
    const target = urls[planned.mode as MeasurementMode];
    const startedEpochMs = Date.now();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let page: Page | undefined;
    let finalSnapshot: Awaited<ReturnType<typeof snapshot>> | undefined;
    const windows: MeasurementWindow[] = [];
    let sessions: MeasurementResult["sessions"] = [], fileEvidence: unknown = null;
    let cleanup: Record<string, unknown> = { completed: false };
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (!["http:", "https:"].includes(url.protocol)) return route.continue();
      if (url.origin !== target || !["GET", "HEAD"].includes(request.method()) || request.postDataBuffer()?.length) {
        networkViolations.push({ url: `${url.origin}${url.pathname}`, method: request.method(), bytes: request.postDataBuffer()?.length ?? 0 });
        await route.abort("blockedbyclient"); await context.close(); return;
      }
      if (request.method() === "GET") networkCounts.get++; else networkCounts.head++;
      await route.continue();
    });
    context.on("response", (response) => { if (response.status() >= 400 && !response.url().endsWith("/favicon.ico")) errors.push(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`); });
    await context.addInitScript(({ mode, runId, maxEvents }) => {
      Object.assign(window, { __fpvMeasurementSetup: { mode: mode === "P0" ? "off" : "on", runId, maxEvents } });
    }, { mode: planned.mode, runId, maxEvents: plan.maxEvents });
    await context.addInitScript(installMeasurementHardware, { inputHz: condition.inputHz || 100, detailed: false, maxFrames: 30000, maxEvents: plan.maxEvents });
    try {
      await Promise.race([
        new Promise<never>((_, reject) => { deadline = setTimeout(() => { errors.push("run_deadline"); void context.close(); reject(new Error("Run deadline")); }, plan.maxRunMs); }),
        (async () => {
          page = await context.newPage();
          try { const cdp = await context.newCDPSession(page); await cdp.send("Performance.enable", { timeDomain: "timeTicks" }); cdpSessions.set(page, cdp); cdpTargets.set(page, await cdp.send("Target.getTargetInfo")); }
          catch (error) { if (plan.maxHeapBytes !== null) throw error; }
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`${target}/?analytics=off`);
          const dismiss = page.getByRole("button", { name: "关闭首次使用检查", exact: true });
          await expect(dismiss).toBeVisible({ timeout: 10000 });
          await dismiss.click();
          await page.getByRole("combobox", { name: "录制内容", exact: true }).selectOption(condition.scenario === "S2" ? "video" : "data");
          await page.getByRole("textbox", { name: "当前训练选手代号" }).fill("MEASURE-A");
          if (condition.scenario === "S3") {
            await openInputs(page);
            await page.getByRole("button", { name: "+ 独立输入", exact: true }).click();
            await page.getByRole("textbox", { name: "当前训练选手代号" }).fill("MEASURE-B");
            for (const [index, name] of [[1, "MEASURE-A"], [2, "MEASURE-B"]] as const) {
              const viewport = page.locator(`.video-viewport[data-source-id="video-source-${index}"]`);
              await viewport.getByRole("button", { name: `连接 ${name} 桥接飞控`, exact: true }).click();
              await expect(viewport.locator(".pilot-viewport-telemetry")).toHaveAttribute("data-telemetry-connection", "live");
            }
          } else if (condition.scenario !== "S0") {
            await page.getByRole("region", { name: "录制准备", exact: true }).getByRole("button", { name: /连接当前选手/ }).click();
            await expect(page.locator(".video-viewport.is-active .pilot-viewport-telemetry")).toHaveAttribute("data-telemetry-connection", "live");
          }
          if (condition.scenario === "S2") {
            const setup = page.getByRole("region", { name: "录制准备", exact: true });
            await setup.getByRole("button", { name: /打开当前输入/ }).click();
            await setup.getByRole("button", { name: /选择保存目录/ }).click();
            await expect(page.getByRole("button", { name: "● 开始记录", exact: true })).toBeEnabled();
            await page.getByRole("button", { name: "● 开始记录", exact: true }).click();
            await expect(page.getByRole("heading", { name: "正在记录 MEASURE-A", exact: true })).toBeVisible();
          }
          const handshake = (await snapshot(page)).probe;
          if (planned.mode === "N" && handshake !== null) throw new Error("Ordinary build exposed probe");
          if (planned.mode === "P0" && (!handshake || handshake.enabled || handshake.events.length)) throw new Error("P0 bridge not OFF");
          if (planned.mode === "P1" && (!handshake?.enabled || !handshake.events.some((event) => event.kind === "react.commit" && event.phase === "mount") || !handshake.events.some((event) => event.kind === "react.commit" && event.phase !== "mount"))) throw new Error("Genuine React Profiler mount/update positive control missing");
          await waitReal(page, warmupMs);
          if (["S0", "S1", "S2"].includes(condition.scenario)) {
            windows.push(await interval(page, "steady", windowMs, true, true));
            if (condition.scenario === "S2") {
              await expect(page.getByRole("heading", { name: "正在记录 MEASURE-A", exact: true })).toBeVisible();
              await page.getByRole("button", { name: "■ 结束记录", exact: true }).click();
              await expect(page.locator(".session-detail-header")).toContainText("已保存到本机", { timeout: 15000 });
              await expect.poll(async () => (await readStoredTrainingRecords(page!)).sessions.length).toBe(1);
              const persisted = await readStoredTrainingRecords(page);
              if (persisted.drafts.length) throw new Error("Final persisted draft remains after completed Session");
              sessions = persisted.sessions;
              fileEvidence = await verifyFiles(page, persisted.sessions[0]);
            }
          } else if (condition.scenario === "S3") {
            windows.push(await interval(page, "two_ports_active_B", phaseMs, false, false));
            await page.locator('.video-viewport[data-source-id="video-source-1"] .video-viewport-select').click();
            windows.push(await interval(page, "two_ports_select_A", phaseMs, false, false));
            await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "训练记录", exact: true }).click();
            windows.push(await interval(page, "two_ports_records_navigation", phaseMs, false, false));
            await openInputs(page);
            windows.push(await interval(page, "two_ports_return_workbench", phaseMs, false, true));
          } else {
            windows.push(await interval(page, "connected", phaseMs, false, false));
            await page.evaluate(() => (window as unknown as PageGlobals).__fpvMeasurementHardware.pause(1));
            windows.push(await interval(page, "source_paused", phaseMs, false, false));
            await page.evaluate(() => (window as unknown as PageGlobals).__fpvMeasurementHardware.resume(1));
            windows.push(await interval(page, "source_resumed", phaseMs, false, false));
            await page.getByRole("button", { name: "返回演示", exact: true }).click();
            windows.push(await interval(page, "returned_demo", phaseMs, false, false));
            await page.getByRole("region", { name: "录制准备", exact: true }).getByRole("button", { name: /连接当前选手/ }).click();
            await expect(page.locator(".video-viewport.is-active .pilot-viewport-telemetry")).toHaveAttribute("data-telemetry-connection", "live");
            await page.evaluate(() => (window as unknown as PageGlobals).__fpvMeasurementHardware.disconnect(2));
            windows.push(await interval(page, "source_disconnected", phaseMs, false, true));
          }
          await openInputs(page);
          const viewports = page.locator(".video-viewport");
          for (let i = 0; i < await viewports.count(); i++) {
            await viewports.nth(i).locator(".video-viewport-select").click();
            const demo = page.getByRole("button", { name: "返回演示", exact: true });
            if (await demo.isVisible()) await demo.click();
          }
          const disconnectVideo = page.getByRole("button", { name: "断开全部", exact: true });
          if (await disconnectVideo.isVisible() && await disconnectVideo.isEnabled()) await disconnectVideo.click();
          await expect.poll(async () => (await snapshot(page!)).hardware.ports.every((port) => !port.open && port.pendingReads === 0 && port.pendingWrites === 0), { timeout: 10000 }).toBe(true);
          finalSnapshot = await snapshot(page);
          cleanup = { completed: true, explicitDemoAndDisconnect: true, ports: finalSnapshot.hardware.ports, media: finalSnapshot.hardware.media, documentTeardown: "context.close after snapshot; not a React unmount callback claim" };
        })(),
      ]);
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    finally {
      if (deadline) clearTimeout(deadline);
      if (!finalSnapshot && page && !page.isClosed()) { try { finalSnapshot = await snapshot(page); } catch { errors.push("final_snapshot_unavailable"); } }
      const closeStarted = Date.now();
      await Promise.race([context.close(), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Context cleanup deadline")), 20000); timer.unref(); })]);
      cleanup.contextClosed = true; cleanup.contextCloseMs = Date.now() - closeStarted;
    }
    if (!finalSnapshot) {
      const failure = { runId, valid: false, exploratory, sourceSha, planSha256, errors, networkViolations, cleanup, windows, evidenceUnavailable: "Page snapshot could not be recovered; no zero-loss claim" };
      await writeFile(join(output, `${runId}.failure.json`), JSON.stringify(failure, null, 2), { flag: "wx" });
      summaries.push(failure); process.exitCode = 1; break;
    }
    const result: MeasurementResult = { runId, condition, mode: planned.mode, repeat: planned.repeat, exploratory, windows, ...finalSnapshot, sessions, errors, networkViolations,
      networkCounts, fileEvidence, cleanup, traceReceipt, driverSha, productRoot, servedBuildId: args.get("--build-id"), sourceSha, sourceDiffSha256, planSha256, startedEpochMs, endedEpochMs: Date.now(), resourcesBefore,
      browser: { version: browser.version(), headless: true, viewport: { width: 1440, height: 1100 }, gpuBackend: null, gpuUnavailableReason: "Not queried; no GPU performance claim" },
      inputClock: "real performance.now; demand-paced earliest response eligibility, not an independent unsolicited serial generator", detailedAvailable: false, commonFixtureOverhead: "Same bounded per-frame input table in N/P0/P1; detailed request/chunk events disabled in all modes" };
    const analysis = analyzeMeasurementRun(result);
    const raw = Buffer.from(JSON.stringify(result)), compressed = gzipSync(raw);
    const size = { rawBytes: raw.length, compressedBytes: compressed.length, snapshotPeakCaveat: "Raw JS snapshot, encoded Buffer and gzip coexist; byte counts are not a JS heap measurement" };
    if (raw.length > plan.maxTraceBytes) { analysis.valid = false; analysis.violations.push("encoded_snapshot_budget"); }
    if ((await treeBytes(budgetRoot)) + compressed.length > plan.maxOutputBytes) throw new Error("Compressed result would exceed retained artifact budget");
    await writeFile(artifact, compressed, { flag: "wx" });
    const receipt = { ...analysis, ...size, artifact: relative(repo, artifact), cleanup };
    await writeFile(join(output, `${runId}.summary.json`), JSON.stringify(receipt, null, 2), { flag: "wx" });
    summaries.push(receipt);
    console.log(`${runId}: ${analysis.valid ? "measurement complete" : "INVALID"}, raw=${raw.length}, gzip=${compressed.length}`);
    if (!analysis.valid) { process.exitCode = 1; break; }
  }
} finally { await browser.close(); }
await writeFile(join(output, `invocation-${Date.now()}.json`), JSON.stringify({ planSha256, sourceSha, exploratory, summaries }, null, 2));
await budget();
