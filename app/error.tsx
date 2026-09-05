"use client";

import { useEffect } from "react";
import { initializeAnalytics, trackAnalytics } from "../lib/analytics/client";
import { classifyUnknownError } from "../lib/analytics/error-codes";

interface AppErrorProps {
  error: Error & { digest?: string };
  retry: () => void;
}

export default function AppError({ error, retry }: AppErrorProps) {
  useEffect(() => {
    initializeAnalytics();
    const classified = classifyUnknownError(undefined, "runtime");
    trackAnalytics("js_error", {
      code: "unexpected_exception",
      stage: classified.stage,
      fingerprint: classified.fingerprint,
    });
  }, [error]);

  return (
    <main className="app-error-shell">
      <section className="app-error-card" role="alert">
        <span>FPVHELPER / RECOVERY</span>
        <h1>页面暂时无法继续</h1>
        <p>训练数据仍以本机存储状态为准。请先重试；若仍失败，请记录故障时间和操作阶段。</p>
        <button className="button button--primary" type="button" onClick={retry}>重试页面</button>
      </section>
    </main>
  );
}
