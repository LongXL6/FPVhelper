import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { VisionTimingRun } from "../lib/vision-lab-types";

// Generated geometric artwork, H.264 640×360, 30 fps, four seconds; no user footage.
// These imported events exercise review and persistence, not model accuracy.
const videoPath = resolve("e2e/fixtures/vision-synthetic-two-scenes.mp4");
const videoBytes = readFileSync(videoPath);
const videoSha256 = createHash("sha256").update(videoBytes).digest("hex");

function importedRun(id: string): VisionTimingRun {
  return {
    schemaVersion: 1,
    pipelineVersion: "reference-motion-v1",
    timestampSource: "video_seek_position",
    provenance: "imported",
    id,
    createdAt: "2026-09-05T10:00:00.000Z",
    profile: {
      schemaVersion: 1, id: "synthetic-gate", revision: 1, name: "合成门复核测试",
      imageSha256: "a".repeat(64), rect: { x: 0, y: 0, width: 1, height: 1 },
      createdAt: "2026-09-05T10:00:00.000Z",
    },
    video: {
      name: "vision-synthetic-two-scenes.mp4", size: videoBytes.byteLength,
      lastModified: 0, sha256: videoSha256, durationMs: 4_000, width: 640, height: 360,
    },
    settings: { crop: "full", fromMs: 0, toMs: 4_000, sampleFps: 5, similarityThreshold: 0.65 },
    model: { id: "synthetic-review-fixture", revision: "e2e-v1", weightsSha256: "b".repeat(64), backend: "imported-fixture" },
    state: "complete",
    analyzedUntilMs: 4_000,
    analyzedFrames: 20,
    candidates: [500, 1_500, 3_000].map((timeMs, index) => ({
      id: `candidate-${index + 1}`, timeMs, startMs: timeMs - 100, endMs: timeMs + 100,
      similarity: 0.8, box: { x: 0.25, y: 0.2, width: 0.5, height: 0.6 },
      reason: "合成复核事件；不代表真实模型检测",
    })),
    reviews: [],
    gaps: [],
  };
}

