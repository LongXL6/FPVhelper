import { describe, expect, it } from "vitest";
import {
  AnalyticsClient,
  CUSTOMER_ANALYTICS_HOSTNAME,
  resolveAnalyticsLocalStatus,
} from "./client";

const TOKEN_A = `fpvh_ingest_${"a".repeat(43)}`;
const TOKEN_B = `fpvh_ingest_${"b".repeat(43)}`;
const FIRST_WORKSTATION_ID = "10000000-0000-4000-8000-000000000001";

function createHarness(options: {
  search?: string;
  online?: boolean;
  statuses?: number[];
  responses?: Array<{ status: number; headers?: Record<string, string> }>;
  responsePromises?: Array<Promise<Response>>;
  hostname?: string;
} = {}) {
  const values = new Map<string, string>();
  const listeners = new Map<string, Set<() => void>>();
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  const requests: Array<{ input: string; init: RequestInit }> = [];
  const beacons: Array<{ input: string; body: Blob }> = [];
  let uuidIndex = 1;
  let timerIndex = 1;
  let isOnline = options.online ?? true;
  let nowMs = Date.parse("2026-08-31T00:00:00.000Z");
  const statuses = [...(options.statuses ?? [204])];
  const responses = [...(options.responses ?? [])];
  const responsePromises = [...(options.responsePromises ?? [])];

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
      const promised = responsePromises.shift();
      if (promised) return promised;
      const configured = responses.shift();
      return new Response(null, configured ?? { status: statuses.shift() ?? 204 });
    },
    sendBeacon: (input: string, body: Blob) => {
      beacons.push({ input, body });
      return true;
    },
    setTimeout: (callback: () => void, delayMs: number) => {
      const id = timerIndex++;
      timers.set(id, { callback, delayMs });
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
      const entry = timers.entries().next().value as [number, { callback: () => void; delayMs: number }] | undefined;
      if (!entry) return;
      timers.delete(entry[0]);
      entry[1].callback();
    },
    nextTimerDelay() {
      return timers.values().next().value?.delayMs as number | undefined;
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
    expect(missingToken.getLocalStatus()).toEqual({
      state: "waiting_token",
      reason: "missing_token",
      workstationId: FIRST_WORKSTATION_ID,
    });
    expect(harness.values.get("fpvhelper.workstation.v1")).toBe(FIRST_WORKSTATION_ID);
    expect(harness.requests).toHaveLength(0);

    const disabled = new AnalyticsClient({
      enabled: false, environment: "production", ingestToken: TOKEN_A, runtime: harness.runtime, allowInTest: true, build: "test",
    });
    expect(disabled.init()).toBe(false);
    expect(harness.requests).toHaveLength(0);
  });

  it("never installs delivery triggers or sends through online, pagehide, timers, or beacon without a token", async () => {
    const harness = createHarness();
    const client = new AnalyticsClient({
      enabled: true, environment: "production", runtime: harness.runtime, allowInTest: true, build: "test",
    });

    expect(client.init()).toBe(false);
    expect(harness.listeners.get("online")?.size ?? 0).toBe(0);
    expect(harness.listeners.get("pagehide")?.size ?? 0).toBe(0);
    expect(harness.timers.size).toBe(0);
    expect(client.track("overlay_layout_reset", overlayProps())).toBeNull();
    harness.emit("online");
    harness.emit("pagehide");
    harness.runNextTimer();
    expect(await client.flush()).toBe(false);
    expect(await client.flush({ beacon: true })).toBe(false);
    expect(harness.requests).toHaveLength(0);
    expect(harness.beacons).toHaveLength(0);
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
      workstationId: FIRST_WORKSTATION_ID,
    })).toEqual({ state: "waiting_token", reason: "missing_token", workstationId: FIRST_WORKSTATION_ID });
    expect(resolveAnalyticsLocalStatus({
      hostname: CUSTOMER_ANALYTICS_HOSTNAME, configured: true, optedOut: false, hasToken: true,
      workstationId: FIRST_WORKSTATION_ID,
    })).toEqual({ state: "enabled", reason: "installed" });
    expect(resolveAnalyticsLocalStatus({
      hostname: CUSTOMER_ANALYTICS_HOSTNAME,
      configured: true,
      optedOut: false,
      hasToken: true,
      workstationId: FIRST_WORKSTATION_ID,
      authorizationBlocked: true,
    })).toEqual({ state: "waiting_token", reason: "rejected_token", workstationId: FIRST_WORKSTATION_ID });
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
    expect(client.getLocalStatus()).toEqual({
      state: "waiting_token", reason: "rejected_token", workstationId: FIRST_WORKSTATION_ID,
    });
    expect(observedStatuses.at(-1)).toEqual({
      state: "waiting_token", reason: "rejected_token", workstationId: FIRST_WORKSTATION_ID,
    });
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

  it("pauses an enabled client for explicit replacement, preserving identity and queue until the new token flushes", async () => {
    let resolveOldRequest!: (response: Response) => void;
    const oldRequest = new Promise<Response>((resolve) => { resolveOldRequest = resolve; });
    const harness = createHarness({ responsePromises: [oldRequest] });
    const client = new AnalyticsClient({
      enabled: true, environment: "production", ingestToken: TOKEN_A, runtime: harness.runtime, allowInTest: true, build: "test",
    });
    expect(client.init()).toBe(true);
    client.track("overlay_layout_reset", overlayProps());
    const queuedBeforeReplacement = harness.values.get("fpvhelper.analytics.queue.v1");
    const oldFlush = client.flush();
    await settle();
    expect(harness.requests).toHaveLength(1);

    expect(client.prepareTokenReplacement()).toBe(true);
    expect(client.getLocalStatus()).toEqual({
      state: "waiting_token", reason: "replacement", workstationId: FIRST_WORKSTATION_ID,
    });
    expect(harness.values.has("fpvhelper.analytics.ingest-token.v1")).toBe(false);
    expect(harness.values.get("fpvhelper.analytics.queue.v1")).toBe(queuedBeforeReplacement);
    expect(harness.values.get("fpvhelper.workstation.v1")).toBe(FIRST_WORKSTATION_ID);
    expect(harness.values.has("fpvhelper.analytics.opt-out.v1")).toBe(false);

    harness.emit("online");
    harness.emit("pagehide");
    harness.runNextTimer();
    await settle();
    expect(harness.requests).toHaveLength(1);
    expect(harness.beacons).toHaveLength(0);

    resolveOldRequest(new Response(null, { status: 204 }));
    expect(await oldFlush).toBe(false);
    expect(client.getQueueLength()).toBe(1);
    expect(harness.values.get("fpvhelper.analytics.queue.v1")).toBe(queuedBeforeReplacement);

    expect(client.setIngestToken(TOKEN_B)).toBe(true);
    await settle();
    expect(harness.requests).toHaveLength(2);
    expect(JSON.parse(harness.requests[1].init.body as string).ingest_token).toBe(TOKEN_B);
    expect(client.getQueueLength()).toBe(0);
    expect(client.getLocalStatus()).toEqual({ state: "enabled", reason: "installed" });
  });

  it("retains a rate-limited batch and obeys Retry-After before replaying it", async () => {
    const harness = createHarness({ responses: [
      { status: 429, headers: { "retry-after": "30" } },
      { status: 204 },
    ] });
    const client = new AnalyticsClient({
      enabled: true, environment: "production", ingestToken: TOKEN_A, runtime: harness.runtime, allowInTest: true, build: "test",
    });
    client.init();
    client.track("overlay_layout_reset", overlayProps());

    expect(await client.flush()).toBe(false);
    expect(client.getQueueLength()).toBe(1);
    expect(harness.nextTimerDelay()).toBe(30_000);

    harness.advanceNow(29_999);
    expect(await client.flush()).toBe(false);
    expect(harness.requests).toHaveLength(1);
    expect(harness.nextTimerDelay()).toBe(1);

    harness.advanceNow(1);
    harness.runNextTimer();
    await settle();
    expect(harness.requests).toHaveLength(2);
    expect(client.getQueueLength()).toBe(0);
  });

  it("uses bounded exponential backoff for retryable server failures", async () => {
    const harness = createHarness({ statuses: [503, 503, 204] });
    const client = new AnalyticsClient({
      enabled: true, environment: "production", ingestToken: TOKEN_A, runtime: harness.runtime, allowInTest: true, build: "test",
    });
    client.init();
    client.track("overlay_layout_reset", overlayProps());

    expect(await client.flush()).toBe(false);
    expect(harness.nextTimerDelay()).toBe(5_000);
    harness.advanceNow(5_000);
    harness.runNextTimer();
    await settle();
    expect(harness.nextTimerDelay()).toBe(10_000);
    harness.advanceNow(10_000);
    harness.runNextTimer();
    await settle();
    expect(client.getQueueLength()).toBe(0);
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
    expect(harness.values.get("fpvhelper.workstation.v1")).toBe(FIRST_WORKSTATION_ID);
    expect(harness.values.has("fpvhelper.analytics.ingest-token.v1")).toBe(false);
    expect(harness.values.has("fpvhelper.analytics.queue.v1")).toBe(false);
    expect(client.getQueueLength()).toBe(0);
    expect(client.getWorkstationId()).toBe(FIRST_WORKSTATION_ID);
    expect(client.getLocalStatus()).toEqual({ state: "off", reason: "opted_out" });
    expect(client.setIngestToken(TOKEN_A)).toBe(false);
    expect(harness.values.has("fpvhelper.analytics.ingest-token.v1")).toBe(false);
  });

  it("?analytics=off persists opt-out and clears pre-existing local data", () => {
    const harness = createHarness({ search: "?analytics=off" });
    harness.values.set("fpvhelper.workstation.v1", FIRST_WORKSTATION_ID);
    harness.values.set("fpvhelper.analytics.ingest-token.v1", TOKEN_A);
    harness.values.set("fpvhelper.analytics.queue.v1", "[{}]");
    const client = new AnalyticsClient({
      enabled: true, environment: "production", runtime: harness.runtime, allowInTest: true, build: "test",
    });
    expect(client.init()).toBe(false);
    expect(harness.values.get("fpvhelper.analytics.opt-out.v1")).toBe("1");
    expect(harness.values.get("fpvhelper.workstation.v1")).toBe(FIRST_WORKSTATION_ID);
    expect(harness.values.has("fpvhelper.analytics.ingest-token.v1")).toBe(false);
    expect(harness.values.has("fpvhelper.analytics.queue.v1")).toBe(false);
    expect(harness.requests).toHaveLength(0);
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
    expect(client.getLocalStatus()).toEqual({
      state: "waiting_token",
      reason: "missing_token",
      workstationId: FIRST_WORKSTATION_ID,
    });
    expect(client.setIngestToken(TOKEN_B)).toBe(true);
    expect(client.getLocalStatus()).toEqual({ state: "enabled", reason: "installed" });
  });
});
