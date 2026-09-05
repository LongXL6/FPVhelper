import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { chromium, expect } from "@playwright/test";

const argument = process.argv[2];
const target = argument ? new URL(argument) : null;
if (!target || target.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
  || !target.port || target.username || target.password || target.pathname !== "/" || target.search || target.hash || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/smoke-live-vision.mjs http://localhost:<isolated-port> — synthetic camera, real model asset GETs; never use an active training server");
}
const baseURL = target.origin;
const directory = fileURLToPath(new URL("../output/playwright/live-vision-smoke/", import.meta.url));
await mkdir(directory, { recursive: true });
const output = (name) => `${directory}${name}`;
const safeURL = (value) => { const url = new URL(value); return `${url.origin}${url.pathname}`; };
const browser = await chromium.launch({ ...(process.env.FPV_VISION_SMOKE_BROWSER === "chromium" ? { channel: "chromium" } : {}), args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, permissions: ["camera"] });
const page = await context.newPage();
const requests = [];
const failures = [];
const errors = [];
const nonBlocking = [];
context.on("request", (request) => {
  if (/^https?:/.test(request.url())) requests.push({ url: safeURL(request.url()), method: request.method(), postBytes: request.postDataBuffer()?.byteLength ?? 0 });
});
context.on("requestfailed", (request) => failures.push({ url: safeURL(request.url()), failure: request.failure()?.errorText }));
context.on("response", (response) => { if (response.status() >= 400) failures.push({ url: safeURL(response.url()), status: response.status() }); });
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() !== "error") return;
  const location = message.location().url;
  // Full Chromium requests an optional favicon outside the page request events.
  if (location === `${baseURL}/favicon.ico` && message.text().includes("404")) nonBlocking.push({ url: location, message: message.text() });
  else if (message.text().includes("[W:onnxruntime:") && message.text().includes("VerifyEachNodeIsAssignedToAnEp]")) nonBlocking.push({ url: location, message: message.text() });
  else errors.push(`${message.text()} (${location})`);
});
await page.addInitScript(() => {
  localStorage.setItem("fpvhelper.onboarding.v1", "acknowledged");
  window.__liveVisionQA = { cameraRequests: 0, tracks: [], workers: [], requests: [], replies: [] };
  const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (...args) => {
    window.__liveVisionQA.cameraRequests += 1;
    const stream = await getUserMedia(...args);
    window.__liveVisionQA.tracks.push(...stream.getVideoTracks());
    return stream;
  };
  const OriginalWorker = window.Worker;
  window.Worker = class extends OriginalWorker {
    constructor(...args) {
      super(...args);
      this.qaRecord = { model: false, terminated: false };
      window.__liveVisionQA.workers.push(this.qaRecord);
      this.addEventListener("message", (event) => {
        if (event.data?.context?.runId && event.data.type !== "progress") window.__liveVisionQA.replies.push(event.data);
      });
    }
    postMessage(message, transfer) {
      if (message?.context?.runId) {
        this.qaRecord.model = true;
        window.__liveVisionQA.requests.push({ type: message.type, context: message.context, frameTimeMs: message.frameTimeMs });
      }
      return super.postMessage(message, transfer);
    }
    terminate() { this.qaRecord.terminated = true; return super.terminate(); }
  };
});
function checkFailures() {
  if (requests.some((request) => !["GET", "HEAD"].includes(request.method) || request.postBytes > 0)) throw new Error("Unexpected network write/upload");
  if (failures.length || errors.length) throw new Error(`Runtime failure: ${JSON.stringify({ failures, errors })}`);
}
try {
  await page.goto(baseURL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const panel = page.getByRole("region", { name: "实时过门计时", exact: true });
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "打开画面", exact: true }).click();
  await expect(page.getByText("1/1 路 UVC 在线", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "当前训练选手代号", exact: true }).fill("SYNTHETIC-LIVE");
  await page.getByRole("textbox", { name: "当前训练选手代号", exact: true }).blur();
  await panel.locator("summary").filter({ hasText: "配置新的计时门" }).click();
  await panel.getByRole("button", { name: "截取当前取景", exact: true }).click();
  await expect(panel.getByLabel("门框宽百分比")).toBeVisible();
  await panel.getByLabel("计时门名称", { exact: true }).fill("SYNTHETIC LIVE CAMERA QA");
  await panel.getByRole("button", { name: "保存并绑定计时门", exact: true }).click();
  const start = panel.getByRole("button", { name: "开始过门计时", exact: true });
  await expect(start).toBeEnabled();
  const baselineCameraRequests = await page.evaluate(() => window.__liveVisionQA.cameraRequests);
  if (baselineCameraRequests < 1 || requests.some((request) => new URL(request.url).origin !== baseURL)) throw new Error("Unexpected preparation network or camera state");
  checkFailures();
  console.log(JSON.stringify({ stage: "prepared", source: "Chromium synthetic camera; real shared stream, real model Worker with automatic GPU / WASM selection; no FPV accuracy claim", baseURL }));
  await start.click();
  const deadline = Date.now() + 230_000;
  let complete = false;
  while (Date.now() < deadline) {
    await page.waitForFunction(() => window.__liveVisionQA.replies.filter((reply) => reply.type === "result").length >= 8
      || window.__liveVisionQA.replies.some((reply) => reply.type === "error")
      || Boolean(document.querySelector('[aria-label="实时过门计时"] [role="alert"]')), undefined, { timeout: 10_000 }).catch(() => {});
    checkFailures();
    const status = await page.evaluate(() => ({
      frames: window.__liveVisionQA.replies.filter((reply) => reply.type === "result").length,
      workerErrors: window.__liveVisionQA.replies.filter((reply) => reply.type === "error"),
      alerts: [...document.querySelectorAll('[aria-label="实时过门计时"] [role="alert"]')].map((element) => element.textContent),
    }));
    console.log(JSON.stringify({ stage: "monitoring", ...status }));
    if (status.workerErrors.length || status.alerts.length) throw new Error(`Live model failure: ${JSON.stringify(status)}`);
    if (status.frames >= 8) { complete = true; break; }
  }
  if (!complete) throw new Error("Real live inference exceeded the bounded QA window");
  await panel.getByRole("button", { name: "停止过门计时", exact: true }).click();
  await expect(panel).toHaveAttribute("data-state", "stopped", { timeout: 30_000 });
  const captured = await page.evaluate(() => ({
    ...window.__liveVisionQA,
    tracks: window.__liveVisionQA.tracks.map((track) => ({ id: track.id, state: track.readyState })),
  }));
  if (captured.cameraRequests !== baselineCameraRequests || captured.tracks.some((track) => track.state !== "live")) throw new Error("Live timing reacquired or stopped the shared camera");
  const modelWorkers = captured.workers.filter((worker) => worker.model);
  if (modelWorkers.length !== 1 || modelWorkers.some((worker) => !worker.terminated)) throw new Error("Live model worker was not released");
  const manifest = captured.replies.find((reply) => reply.type === "ready")?.manifest;
  const inference = captured.replies.filter((reply) => reply.type === "result").map((reply) => reply.result);
  if (manifest?.id !== "Xenova/dinov2-small" || !["wasm", "webgpu"].includes(manifest?.backend) || inference.length < 8
    || inference.some((result) => !Number.isFinite(result.inferenceMs) || result.inferenceMs <= 0)) throw new Error("Expected real live model results");
  if (process.env.FPV_VISION_SMOKE_EXPECT_BACKEND && manifest.backend !== process.env.FPV_VISION_SMOKE_EXPECT_BACKEND) throw new Error(`Expected ${process.env.FPV_VISION_SMOKE_EXPECT_BACKEND}, got ${manifest.backend}`);
  if (inference.some((result) => !result.diagnostics || result.diagnostics.modelMs <= 0 || !result.diagnostics.bestMatch)) throw new Error("Missing real per-frame model diagnostics");
  await expect(panel.getByTestId("live-analysis-fps")).not.toHaveText("—");
  await expect(panel.locator('canvas[aria-label="最近分析画面"]')).toHaveJSProperty("width", 448);
  const downloadPromise = page.waitForEvent("download");
  await panel.getByRole("region", { name: "实时圈速与记录", exact: true }).getByRole("button", { name: "JSON", exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs(output("live-run.json"));
  if (await download.failure()) throw new Error("Live JSON download failed");
  const run = JSON.parse(await readFile(output("live-run.json"), "utf8"));
  if (run.kind !== "fpvhelper-live-vision" || run.state !== "stopped" || run.clock.kind !== "host_presentation_estimate"
    || run.observations.length < 8 || run.reviews.length !== 0 || "video" in run) throw new Error("Live result identity, clock or candidate review boundary is invalid");
  if (run.pipelineVersion !== "reference-motion-v2" || run.settings.sampleFps !== 30 || run.model.backend !== manifest.backend || run.model.weightsSha256 !== manifest.weightsSha256) throw new Error("Model provenance or high-rate settings mismatch");
  if (run.observations.some((observation, index) => observation.timeMs < 0 || (index && observation.timeMs <= run.observations[index - 1].timeMs))) throw new Error("Non-monotonic live source timestamps");
  const savedRun = await page.evaluate((id) => new Promise((resolve, reject) => {
    const open = indexedDB.open("fpvhelper-live-vision", 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("runs", "readonly");
      const request = tx.objectStore("runs").get(id);
      tx.oncomplete = () => { db.close(); resolve(request.result); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), run.id);
  if (!isDeepStrictEqual(savedRun, run)) throw new Error("Export and persisted live run differ");
  checkFailures();
  const preview = panel.locator('canvas[aria-label="最近分析画面"]');
  await preview.scrollIntoViewIfNeeded();
  const painted = await preview.evaluate((canvas) => {
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some((value, index) => index % 4 === 3 && value > 0);
  });
  if (!painted) throw new Error("Diagnostic preview has no painted pixels after stop and export");
  await panel.getByRole("region", { name: "本机识别诊断", exact: true }).screenshot({ path: output("browser-real-live-model.png") });
  const report = { source: "Synthetic camera; actual shared stream and real fixed model; no FPV accuracy or physical timing claim", manifest, captured, run, external: requests.filter((request) => new URL(request.url).origin !== baseURL), failures, errors, nonBlocking };
  await writeFile(output("browser-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ stage: "passed", frames: run.observations.length, pendingCandidates: run.candidates.length, cameraRequests: captured.cameraRequests, tracksRetained: captured.tracks.length, output: output("browser-report.json") }));
} catch (error) {
  const state = await page.evaluate(() => ({ body: document.body.innerText, replies: window.__liveVisionQA?.replies })).catch(() => null);
  await writeFile(output("browser-failure.json"), JSON.stringify({ message: String(error), state, requests, failures, errors }, null, 2));
  console.error(String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
}