async function openImportedRun(page: Page, run: VisionTimingRun) {
  await page.goto("/vision-lab");
  await page.getByLabel("导入视觉分析记录", { exact: true }).setInputFiles({
    name: "synthetic-vision-run.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(run)),
  });
  await expect(page.getByText("导入记录，未经本机重新分析。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "全部 3", exact: true })).toBeVisible();
}

function eventButton(page: Page, time: string) {
  return page.getByRole("complementary", { name: "穿越候选复核", exact: true })
    .getByRole("button", { name: new RegExp(`^${time.replaceAll(".", "\\.")}`) });
}

function reviewEditor(page: Page) {
  return page.locator('[aria-label="复核选中事件"]');
}

async function matchOriginalVideo(page: Page) {
  await page.getByLabel("导入本地录像文件", { exact: true }).setInputFiles(videoPath);
  await expect(page.getByRole("status").filter({ hasText: "已通过完整文件 SHA-256 核对" })).toBeVisible();
  await expect.poll(() => page.locator("video").evaluate((video) => video instanceof HTMLVideoElement ? video.readyState : 0)).toBeGreaterThanOrEqual(2);
}

async function review(page: Page, time: string, action: "confirm" | "reject", reason: string) {
  await eventButton(page, time).click();
  const editor = reviewEditor(page);
  await editor.getByRole("textbox", { name: /复核理由/ }).fill(reason);
  await editor.getByRole("button", { name: action === "confirm" ? "确认穿越" : "排除", exact: true }).click();
  await expect(eventButton(page, time)).toContainText(action === "confirm" ? "人工确认" : "已排除");
  await expect(page.getByRole("status").filter({ hasText: "复核已保存" })).toBeVisible();
}

async function exportJson(page: Page, info: TestInfo, outputName: string) {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("region", { name: "圈速结果", exact: true }).getByRole("button", { name: "JSON", exact: true }).click();
  const download = await downloadPromise;
  const path = info.outputPath(outputName);
  await download.saveAs(path);
  expect(await download.failure()).toBeNull();
  const bytes = await readFile(path);
  return { filename: download.suggestedFilename(), path, bytes, run: JSON.parse(bytes.toString()) as VisionTimingRun };
}

test.describe("local vision review without a remote model", () => {
  test("reviews imported candidates, recalculates laps, and preserves repeated JSON snapshots", async ({ page }, info) => {
    const externalRequests: string[] = [];
    await page.route("https://**/*", (route) => { externalRequests.push(route.request().url()); return route.abort(); });
    const run = importedRun("vision-review-workflow");
    await openImportedRun(page, run);
    await matchOriginalVideo(page);
    await expect(page.getByRole("button", { name: "待复核 3", exact: true })).toBeVisible();

    await review(page, "00:00.500", "confirm", "合成流程：确认起点");
    await review(page, "00:03.000", "confirm", "合成流程：确认终点");
    const results = page.getByRole("region", { name: "圈速结果", exact: true });
    const lap = results.getByRole("row").filter({ hasText: "00:02.500" });
    await expect(lap).toContainText("不完整");
    await expect(lap).toContainText("区间内还有待复核候选");

    await review(page, "00:01.500", "reject", "合成流程：排除途中相似画面");
    await expect(lap).toContainText("已复核");
    await expect(lap).not.toContainText("不完整");

    await eventButton(page, "00:03.000").click();
    const editor = reviewEditor(page);
    await editor.getByRole("spinbutton", { name: "穿越时刻（秒）", exact: true }).fill("3.200");
    await editor.getByRole("textbox", { name: /复核理由/ }).fill("合成流程：修正终点为 3.2 秒");
    await expect(editor.getByRole("button", { name: "确认穿越", exact: true })).toBeDisabled();
    await editor.getByRole("button", { name: "改时刻并确认", exact: true }).click();
    await expect(eventButton(page, "00:03.200")).toContainText("人工确认");
    await expect(results.getByRole("row").filter({ hasText: "00:02.700" })).toContainText("已复核");
    await expect(page.getByRole("button", { name: "待复核 0", exact: true })).toBeVisible();

    const first = await exportJson(page, info, "first-vision-snapshot.json");
    const second = await exportJson(page, info, "second-vision-snapshot.json");
    expect(first.filename).toMatch(/\.json$/);
    expect(second.filename).not.toBe(first.filename);
    expect(second.bytes).toEqual(first.bytes);
    expect(await readFile(first.path)).toEqual(first.bytes);
    expect(second.run.provenance).toBe("imported");
    expect(second.run.candidates).toEqual(run.candidates);
    expect(second.run.reviews.map(({ action, timeMs, reason }) => ({ action, timeMs, reason }))).toEqual([
      { action: "confirm", timeMs: 500, reason: "合成流程：确认起点" },
      { action: "confirm", timeMs: 3_000, reason: "合成流程：确认终点" },
      { action: "reject", timeMs: 1_500, reason: "合成流程：排除途中相似画面" },
      { action: "adjust", timeMs: 3_200, reason: "合成流程：修正终点为 3.2 秒" },
    ]);
    expect(externalRequests).toEqual([]);
  });

  test("restores review history but requires the original video hash before more review", async ({ page }) => {
    const externalRequests: string[] = [];
    await page.route("https://**/*", (route) => { externalRequests.push(route.request().url()); return route.abort(); });
    const run = importedRun("vision-review-reload");
    await openImportedRun(page, run);
    await matchOriginalVideo(page);
    await review(page, "00:00.500", "confirm", "合成流程：刷新前保存起点");

    await page.reload();
    const restore = page.getByRole("combobox", { name: "恢复分析记录", exact: true });
    await expect(restore.locator(`option[value="${run.id}"]`)).toHaveCount(1);
    await restore.selectOption(run.id);
    await expect(eventButton(page, "00:00.500")).toContainText("人工确认");
    await eventButton(page, "00:03.000").click();
    await expect(reviewEditor(page).getByRole("textbox", { name: /复核理由/ })).toBeDisabled();
    await expect(reviewEditor(page).getByRole("button", { name: "确认穿越", exact: true })).toBeDisabled();

    // A valid MP4 with an inert trailing payload still decodes, but its complete SHA differs.
    await page.getByLabel("导入本地录像文件", { exact: true }).setInputFiles({
      name: run.video.name, mimeType: "video/mp4", buffer: Buffer.concat([videoBytes, Buffer.from("different-e2e-video-content")]),
    });
    await expect(page.getByRole("status").filter({ hasText: "录像仅在本机读取" })).toBeVisible();
    await restore.selectOption(run.id);
    await expect(page.getByRole("status").filter({ hasText: "完整文件哈希匹配后才能复核" })).toBeVisible();
    await eventButton(page, "00:03.000").click();
    await expect(reviewEditor(page).getByRole("textbox", { name: /复核理由/ })).toBeDisabled();

    await matchOriginalVideo(page);
    await expect(reviewEditor(page).getByRole("textbox", { name: /复核理由/ })).toBeEnabled();
    await review(page, "00:03.000", "confirm", "合成流程：哈希匹配后继续复核");
    await expect(eventButton(page, "00:00.500")).toContainText("人工确认");
    expect(externalRequests).toEqual([]);
  });
});
