import { test, expect, readStoredTrainingRecords } from "./fixtures/fpv-hardware";

test.use({ seedDataOnlyPreference: false });

test("shared input remembers the chosen pilot count and records only the active cropped pilot", async ({ page }) => {
  await page.route("**/api/events", (route) => route.abort());
  await page.addInitScript(() => Object.defineProperty(window, "showDirectoryPicker", {
    configurable: true,
    value: async () => (await navigator.storage.getDirectory()).getDirectoryHandle("shared-pilot-count", { create: true }),
  }));
  await page.goto("/?analytics=off");
  await page.locator(".video-setup-details > summary").click();
  await page.getByRole("button", { name: "输入布局：共享画面", exact: true }).click();
  const countPicker = page.getByRole("group", { name: "共享画面的选手人数", exact: true });
  const tiles = page.locator(".video-viewport[data-pilot-channel-id]");
  await expect(tiles).toHaveCount(4);
  await page.locator(".video-viewport-tabs").getByRole("button", { name: "位置 4", exact: true }).click();
  await page.getByRole("textbox", { name: "当前训练选手代号", exact: true }).fill("PILOT-FOUR");
  await page.getByRole("slider", { name: "裁切画面宽度", exact: true }).fill("40");
  await countPicker.getByRole("button", { name: "添加 2 名选手", exact: true }).click();
  await expect(tiles).toHaveCount(2);
  await expect(page.locator(".video-viewport-tabs button")).toHaveCount(2);
  await expect(page.locator('.video-viewport.is-active')).toHaveAttribute("data-pilot-channel-id", "video-source-1-pilot-1");
  for (const count of [3, 1, 2]) {
    await countPicker.getByRole("button", { name: `添加 ${count} 名选手`, exact: true }).click();
    await expect(tiles).toHaveCount(count);
  }
  await page.reload();
  await page.locator(".video-setup-details > summary").click();
  await expect(countPicker.getByRole("button", { name: "添加 2 名选手", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(tiles).toHaveCount(2);
  await countPicker.getByRole("button", { name: "添加 4 名选手", exact: true }).click();
  await page.locator(".video-viewport-tabs").getByRole("button", { name: "PILOT-FOUR", exact: true }).click();
  await expect(page.getByRole("slider", { name: "裁切画面宽度", exact: true })).toHaveValue("40");
  await countPicker.getByRole("button", { name: "添加 2 名选手", exact: true }).click();
  await page.locator(".video-viewport-tabs").getByRole("button", { name: "位置 2", exact: true }).click();
  await page.getByRole("textbox", { name: "当前训练选手代号", exact: true }).fill("PILOT-TWO");
  // Two visible pilots can still select any quadrant of the original four-up input.
  await page.getByRole("slider", { name: "裁切上边界", exact: true }).fill("50");
  const setup = page.getByRole("region", { name: "录制准备", exact: true });
  await setup.getByRole("button", { name: /连接当前选手/ }).click();
  await setup.getByRole("button", { name: /打开当前输入/ }).click();
  await setup.getByRole("button", { name: /选择保存目录/ }).click();
  await expect.poll(() => page.locator('[data-pilot-channel-id="video-source-1-pilot-2"] video').evaluate((element) => (element as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
  const sourceSize = await page.locator('[data-pilot-channel-id="video-source-1-pilot-2"] video').evaluate((element) => {
    const video = element as HTMLVideoElement;
    return { width: video.videoWidth, height: video.videoHeight };
  });
  expect(sourceSize.width).toBeGreaterThan(0);
  await page.getByRole("button", { name: "● 开始记录", exact: true }).click();
  await expect(page.getByTestId("local-video-recording-status")).toContainText("● REC");
  for (const count of [1, 2, 3, 4]) await expect(countPicker.getByRole("button", { name: `添加 ${count} 名选手`, exact: true })).toBeDisabled();
  await expect.poll(async () => (await readStoredTrainingRecords(page)).drafts[0]?.samples.length ?? 0).toBeGreaterThan(30);
  await page.getByRole("button", { name: "■ 结束记录", exact: true }).click();
  await expect.poll(async () => (await readStoredTrainingRecords(page)).sessions[0]?.exportCount ?? 0).toBe(1);
  const stored = await readStoredTrainingRecords(page);
  expect(stored.sessions).toHaveLength(1);
  const saved = stored.sessions[0];
  expect(saved.athleteCode).toBe("PILOT-TWO");
  expect(saved.video).toMatchObject({ recorded: true, overlay: "sticks" });
  if (!saved.video.recorded) throw new Error("Missing video receipt");
  const media = await page.evaluate(async (filename) => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("shared-pilot-count");
    const names: string[] = [];
    for await (const [name] of directory.entries()) names.push(name);
    const file = await (await directory.getFileHandle(filename)).getFile();
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    try {
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("Recorded cropped video could not be decoded"));
        video.src = url;
      });
      return { names, bytes: file.size, width: video.videoWidth, height: video.videoHeight };
    } finally { video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
  }, saved.video.filename);
  expect(media.names.filter((name) => /\.(mp4|webm)$/.test(name))).toHaveLength(1);
  expect(media.names.filter((name) => name.endsWith(".json"))).toHaveLength(1);
  expect(media.bytes).toBe(saved.video.bytes);
  expect(media.width).toBe(sourceSize.width / 2);
  expect(media.height).toBe(sourceSize.height / 2);
});
