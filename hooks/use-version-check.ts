"use client";

import { useCallback, useEffect, useState } from "react";
import { APP_VERSION, type AppVersionPayload } from "@/lib/app-version";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

interface UseVersionCheckOptions {
  intervalMs?: number;
}

interface VersionCheckState {
  currentVersion: string;
  latest: AppVersionPayload | null;
  updateAvailable: boolean;
  lastCheckedAt: string | null;
  error: string | null;
  checkNow: () => Promise<void>;
}

function isAppVersionPayload(value: unknown): value is AppVersionPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AppVersionPayload>;
  return (
    typeof candidate.version === "string" &&
    typeof candidate.build === "string" &&
    (candidate.commitSha === null || typeof candidate.commitSha === "string") &&
    typeof candidate.environment === "string"
  );
}

export function useVersionCheck({ intervalMs = DEFAULT_INTERVAL_MS }: UseVersionCheckOptions = {}): VersionCheckState {
  const [latest, setLatest] = useState<AppVersionPayload | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const checkNow = useCallback(async () => {
    try {
      const response = await fetch("/version.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload: unknown = await response.json();
      if (!isAppVersionPayload(payload)) throw new Error("版本响应格式无效");
      setLatest(payload);
      setLastCheckedAt(new Date().toISOString());
      setError(null);
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : "版本检查失败");
    }
  }, []);

  useEffect(() => {
    const initialCheck = window.setTimeout(() => void checkNow(), 0);
    const timer = window.setInterval(() => void checkNow(), intervalMs);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void checkNow();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearTimeout(initialCheck);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [checkNow, intervalMs]);

  return {
    currentVersion: APP_VERSION,
    latest,
    updateAvailable: latest !== null && latest.version !== APP_VERSION,
    lastCheckedAt,
    error,
    checkNow,
  };
}
