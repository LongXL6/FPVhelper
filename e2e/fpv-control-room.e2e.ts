import { expect, test, type FakeSerialMetrics } from "./fixtures/fpv-hardware";

interface StoredSession {
  schemaVersion: number;
  athleteCode: string | null;
  sampleCount: number;
  initialSource: string;
  dataSources: string[];
  interrupted: boolean;
  samples: Array<{
    source: string;
    channelsUs: number[];
    rc: {
      rollStickPercent: number;
      pitchStickPercent: number;
      yawStickPercent: number;
      throttleStickPercent: number;
      throttleUs: number;
    };
    groundBridge: {
      mspRssiPercent: number | null;
      voltage: number | null;
    };
  }>;
}

test("fake media and read-only MSP bridge persist a local training session", async ({ page }) => {
  const analyticsRequests: Array<{ method: string; url: string }> = [];
  await page.route("**/api/events", async (route) => {
    const request = route.request();
    analyticsRequests.push({ method: request.method(), url: request.url() });
    await route.abort("blockedbyclient");
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "飞行操控台" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "本机统计 · 关闭" })).toBeVisible();
  await expect(page.getByText("当前域名仅用于内部验证，不采集统计事件。")).toBeVisible();

  await page.getByRole("button", { name: "打开画面" }).click();
  await expect(page.getByText(/HDMI 画面在线/)).toBeVisible();
  await expect.poll(() => page.locator("video").evaluate((video) => {
    const element = video as HTMLVideoElement;
    return element.srcObject instanceof MediaStream && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  })).toBe(true);

  const recordButton = page.getByRole("button", { name: "● 开始记录" });
  await expect(recordButton).toBeDisabled();

  await page.getByRole("button", { name: "连接桥接飞控" }).click();
  await expect(page.locator(".status-chip")).toContainText("数据桥在线");
  await expect(page.locator(".source-badge")).toHaveText("GROUND_RC");
  await expect(page.locator(".hud-bottom-left")).toContainText("ROLL STICK +20");
  await expect(page.locator(".hud-bottom-left")).toContainText("PITCH STICK -20");
  await expect(page.locator(".hud-bottom-left")).toContainText("YAW STICK +10");
  await expect(page.locator(".throttle-ladder")).toContainText("25%");
  await expect(page.locator(".gauge-grid--primary")).toContainText("1250 μs · GROUND_RC / MSP_RC");
  await expect(page.locator(".hud-top-right")).toContainText("5.0 V");

  await page.getByText("桥接诊断字段（非机上 LQ）").click();
  await expect(page.getByText("遥控链路：遥控链路正常。Bridge FC 在线不等于遥控器在线。")).toBeVisible();
  await expect(page.locator(".bridge-card .card-heading")).toContainText("RX OK");
  await expect(page.getByText(/解析质量：良好 · 有效帧/)).toBeVisible();
  const rssiGauge = page.locator(".gauge-card").filter({ hasText: "地面桥 RSSI 字段" });
  await expect(rssiGauge.locator("strong")).toHaveText("88");

  await expect.poll(() => page.evaluate(() => (
    [...new Set(window.__fpvFakeSerial.requestedCommands)].sort((left, right) => left - right)
  ))).toEqual([105, 110, 150]);
  await expect.poll(() => page.evaluate(() => window.__fpvFakeSerial)).toMatchObject({
    requestPortCalls: 1,
    openCalls: 1,
    lastBaudRate: 115_200,
    protocolErrors: [],
  });
  await expect(page.evaluate(() => window.__fpvFakeSerialControl.attemptClose())).resolves.toBe("InvalidStateError");
  await expect.poll(() => page.evaluate(() => window.__fpvFakeSerial)).toMatchObject({
    closeAttempts: 1,
    closeCalls: 0,
    closeRejectedWhileLocked: 1,
  });

  await page.getByRole("textbox", { name: "选手代号" }).fill("E2E-07");
  await expect(recordButton).toBeEnabled();
  await expect(recordButton).toHaveAttribute("title", "已满足开始条件");
  await recordButton.click();
  await expect(page.getByRole("button", { name: "■ 结束记录" })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "正在记录 E2E-07" })).toBeVisible();

  const uniqueSampleCount = page.locator(".session-stats span").filter({ hasText: "独立样本" }).locator("b");
  await expect.poll(async () => Number((await uniqueSampleCount.textContent()) ?? "0")).toBeGreaterThanOrEqual(3);

  await page.getByRole("button", { name: "■ 结束记录" }).click();
  await expect(page.getByRole("heading", { name: "最近记录已保存在本机" })).toBeVisible();
  await expect(page.getByRole("article", { name: /训练 Session：E2E-07/ })).toBeVisible();
  await expect(page.locator(".today-records-card")).toContainText("共 1 条");

  const stored = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("fpvhelper-training", 1);
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    const transaction = database.transaction(["drafts", "sessions"], "readonly");
    const draftsRequest = transaction.objectStore("drafts").getAll();
    const sessionsRequest = transaction.objectStore("sessions").getAll();
    const requestResult = <T,>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    const [drafts, sessions] = await Promise.all([
      requestResult(draftsRequest),
      requestResult(sessionsRequest),
    ]);
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("error", () => reject(transaction.error));
    });
    database.close();
    return { drafts, sessions };
  }) as { drafts: unknown[]; sessions: StoredSession[] };

  expect(stored.drafts).toEqual([]);
  expect(stored.sessions).toHaveLength(1);
  const completedSession = stored.sessions[0];
  expect(completedSession).toMatchObject({
    schemaVersion: 2,
    athleteCode: "E2E-07",
    initialSource: "ground_rc",
    dataSources: ["ground_rc"],
    interrupted: false,
  });
  expect(completedSession.sampleCount).toBeGreaterThanOrEqual(3);
  expect(completedSession.samples).toHaveLength(completedSession.sampleCount);
  expect(completedSession.samples.at(-1)).toMatchObject({
    source: "ground_rc",
    channelsUs: [1_600, 1_400, 1_550, 1_250, 1_000, 1_000, 1_000, 1_000],
    rc: {
      rollStickPercent: 20,
      pitchStickPercent: -20,
      yawStickPercent: 10,
      throttleStickPercent: 25,
      throttleUs: 1_250,
    },
    groundBridge: {
      voltage: 5,
    },
  });
  expect(completedSession.samples.at(-1)?.groundBridge.mspRssiPercent).toBeCloseTo((900 / 1_023) * 100, 5);

  await page.evaluate(() => window.__fpvFakeSerialControl.holdNextWrite());
  await expect.poll(() => page.evaluate(() => ({
    pendingReads: window.__fpvFakeSerial.pendingReads,
    pendingWrites: window.__fpvFakeSerial.pendingWrites,
  }))).toEqual({ pendingReads: 1, pendingWrites: 1 });

  await page.getByRole("button", { name: "返回演示" }).click();
  await expect(page.locator(".status-chip")).toContainText("演示数据");
  await expect.poll(() => page.evaluate(() => window.__fpvFakeSerial)).toMatchObject({
    closeAttempts: 2,
    closeCalls: 1,
    closeRejectedWhileLocked: 1,
    cancelCalls: 1,
    abortCalls: 1,
    readerReleaseCalls: 1,
    writerReleaseCalls: 1,
    pendingReads: 0,
    maxPendingReads: 1,
    pendingWrites: 0,
    maxPendingWrites: 1,
    cancelledPendingRead: true,
    abortedPendingWrite: true,
    protocolErrors: [],
  } satisfies Partial<FakeSerialMetrics>);

  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.waitForTimeout(250);
  expect(analyticsRequests).toEqual([]);
});
