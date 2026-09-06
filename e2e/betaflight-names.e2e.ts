import type { Page } from "@playwright/test";
import { expect, test, type FakeSerialDeviceNames } from "./fixtures/fpv-hardware";

const pilotField = (page: Page) => page.getByRole("textbox", { name: "当前训练选手代号", exact: true });

async function connectCurrentPilot(page: Page) {
  await page.getByRole("region", { name: "录制准备", exact: true }).getByRole("button", { name: /连接当前选手/ }).click();
  await expect(page.locator(".source-badge")).toHaveText("GROUND_RC");
}

async function openBindings(page: Page) {
  const details = page.locator(".video-setup-details");
  if (!await details.evaluate((element) => (element as HTMLDetailsElement).open)) await details.locator("summary").click();
}

test("Betaflight pilot name is automatic, manual edits persist, and reset restores the current connection name", async ({ page }) => {
  await page.goto("/");
  await expect(pilotField(page)).toHaveValue("");
  await connectCurrentPilot(page);
  await expect(pilotField(page)).toHaveValue("BF-PILOT-01");
  await expect.poll(() => page.evaluate(() => window.__fpvFakeSerialPorts[0].requestedTextTypes)).toEqual([1, 2]);
  await pilotField(page).fill("COACH-EDIT");
  await page.reload();
  await expect(pilotField(page)).toHaveValue("COACH-EDIT");
  await connectCurrentPilot(page);
  await expect.poll(() => page.evaluate(() => window.__fpvFakeSerialPorts[0].requestedTextTypes)).toEqual([1, 2]);
  await expect(pilotField(page)).toHaveValue("COACH-EDIT");
  await page.getByRole("button", { name: "使用飞控名称", exact: true }).click();
  await expect(pilotField(page)).toHaveValue("BF-PILOT-01");

  await pilotField(page).fill("");
  await expect(pilotField(page)).toHaveValue("");
  await expect(page.getByRole("button", { name: "● 开始记录", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "使用飞控名称", exact: true }).click();
  await expect(pilotField(page)).toHaveValue("BF-PILOT-01");
  await page.reload();
  await expect(pilotField(page)).toHaveValue("");
  await connectCurrentPilot(page);
  await expect(pilotField(page)).toHaveValue("BF-PILOT-01");
  expect(await page.evaluate(() => window.__fpvFakeSerial.protocolErrors)).toEqual([]);
});

for (const scenario of [
  { title: "uses aircraft name when pilot name is empty", names: { pilotName: "", craftName: "CRAFT-FALLBACK" }, expected: "CRAFT-FALLBACK", legacy: false },
  { title: "reads the legacy aircraft name before API 1.45", names: { apiMinor: 44, pilotName: "IGNORED", craftName: "LEGACY-CRAFT" }, expected: "LEGACY-CRAFT", legacy: true },
] satisfies Array<{ title: string; names: Partial<FakeSerialDeviceNames>; expected: string; legacy: boolean }>) {
  test(`Betaflight ${scenario.title}`, async ({ page }) => {
    await page.goto("/");
    await page.evaluate((names) => window.__fpvFakeSerialControl.configurePortNames(0, names), scenario.names);
    await connectCurrentPilot(page);
    await expect(pilotField(page)).toHaveValue(scenario.expected);
    const commands = await page.evaluate(() => window.__fpvFakeSerialPorts[0].requestedCommands);
    expect(commands).toContain(1);
    expect(commands).toContain(scenario.legacy ? 10 : 0x3006);
    if (scenario.legacy) expect(commands).not.toContain(0x3006);
    expect(await page.evaluate(() => window.__fpvFakeSerial.protocolErrors)).toEqual([]);
  });
}

for (const scenario of [
  { title: "empty names", names: { pilotName: "", craftName: "" } },
  { title: "unsupported metadata", names: { metadataResponse: "unsupported" } },
  { title: "metadata timeout", names: { metadataResponse: "timeout" } },
] satisfies Array<{ title: string; names: Partial<FakeSerialDeviceNames> }>) {
  test(`Betaflight ${scenario.title} keeps live RC and permits manual naming`, async ({ page }) => {
    await page.goto("/");
    await page.evaluate((names) => window.__fpvFakeSerialControl.configurePortNames(0, names), scenario.names);
    await connectCurrentPilot(page);
    await expect.poll(() => page.evaluate(() => window.__fpvFakeSerialPorts[0].rcResponses)).toBeGreaterThan(150);
    await expect(pilotField(page)).toHaveValue("");
    await expect(page.locator(".source-badge")).toHaveText("GROUND_RC");
    await expect(page.getByRole("button", { name: "● 开始记录", exact: true })).toBeDisabled();
    await pilotField(page).fill("MANUAL-PILOT");
    await expect(page.getByRole("button", { name: "● 开始记录", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => window.__fpvFakeSerial.protocolErrors)).toEqual([]);
  });
}

test("Betaflight names remain per pilot when responses arrive after selection changes and a different device reconnects", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    window.__fpvFakeSerialControl.configurePortNames(0, { pilotName: "ALPHA", metadataDelayMs: 150 });
    window.__fpvFakeSerialControl.configurePortNames(1, { pilotName: "BRAVO" });
    window.__fpvFakeSerialControl.configurePortNames(2, { pilotName: "CHARLIE" });
  });
  await openBindings(page);
  await page.getByRole("button", { name: "+ 独立输入", exact: true }).click();
  const first = page.locator('.video-viewport[data-source-id="video-source-1"]');
  const second = page.locator('.video-viewport[data-source-id="video-source-2"]');
  await first.getByRole("button", { name: /桥接飞控/ }).click();
  await second.getByRole("button", { name: /桥接飞控/ }).click();
  await expect(pilotField(page)).toHaveValue("BRAVO");
  await expect(first.locator(".video-viewport-select")).toContainText("ALPHA");
  await expect(pilotField(page)).toHaveValue("BRAVO");

  await first.locator(".video-viewport-select").click();
  await expect(pilotField(page)).toHaveValue("ALPHA");
  await page.evaluate(() => window.__fpvFakeSerialControl.disconnectPort(0));
  await expect(pilotField(page)).toHaveValue("");
  await expect(first.locator(".pilot-viewport-telemetry")).toHaveAttribute("data-telemetry-connection", "error");
  await first.getByRole("button", { name: /桥接飞控/ }).click();
  await expect(pilotField(page)).toHaveValue("CHARLIE");
  await second.locator(".video-viewport-select").click();
  await expect(pilotField(page)).toHaveValue("BRAVO");
  await expect(second.locator(".pilot-viewport-telemetry")).toHaveAttribute("data-telemetry-connection", "live");
  expect(await page.evaluate(() => window.__fpvFakeSerial.protocolErrors)).toEqual([]);
});

test("the visible crop-and-binding action opens the selected pilot in a four-up workspace", async ({ page }) => {
  await page.goto("/");
  await openBindings(page);
  await page.getByRole("button", { name: "输入布局：共享画面", exact: true }).click();
  const third = page.locator('.video-viewport[data-pilot-channel-id="video-source-1-pilot-3"]');
  await page.locator(".video-setup-details > summary").click();
  await third.getByRole("button", { name: /^配置 .* 的裁切与绑定$/ }).click();
  await expect(pilotField(page)).toHaveValue("");
  await expect(third).toHaveClass(/is-active/);
  const binding = page.getByRole("region", { name: "选手 3 画面绑定", exact: true });
  await expect(binding).toBeVisible();
  await expect(binding.getByRole("button", { name: "选手取景：裁切区域", exact: true })).toHaveAttribute("aria-pressed", "true");
  await binding.getByRole("slider", { name: "裁切画面宽度", exact: true }).fill("40");
  await expect(binding.getByRole("slider", { name: "裁切画面宽度", exact: true })).toHaveValue("40");
});
