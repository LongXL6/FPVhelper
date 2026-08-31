import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrainingSession } from "../lib/training-session";
import {
  createStatusExFreshnessWatchdog,
  STATUS_EX_STALE_TIMEOUT_MS,
  type LinkState,
} from "../lib/telemetry";
import { requestUnconfirmedTrainingSessionDownload } from "./training-session-export-feedback";
import { canStartTrainingSession } from "./training-session-start-guard";

const READY_TO_START = {
  storageReady: true,
  storageError: null,
  storageIntegrity: {
    readableDraftCount: 0,
    readableSessionCount: 1,
    quarantinedDraftCount: 0,
    quarantinedSessionCount: 0,
  },
  hasPendingSave: false,
  isRecording: false,
  isStarting: false,
  isFinishing: false,
  source: "serial" as const,
  connection: "live" as const,
  linkState: "ok" as const,
  athleteCode: "PILOT-07",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("useTrainingSession start guard", () => {
  it("keeps new training available when unreadable records are quarantined", () => {
    expect(canStartTrainingSession({
      storageReady: true,
      storageError: null,
      storageIntegrity: {
        readableDraftCount: 0,
        readableSessionCount: 4,
        quarantinedDraftCount: 1,
        quarantinedSessionCount: 2,
      },
      hasPendingSave: false,
      isRecording: false,
      isStarting: false,
      isFinishing: false,
      source: "serial",
      connection: "live",
      linkState: "ok",
      athleteCode: "PILOT-07",
    })).toBe(true);
  });

  it("still blocks actual storage failures", () => {
    expect(canStartTrainingSession({
      storageReady: true,
      storageError: "IndexedDB transaction failed",
      storageIntegrity: {
        readableDraftCount: 0,
        readableSessionCount: 0,
        quarantinedDraftCount: 0,
        quarantinedSessionCount: 0,
      },
      hasPendingSave: false,
      isRecording: false,
      isStarting: false,
      isFinishing: false,
      source: "serial",
      connection: "live",
      linkState: "ok",
      athleteCode: "PILOT-07",
    })).toBe(false);
  });

  it("keeps two consecutive sessions startable after unconfirmed automatic downloads", () => {
    const requestDownload = vi.fn(() => 256);
    const sessions = [
      { id: "session-one" } as TrainingSession,
      { id: "session-two" } as TrainingSession,
    ];

    for (const session of sessions) {
      const feedback = requestUnconfirmedTrainingSessionDownload(session, requestDownload);

      expect(feedback.notice).toContain("已请求下载但未确认落盘");
      expect(feedback.warning).toBeNull();
      expect(canStartTrainingSession(READY_TO_START)).toBe(true);
    }
    expect(requestDownload).toHaveBeenCalledTimes(2);
  });

  it("requires an explicit healthy ground RX link after the first RC frame", () => {
    expect(canStartTrainingSession({ ...READY_TO_START, linkState: "unknown" })).toBe(false);
    expect(canStartTrainingSession({ ...READY_TO_START, linkState: "lost" })).toBe(false);
    expect(canStartTrainingSession({ ...READY_TO_START, linkState: "ok" })).toBe(true);
    expect(canStartTrainingSession({ ...READY_TO_START, connection: "connecting", linkState: "ok" })).toBe(false);
  });

  it("blocks starting when STATUS_EX freshness expires while RC stays live", () => {
    vi.useFakeTimers();
    let linkState: LinkState = "ok";
    const watchdog = createStatusExFreshnessWatchdog(() => {
      linkState = "unknown";
    });

    expect(canStartTrainingSession({ ...READY_TO_START, linkState })).toBe(true);
    watchdog.observe();
    vi.advanceTimersByTime(STATUS_EX_STALE_TIMEOUT_MS);
    expect(canStartTrainingSession({ ...READY_TO_START, linkState })).toBe(false);
  });

  it("keeps a stored session startable when the anchor download request itself fails", () => {
    const feedback = requestUnconfirmedTrainingSessionDownload(
      { id: "session-download-failed" } as TrainingSession,
      () => { throw new Error("downloads blocked"); },
    );

    expect(feedback.notice).toBeNull();
    expect(feedback.warning).toContain("Session 已安全保存在本机 IndexedDB");
    expect(canStartTrainingSession(READY_TO_START)).toBe(true);
  });
});
