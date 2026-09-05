import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

const argument = process.argv[2];
const target = argument ? new URL(argument) : null;
if (!target || target.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
  || !target.port || target.username || target.password || target.pathname !== "/" || target.search || target.hash || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/smoke-vision-model.mjs http://localhost:<isolated-port> — starts real model asset GET requests; never point it at an active training server");
}
const baseURL = target.origin;
const directory = fileURLToPath(new URL("../output/playwright/vision-model-smoke/", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`../e2e/fixtures/${name}`, import.meta.url));
const output = (name) => `${directory}${name}`;
const safeURL = (value) => { const url = new URL(value); return `${url.origin}${url.pathname}`; };
const isExternal = (request) => new URL(request.url).origin !== baseURL;
await mkdir(directory, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const network = [];
const failures = [];
const httpErrors = [];
const errors = [];
const consoleErrors = [];
context.on("request", (request) => {
  if (/^https?:/.test(request.url())) network.push({ method: request.method(), url: safeURL(request.url()), postBytes: request.postDataBuffer()?.byteLength ?? 0 });
});
context.on("requestfailed", (request) => failures.push({ url: safeURL(request.url()), failure: request.failure()?.errorText }));
context.on("response", (response) => { if (response.status() >= 400) httpErrors.push({ url: safeURL(response.url()), status: response.status() }); });
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });

function checkRuntimeFailures() {
  if (network.some((request) => !["GET", "HEAD"].includes(request.method) || request.postBytes > 0)) throw new Error("Unexpected network write/upload request");
  if (failures.length || httpErrors.length || errors.length || consoleErrors.length) throw new Error(`Browser/model runtime failure: ${JSON.stringify({ failures, httpErrors, errors, consoleErrors })}`);
}

// Observe the real worker; no model messages, images, network resources, or inference results are mocked.
await page.addInitScript(() => {
  window.__visionRealModelQA = { workers: [], requests: [], replies: [] };
  const OriginalWorker = window.Worker;
  window.Worker = class extends OriginalWorker {
    constructor(...args) {
      super(...args);
      this.qaRecord = { url: String(args[0]), model: false, terminated: false };
      window.__visionRealModelQA.workers.push(this.qaRecord);
      this.addEventListener("message", (event) => {
        if (event.data?.context?.runId && event.data.type !== "progress") window.__visionRealModelQA.replies.push(event.data);
      });
    }
    postMessage(message, transfer) {
      if (message?.context?.runId) {
        this.qaRecord.model = true;
        window.__visionRealModelQA.requests.push({ type: message.type, requestId: message.requestId, context: message.context, frameTimeMs: message.frameTimeMs });
      }
      return super.postMessage(message, transfer);
    }
    terminate() { this.qaRecord.terminated = true; return super.terminate(); }
  };
});

