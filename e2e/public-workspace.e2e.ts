import { expect, readStoredTrainingRecords, test } from "./fixtures/fpv-hardware";

test("ordinary workspaces leave vision storage unopened until experiments are explicitly opened", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?analytics=off");
  const navigation = page.getByRole("navigation", { name: "主导航" });
  await expect(navigation.getByRole("button")).toHaveCount(3);
  await expect(navigation.getByRole("link")).toHaveCount(0);
  await expect(page.locator("#live-gate-panel")).toHaveCount(0);
  await expect(page.locator(".telemetry-rail")).toHaveCount(0);
  const visionDatabases = () => page.evaluate(async () => (await indexedDB.databases())
    .map((database) => database.name).filter((name) => name?.includes("vision")).sort());
  await navigation.getByRole("button", { name: "训练记录", exact: true }).click();
  await navigation.getByRole("button", { name: "工作站设置", exact: true }).click();
  await expect(page.getByRole("link", { name: "录像视觉实验台", exact: true })).toHaveAttribute("href", "/vision-lab");
  expect(await visionDatabases()).toEqual([]);
  await page.getByRole("button", { name: "实时过门实验", exact: true }).click();
  await expect(page.getByRole("region", { name: "实时过门计时", exact: true })).toBeVisible();
  await expect.poll(visionDatabases).toEqual(["fpvhelper-live-vision", "fpvhelper-vision-lab"]);
  await page.getByRole("button", { name: "回到工作台", exact: true }).click();
  await expect(page.locator("#live-gate-panel")).toBeHidden();
  await expect(page.getByRole("heading", { name: /^飞行工作台/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("collapsing detailed telemetry preserves the serial connection and recorded samples", async ({ page }) => {
  await page.goto("/?analytics=off");
  await page.getByRole("textbox", { name: "当前训练选手代号", exact: true }).fill("DETAILS-COLLAPSE");
  await page.getByRole("button", { name: "连接桥接飞控" }).click();
  await page.getByRole("button", { name: "● 开始记录", exact: true }).click();
  const summary = page.locator(".telemetry-disclosure > summary");
  await summary.click();
  await expect(page.locator(".source-badge")).toHaveText("GROUND_RC");
  await expect(page.locator(".timeline-plot")).toBeVisible();
  await expect.poll(async () => (await readStoredTrainingRecords(page)).drafts[0]?.samples.length ?? 0).toBeGreaterThan(0);
  const before = (await readStoredTrainingRecords(page)).drafts[0].samples.length;
  await summary.click();
  await expect(page.locator(".telemetry-rail")).toHaveCount(0);
  await expect(page.locator(".timeline-plot")).toHaveCount(0);
  await expect.poll(async () => (await readStoredTrainingRecords(page)).drafts[0]?.samples.length ?? 0).toBeGreaterThan(before);
  expect(await page.evaluate(() => window.__fpvFakeSerial.closeCalls)).toBe(0);
  await expect(page.getByRole("button", { name: "■ 结束记录", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "■ 结束记录", exact: true }).click();
  await expect.poll(async () => (await readStoredTrainingRecords(page)).sessions.length).toBe(1);
  const session = (await readStoredTrainingRecords(page)).sessions[0];
  expect(session.athleteCode).toBe("DETAILS-COLLAPSE");
  expect(session.samples.length).toBeGreaterThan(before);
});
