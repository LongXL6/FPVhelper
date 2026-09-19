import type { Page } from "@playwright/test";
import { test, expect, readStoredTrainingRecords } from "./fixtures/fpv-hardware";
import { createDefaultVideoWorkspace, setVideoSourceLayout } from "../lib/video-workspace";

test.use({ seedPilotWorkspace: false });

async function addPilot(page: Page, name: string, picture = "完整画面", source = "video-source-1") {
  await page.getByRole("button", { name: "＋ 添加飞手", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加飞手", exact: true });
  await dialog.getByLabel("飞手名称", { exact: true }).fill(name);
  await dialog.getByLabel("画面来源", { exact: true }).selectOption(source);
  await dialog.getByRole("radio", { name: picture, exact: true }).check();
  await dialog.getByRole("button", { name: "添加飞手", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test("fresh setup, cancellation, incremental bindings and reload", async ({ page }) => {
  // Exercise a truly first-time user as well as the normal fixture environment.
  await page.addInitScript(() => localStorage.removeItem("fpvhelper.onboarding.v1"));
  await page.goto("/?analytics=off");
  await expect(page.getByRole("region", { name: "添加第一位飞手" })).toBeVisible();
  await expect(page.locator(".video-viewport")).toHaveCount(0);
  await page.getByRole("button", { name: "＋ 添加飞手", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加飞手", exact: true });
  await expect(dialog.getByRole("button", { name: "添加飞手", exact: true })).toBeDisabled();
  await dialog.getByLabel("飞手名称", { exact: true }).fill("Cancelled");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.locator(".video-viewport")).toHaveCount(0);

  await addPilot(page, "Alpha", "右下");
  await expect(page.locator(".video-viewport")).toHaveCount(1);
  await expect(page.locator(".video-viewport-select")).toContainText("Alpha");
  await addPilot(page, "Bravo", "左上");
  await expect(page.locator(".video-viewport")).toHaveCount(2);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("fpvhelper.video-workspace.v2")!));
  expect(saved.addedPilotChannelIds).toHaveLength(2);
  expect(saved.pilotChannels[0]).toMatchObject({ athleteCode: "Alpha", crop: { xPercent: 50, yPercent: 50, widthPercent: 50, heightPercent: 50 } });
  expect(saved.pilotChannels[1]).toMatchObject({ athleteCode: "Bravo", crop: { xPercent: 0, yPercent: 0, widthPercent: 50, heightPercent: 50 } });
  await page.reload();
  await expect(page.locator(".video-viewport")).toHaveCount(2);
  await expect(page.locator(".video-viewport.is-active .video-viewport-select")).toContainText("Bravo");
  await page.locator(".video-viewport-select").filter({ hasText: "Alpha" }).click();
  await expect(page.locator(".video-viewport.is-active .video-viewport-select")).toContainText("Alpha");
  await page.getByRole("button", { name: "打开画面", exact: true }).click();
  await expect(page.locator(".video-viewport.is-live")).toHaveCount(2);
  await expect(page.locator(".video-feed--cropped")).toHaveCount(2);
  await expect.poll(() => page.locator(".video-viewport").evaluateAll((tiles) => tiles.every((tile) => {
    const video = tile.querySelector("video")!;
    const canvas = tile.querySelector("canvas")!;
    return video.videoWidth > 0 && canvas.width === Math.round(video.videoWidth / 2) && canvas.height === Math.round(video.videoHeight / 2);
  }))).toBe(true);
});

test("recording locks pilot setup and preserves the selected pilot's session identity", async ({ page }) => {
  await page.goto("/?analytics=off");
  await addPilot(page, "Recorder");
  await page.getByRole("button", { name: /连接桥接飞控$/ }).click();
  const start = page.getByRole("button", { name: "● 开始记录", exact: true });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByRole("button", { name: "＋ 添加飞手", exact: true })).toBeDisabled();
  await expect(page.locator(".video-viewport-select")).toBeDisabled();
  await expect.poll(async () => (await page.evaluate(() => window.__fpvFakeSerial.rcResponses))).toBeGreaterThan(10);
  await page.getByRole("button", { name: "■ 结束记录", exact: true }).click();
  await expect.poll(async () => (await readStoredTrainingRecords(page)).sessions.length).toBe(1);
  expect((await readStoredTrainingRecords(page)).sessions[0].athleteCode).toBe("Recorder");
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "飞行工作台", exact: true }).click();
  await expect(page.getByRole("button", { name: "＋ 添加飞手", exact: true })).toBeEnabled();
});

test("mobile form fits and a new input creates only its explicitly added pilot", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?analytics=off");
  await addPilot(page, "Mobile Alpha");
  await addPilot(page, "Mobile Bravo", "左下", "new");
  await expect(page.locator(".video-viewport")).toHaveCount(2);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("fpvhelper.video-workspace.v2")!));
  expect(saved.sources).toHaveLength(2);
  expect(saved.addedPilotChannelIds).toHaveLength(2);
  expect(new Set(await page.locator(".video-viewport").evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute("data-source-id")))).size).toBe(2);
  await page.getByRole("button", { name: "＋ 添加飞手", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加飞手", exact: true });
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator(".video-viewport")).toHaveCount(2);
});

test("adding after hiding a legacy layout preserves saved pilots and connected channels", async ({ page }) => {
  const legacy = setVideoSourceLayout(createDefaultVideoWorkspace(), "video-source-1", "quad");
  delete legacy.addedPilotChannelIds;
  Object.assign(legacy.pilotChannels[1], { athleteCode: "Hidden", athleteCodeMode: "manual", gateProfileId: "saved-gate" });
  await page.addInitScript((workspace) => {
    if (!localStorage.getItem("fpvhelper.video-workspace.v2")) localStorage.setItem("fpvhelper.video-workspace.v2", JSON.stringify(workspace));
  }, legacy);
  await page.goto("/?analytics=off");
  await page.locator(".video-viewport-select").nth(2).click();
  await page.getByRole("button", { name: /连接桥接飞控$/ }).click();
  await expect(page.locator(".session-strip")).toContainText("RX 正常");
  await page.locator(".video-setup-details > summary").click();
  await page.getByRole("button", { name: "输入布局：完整画面", exact: true }).click();
  await expect(page.locator(".video-viewport")).toHaveCount(1);
  await addPilot(page, "New");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("fpvhelper.video-workspace.v2")!));
  expect(saved.activePilotChannelId).toBe(legacy.pilotChannels[3].id);
  expect(saved.pilotChannels[1]).toEqual(legacy.pilotChannels[1]);
  expect(saved.pilotChannels[2]).toEqual(legacy.pilotChannels[2]);
  expect(await page.evaluate(() => window.__fpvFakeSerial.closeCalls)).toBe(0);
  await expect(page.locator(".video-viewport")).toHaveCount(2);
  await page.getByRole("button", { name: "＋ 添加飞手", exact: true }).click();
  await page.getByRole("dialog", { name: "添加飞手", exact: true }).getByRole("button", { name: "恢复 Hidden", exact: true }).click();
  await expect(page.locator(".video-viewport")).toHaveCount(3);
  const restored = await page.evaluate(() => JSON.parse(localStorage.getItem("fpvhelper.video-workspace.v2")!));
  expect(restored.activePilotChannelId).toBe(legacy.pilotChannels[1].id);
  expect(restored.pilotChannels[1]).toEqual(legacy.pilotChannels[1]);
  await page.reload();
  await expect(page.locator(".video-viewport")).toHaveCount(3);
  await expect(page.locator(".video-viewport.is-active .video-viewport-select")).toContainText("Hidden");
});
