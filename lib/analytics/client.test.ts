import { describe, expect, it } from "vitest";
import {
  AnalyticsClient,
  CUSTOMER_ANALYTICS_HOSTNAME,
  resolveAnalyticsLocalStatus,
} from "./client";

const TOKEN_A = `fpvh_ingest_${"a".repeat(43)}`;
const TOKEN_B = `fpvh_ingest_${"b".repeat(43)}`;

function createHarness(options: { search?: string; online?: boolean; statuses?: number[]; hostname?: string } = {}) {
  const values = new Map<string, string>();
  const listeners = new Map<string, Set<() => void>>();
  const timers = new Map<number, () => void>();
  const requests: Array<{ input: string; init: RequestInit }> = [];
  const beacons: Array<{ input: string; body: Blob }> = [];
  let uuidIndex = 1;
  let timerIndex = 1;
  let isOnline = options.online ?? true;
  let nowMs = Date.parse("2026-08-31T00:00:00.000Z");
  const statuses = [...(options.statuses ?? [204])];

  const runtime = {
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
    hostname: options.hostname ?? CUSTOMER_ANALYTICS_HOSTNAME,
    search: options.search ?? "",
    online: () => isOnline,
    randomUuid: () => `10000000-0000-4000-8000-${(uuidIndex++).toString(16).padStart(12, "0")}`,
    now: () => nowMs,
    monotonicNow: () => 1234,
    fetch: async (input: string, init: RequestInit) => {
      requests.push({ input, init });
      return new Response(null, { status: statuses.shift() ?? 204 });
    },
    sendBeacon: (input: string, body: Blob) => {
      beacons.push({ input, body });
      return true;
    },
    setTimeout: (callback: () => void) => {
      const id = timerIndex++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
    addWindowListener: (type: "online" | "pagehide", listener: () => void) => {
      const group = listeners.get(type) ?? new Set();
      group.add(listener);
      listeners.set(type, group);
    },
    removeWindowListener: (type: "online" | "pagehide", listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
  };

  return {
    runtime,
    values,
    requests,
    beacons,
    timers,
    listeners,
    setOnline(value: boolean) { isOnline = value; },
    advanceNow(deltaMs: number) { nowMs += deltaMs; },
    emit(type: "online" | "pagehide") { listeners.get(type)?.forEach((listener) => listener()); },
    runNextTimer() {
      const entry = timers.entries().next().value as [number, () => void] | undefined;
      if (!entry) return;
      timers.delete(entry[0]);
      entry[1]();
    },
  };
}

function overlayProps() {
  return { overlay_mode: "trail" as const, was_default: false };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("analytics client privacy and delivery", () => {
  it("is a safe no-op without a browser runtime", () => {
    const client = new AnalyticsClient({ enabled: true, environment: "production" });
    expect(client.init()).toBe(false);
    expect(client.track("overlay_layout_reset", overlayProps())).toBeNull();
  });

  it("requires explicit production opt-in and a locally installed token", () => {
    const harness = createHarness({ search: `?ingest_token=${TOKEN_A}` });
    const missingToken = new AnalyticsClient({
      enabled: true, environment: "production", runtime: harness.runtime, allowInTest: true, build: "test",
    });
    expect(missingToken.init()).toBe(false);
    expect(harness.requests).toHaveLength(0);

    const disabled = new AnalyticsClient({
      enabled: false, environment: "production", ingestToken: TOKEN_A, runtime: harness.runtime, allowInTest: true, build: "test",
    });
    expect(disabled.init()).toBe(false);
    expect(harness.requests).toHaveLength(0);
  });

  it.each(["helper.longxl.com", "localhost", "127.0.0.1"])(
    "forces analytics to a no-op on %s even when production flags and a token exist",
    (hostname) => {
      const harness = createHarness({ hostname });
      const client = new AnalyticsClient({
        enabled: true,
        environment: "production",
        ingestToken: TOKEN_A,
        runtime: harness.runtime,
        allowInTest: true,
        build: "test",
      });

      expect(client.init()).toBe(false);
      expect(client.setIngestToken(TOKEN_B)).toBe(false);
      expect(client.track("overlay_layout_reset", overlayProps())).toBeNull();
      expect(harness.values.has("fpvhelper.analytics.ingest-token.v1")).toBe(false);
      expect(harness.values.has("fpvhelper.analytics.queue.v1")).toBe(false);
      expect(harness.requests).toHaveLength(0);
    },
  );

  it("resolves the three quiet UI states without exposing token contents", () => {
    expect(resolveAnalyticsLocalStatus({
      hostname: "helper.longxl.com", configured: true, optedOut: false, hasToken: true,
    })).toEqual({ state: "off", reason: "hostname" });
    expect(resolveAnalyticsLocalStatus({
      hostname: CUSTOMER_ANALYTICS_HOSTNAME, configured: true, optedOut: false, hasToken: false,
    })).toEqual({ state: "waiting_token", reason: "missing_token" });
    expect(resolveAnalyticsLocalStatus({
      hostname: CUSTOMER_ANALYTICS_HOSTNAME, configured: true, optedOut: false, hasToken: true,
    })).toEqual({ state: "enabled", reason: "installed" });
    expect(resolveAnalyticsLocalStatus({
      hostname: CUSTOMER_ANALYTICS_HOSTNAME,
      configured: true,
      optedOut: false,
      hasToken: true,
      authorizationBlocked: true,
    })).toEqual({ state: "waiting_token", reason: "rejected_token" });
    expect(resolveAnalyticsLocalStatus({
      hostname: CUSTOMER_ANALYTICS_HOSTNAME, configured: true, optedOut: true, hasToken: true,
    })).toEqual({ state: "off", reason: "opted_out" });
  });

  it("installs a token locally, caps the queue at 500, and expires entries after seven days", async () => {
    const harness = createHarness({ online: false });
    const client = new AnalyticsClient({
      enabled: true, environment: "production", runtime: harness.runtime, allowInTest: true, build: "test",
    });
    expect(client.setIngestToken(TOKEN_A)).toBe(true);
    expect(harness.values.get("fpvhelper.analytics.ingest-token.v1")).toBe(TOKEN_A);

    for (let index = 0; index < 501; index += 1) client.track("overlay_layout_reset", overlayProps());
    expect(client.getQueueLength()).toBe(500);
    harness.advanceNow(7 * 24 * 60 * 60 * 1_000 + 1);
    await client.flush();
    expect(client.getQueueLength()).toBe(0);
    expect(JSON.parse(harness.values.get("fpvhelper.analytics.queue.v1") ?? "[]")).toHaveLength(0);
  });

  it("sanitizes a blank or unsafe public build label instead of dropping otherwise valid events", () => {
    const harness = createHarness({ online: false });
    const client = new AnalyticsClient({
      enabled: true,
      environment: "production",
      ingestToken: TOKEN_A,
      runtime: harness.runtime,
      allowInTest: true,
      build: " build label with spaces ",
    });
    expect(client.init()).toBe(true);
    expect(client.track("overlay_layout_reset", overlayProps())).not.toBeNull();
  });

  it("flushes at 20 events, on the online event, and on the 10-second timer", async () => {
    const harness = createHarness({ online: false });
    const client = new AnalyticsClient({
      enabled: true, environment: "production", ingestToken: TOKEN_A, runtime: harness.runtime, allowInTest: true, build: "test",
    });
    expect(client.init()).toBe(true);
    for (let index = 0; index < 20; index += 1) client.track("overlay_layout_reset", overlayProps());
    expect(harness.requests).toHaveLength(0);

    harness.setOnline(true);
    harness.emit("online");
    await settle();
    expect(harness.requests).toHaveLength(1);
    expect(JSON.parse(harness.requests[0].init.body as string).events).toHaveLength(20);
    expect(client.getQueueLength()).toBe(0);

    client.track("overlay_layout_reset", overlayProps());
    harness.runNextTimer();
    await settle();
    expect(harness.requests).toHaveLength(2);
  });

  it("uses text/plain beacon on pagehide and keeps the batch for idempotent replay", async () => {
    const harness = createHarness();
    const client = new AnalyticsClient({
      enabled: true, environment: "production", ingestToken: TOKEN_A, runtime: harness.runtime, allowInTest: true, build: "test",
    });
    client.init();
    client.track("overlay_layout_reset", overlayProps());
    harness.emit("pagehide");

    expect(harness.beacons).toHaveLength(1);
    expect(harness.beacons[0].body.type).toBe("text/plain;charset=utf-8");
    expect(JSON.parse(await harness.beacons[0].body.text()).ingest_token).toBe(TOKEN_A);
    expect(client.getQueueLength()).toBe(1);
  });

  it.each([401, 403])("retains and pauses on %s, then replays after token replacement", async (status) => {
    const harness = createHarness({ statuses: [status, 204] });
    const client = new AnalyticsClient({
      enabled: true, environment: "production", ingestToken: TOKEN_A, runtime: harness.runtime, allowInTest: true, build: "test",
    });
    client.init();
    const observedStatuses: ReturnType<typeof client.getLocalStatus>[] = [];
    const unsubscribe = client.subscribeLocalStatus((nextStatus) => observedStatuses.push(nextStatus));
    client.track("overlay_layout_reset", overlayProps());
    expect(await client.flush()).toBe(false);
    expect(client.getQueueLength()).toBe(1);
    expect(client.getLocalStatus()).toEqual({ state: "waiting_token", reason: "rejected_token" });
    expect(observedStatuses.at(-1)).toEqual({ state: "waiting_token", reason: "rejected_token" });
    expect(harness.values.has("fpvhelper.analytics.ingest-token.v1")).toBe(false);
    harness.emit("pagehide");
    expect(harness.beacons).toHaveLength(0);
    const requestCountAfterFailure = harness.requests.length;
    harness.runNextTimer();
    await settle();
    expect(harness.requests).toHaveLength(requestCountAfterFailure);

    expect(client.setIngestToken(TOKEN_B)).toBe(true);
    await settle();
    expect(client.getQueueLength()).toBe(0);
    expect(client.getLocalStatus()).toEqual({ state: "enabled", reason: "installed" });
    expect(harness.requests).toHaveLength(requestCountAfterFailure + 1);
    unsubscribe();
  });

  it("clear token and opt-out both delete the token, queue, and listeners", () => {
    const harness = createHarness({ online: false });
    const client = new AnalyticsClient({
      enabled: true, environment: "production", ingestToken: TOKEN_A, runtime: harness.runtime, allowInTest: true, build: "test",
    });
    client.init();
    client.track("overlay_layout_reset", overlayProps());
    client.clearIngestToken();
    expect(client.getQueueLength()).toBe(0);
    expect(harness.values.has("fpvhelper.analytics.ingest-token.v1")).toBe(false);
    expect(harness.values.has("fpvhelper.analytics.queue.v1")).toBe(false);
    expect(harness.listeners.get("online")?.size ?? 0).toBe(0);
    expect(harness.listeners.get("pagehide")?.size ?? 0).toBe(0);

    client.setIngestToken(TOKEN_B);
    client.track("overlay_layout_reset", overlayProps());
    client.optOut();
    expect(harness.values.get("fpvhelper.analytics.opt-out.v1")).toBe("1");
    expect(harness.values.has("fpvhelper.workstation.v1")).toBe(false);
    expect(harness.values.has("fpvhelper.analytics.ingest-token.v1")).toBe(false);
    expect(harness.values.has("fpvhelper.analytics.queue.v1")).toBe(false);
    expect(client.getQueueLength()).toBe(0);
    expect(client.setIngestToken(TOKEN_A)).toBe(false);
    expect(harness.values.has("fpvhelper.analytics.ingest-token.v1")).toBe(false);
  });

  it("?analytics=off persists opt-out and clears pre-existing local data", () => {
    const harness = createHarness({ search: "?analytics=off" });
    harness.values.set("fpvhelper.analytics.ingest-token.v1", TOKEN_A);
    harness.values.set("fpvhelper.analytics.queue.v1", "[{}]");
    const client = new AnalyticsClient({
      enabled: true, environment: "production", runtime: harness.runtime, allowInTest: true, build: "test",
    });
    expect(client.init()).toBe(false);
    expect(harness.values.get("fpvhelper.analytics.opt-out.v1")).toBe("1");
    expect(harness.values.has("fpvhelper.workstation.v1")).toBe(false);
    expect(harness.values.has("fpvhelper.analytics.ingest-token.v1")).toBe(false);
    expect(harness.values.has("fpvhelper.analytics.queue.v1")).toBe(false);
  });

  it("requires an explicit reactivation before a permanently opted-out workstation can reinstall", () => {
    const harness = createHarness({ online: false });
    const client = new AnalyticsClient({
      enabled: true, environment: "production", ingestToken: TOKEN_A, runtime: harness.runtime, allowInTest: true, build: "test",
    });
    expect(client.init()).toBe(true);
    client.optOut();
    expect(client.getLocalStatus()).toEqual({ state: "off", reason: "opted_out" });
    expect(client.setIngestToken(TOKEN_B)).toBe(false);

    expect(client.prepareReactivation()).toBe(true);
    expect(client.getLocalStatus()).toEqual({ state: "waiting_token", reason: "missing_token" });
    expect(client.setIngestToken(TOKEN_B)).toBe(true);
    expect(client.getLocalStatus()).toEqual({ state: "enabled", reason: "installed" });
  });
});