try {
  await page.goto(`${baseURL}/vision-lab/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await expect(page.getByRole("heading", { level: 1, name: "从一段录像，开始过门复盘。" })).toBeVisible({ timeout: 60_000 });
  await page.getByLabel("导入本地录像文件").setInputFiles(fixture("vision-synthetic-two-scenes.mp4"));
  await expect(page.getByLabel("导入计时门照片")).toBeEnabled({ timeout: 30_000 });
  await page.getByLabel("导入计时门照片").setInputFiles(fixture("vision-synthetic-reference.png"));
  await expect(page.getByLabel("计时门名称", { exact: true })).toBeEnabled();
  await page.getByLabel("计时门名称", { exact: true }).fill("SYNTHETIC MODEL EXECUTION QA");
  for (const [label, value] of [["门框左百分比", "0"], ["门框上百分比", "0"], ["门框宽百分比", "100"], ["门框高百分比", "100"]]) await page.getByLabel(label).fill(value);
  await page.getByLabel("开始（秒）").fill("0");
  await page.getByLabel("结束（秒）").fill("4");
  await page.getByText("分析设置", { exact: true }).click();
  await page.getByLabel("采样密度").selectOption("2");
  await page.getByRole("slider", { name: "相似度阈值", exact: true }).fill("0");
  const beforeStartRemote = network.filter(isExternal);
  if (beforeStartRemote.length) throw new Error("External resources were requested before explicit analysis");
  checkRuntimeFailures();
  await expect(page.getByRole("button", { name: "开始分析", exact: true })).toBeEnabled();
  console.log(JSON.stringify({ stage: "prepared", source: "Synthetic PNG and four-second MP4; actual model asset GETs follow; not FPV accuracy testing", baseURL }));
  await page.getByRole("button", { name: "开始分析", exact: true }).click();
  const deadline = Date.now() + 230_000;
  let done = false;
  while (Date.now() < deadline) {
    await page.waitForFunction(() => window.__visionRealModelQA.replies.some((value) => value.type === "error")
      || window.__visionRealModelQA.replies.filter((value) => value.type === "result").length >= 8
      || Boolean(document.querySelector('[role="alert"]')), undefined, { timeout: 10_000 }).catch(() => {});
    checkRuntimeFailures();
    const status = await page.evaluate(() => ({
      ready: window.__visionRealModelQA.replies.some((value) => value.type === "ready"),
      results: window.__visionRealModelQA.replies.filter((value) => value.type === "result").length,
      workerErrors: window.__visionRealModelQA.replies.filter((value) => value.type === "error"),
      alerts: [...document.querySelectorAll('[role="alert"]')].map((item) => item.textContent),
    }));
    console.log(JSON.stringify({ stage: "analyzing", ...status }));
    if (status.workerErrors.length || status.alerts.length) throw new Error(`Application/model failure: ${JSON.stringify(status)}`);
    if (status.results >= 8) { done = true; break; }
  }
  if (!done) throw new Error("Real browser inference exceeded the bounded QA window");
  await expect(page.getByText("分析已完成", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "重新分析", exact: true })).toBeEnabled({ timeout: 30_000 });
  const captured = await page.evaluate(() => window.__visionRealModelQA);
  const modelWorkers = captured.workers.filter((worker) => worker.model);
  if (modelWorkers.length !== 1 || modelWorkers.some((worker) => !worker.terminated)) throw new Error("The completed model worker was not released");
  const manifest = captured.replies.find((value) => value.type === "ready")?.manifest;
  const expectedContext = captured.requests.find((request) => request.type === "load")?.context;
  if (!expectedContext || captured.replies.some((reply) => reply.context.runId !== expectedContext.runId || reply.context.generation !== expectedContext.generation)) throw new Error("Stale or mismatched worker context");
  if (manifest?.backend !== "wasm" || manifest?.id !== "Xenova/dinov2-small" || manifest?.dtype !== "q8"
    || !/^[a-f0-9]{40}$/.test(manifest.revision) || !/^[a-f0-9]{64}$/.test(manifest.weightsSha256)) throw new Error("Unexpected real model/backend/provenance");
  const results = captured.replies.filter((value) => value.type === "result").map((value) => value.result);
  if (results.length !== 8 || results.some((result, index) => result.frameTimeMs !== index * 500 || result.modelId !== manifest.id || result.modelRevision !== manifest.revision
    || !Number.isFinite(result.inferenceMs) || result.inferenceMs <= 0 || result.candidates.some((candidate) => !Number.isFinite(candidate.similarity) || candidate.similarity < -1 || candidate.similarity > 1))) throw new Error("Invalid inference result, cosine, or source sample time");
  const sceneA = results[0].candidates[0]?.similarity;
  const sceneB = results[5].candidates[0]?.similarity;
  if (!Number.isFinite(sceneA) || !Number.isFinite(sceneB) || Math.abs(sceneA - sceneB) < 0.001) throw new Error("Different synthetic scenes did not produce measurable real model differences");
  const external = network.filter(isExternal);
  if (!external.some((request) => request.url.includes(`/resolve/${manifest.revision}/onnx/model_quantized.onnx`))
    || !external.some((request) => request.url.endsWith(".wasm"))) throw new Error("Expected actual pinned ONNX/WASM resource downloads were not observed");
  const storedRun = await page.evaluate((runId) => new Promise((resolve, reject) => {
    const opened = indexedDB.open("fpvhelper-vision-lab", 1);
    opened.onerror = () => reject(new Error("Unable to inspect the persisted smoke run"));
    opened.onsuccess = () => {
      const database = opened.result;
      const transaction = database.transaction("runs", "readonly");
      const request = transaction.objectStore("runs").get(runId);
      transaction.oncomplete = () => { database.close(); resolve(request.result); };
      transaction.onabort = () => { database.close(); reject(new Error("Smoke run read was aborted")); };
    };
  }), expectedContext.runId);
  if (!storedRun || storedRun.state !== "complete" || storedRun.analyzedFrames !== 8 || storedRun.timestampSource !== "video_seek_position"
    || storedRun.reviews.length !== 0 || !storedRun.candidates.length || storedRun.candidates.some((candidate) => "status" in candidate)) throw new Error("Model candidates were not persisted as unreviewed observations");
  await expect(page.getByRole("complementary", { name: "穿越候选复核" }).getByText("待复核", { exact: true })).toHaveCount(storedRun.candidates.length);
  await expect(page.getByRole("region", { name: "圈速结果" })).toContainText(/已复核区间\s*0\s*圈/);
  checkRuntimeFailures();
  await page.screenshot({ path: output("browser-real-model.png"), fullPage: true });
  const report = { source: "Synthetic inputs, actual app worker and fixed ONNX q8 weights; browser WASM; no FPV accuracy claim", manifest, sceneA, sceneB, captured, storedRun, external, failures, httpErrors, errors, consoleErrors };
  await writeFile(output("browser-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ stage: "passed", output: output("browser-report.json"), frames: results.length, pendingCandidates: storedRun.candidates.length, sceneA, sceneB, externalRequests: external.length, workersTerminated: modelWorkers.length }));
} catch (error) {
  const state = await page.evaluate(() => ({ qa: window.__visionRealModelQA, body: document.body.innerText })).catch(() => null);
  await writeFile(output("browser-failure.json"), JSON.stringify({ message: String(error), state, network, failures, httpErrors, errors, consoleErrors }, null, 2));
  console.error(String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
}
