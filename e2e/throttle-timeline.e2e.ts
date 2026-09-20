import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/fpv-hardware";

async function traceXs(page: Page) {
  return page.locator(".timeline-plot svg").evaluate((svg) => [
    ...Array.from(svg.querySelectorAll("polyline")).flatMap((line) =>
      Array.from(line.points).map((point) => point.x)),
    ...Array.from(svg.querySelectorAll("circle")).map((circle) => circle.cx.baseVal.value),
  ]);
}

test("live throttle shows a partial receive-time window, ages through silence, and returns to demo", async ({ page }, info) => {
  const errors: string[] = [];
  const externalRequests: string[] = [];
  const posts: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
  await page.route(/^https?:\/\//, (route) => {
    const hostname = new URL(route.request().url()).hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1") return route.continue();
    externalRequests.push(hostname);
    return route.abort();
  });
  await page.goto("/?analytics=off");
  await page.locator(".telemetry-disclosure > summary").click();
  await page.getByRole("region", { name: "录制准备", exact: true }).getByRole("button", { name: /连接当前选手/ }).click();
  await expect(page.locator(".source-badge")).toHaveText("GROUND_RC");
  await expect.poll(() => traceXs(page)).toEqual(expect.arrayContaining([expect.any(Number)]));
  const initialXs = await traceXs(page);
  expect(Math.min(...initialXs)).toBeGreaterThan(320);
  await page.locator(".timeline-card").screenshot({ path: info.outputPath("synthetic-partial-window.png") });

  // Hold a synthetic write after its response. No more input can arrive, while
  // the actual browser clock/rendering continue; no production device is used.
  await page.evaluate(() => window.__fpvFakeSerialControl.holdNextWrite());
  await expect.poll(() => page.evaluate(() => window.__fpvFakeSerial.pendingWrites)).toBe(1);
  await expect.poll(async () => {
    const xs = await traceXs(page);
    return xs.length > 0 && Math.max(...xs) < 400;
  }).toBe(true);
  await page.locator(".timeline-card").screenshot({ path: info.outputPath("synthetic-receive-silence.png") });
  await expect.poll(() => traceXs(page), { timeout: 6000 }).toEqual([]);
  await page.locator(".timeline-card").screenshot({ path: info.outputPath("synthetic-expired-window.png") });
  await page.getByRole("button", { name: "返回演示", exact: true }).click();
  await expect(page.locator(".source-badge")).toHaveText("DEMO");
  await expect.poll(() => traceXs(page)).toEqual(expect.arrayContaining([expect.any(Number)]));
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
  expect(posts).toEqual([]);
});
