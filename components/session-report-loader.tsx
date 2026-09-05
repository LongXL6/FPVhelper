"use client";

import { useRef, useState } from "react";
import { TrainingWeeklyReport } from "@/components/training-weekly-report";
import type { TrainingSession } from "@/lib/training-session";
import type { TrainingSessionSummary } from "@/lib/training-session-index";

export function SessionReportLoader({ loadSessions, revision }: {
  loadSessions: () => Promise<TrainingSession[]>;
  revision: TrainingSessionSummary[];
}) {
  const [loaded, setLoaded] = useState<{ sessions: TrainingSession[]; revision: TrainingSessionSummary[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  async function refresh() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try { setLoaded({ sessions: await loadSessions(), revision }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "无法读取周报记录"); }
    finally { loadingRef.current = false; setLoading(false); }
  }
  return (
    <details className="review-tool" onToggle={(event) => {
      if (event.currentTarget.open && !loaded && !loadingRef.current) void refresh();
    }}>
      <summary>周训练报告 <small>需要时读取完整记录并核对冲突</small></summary>
      {loading ? <p role="status">正在读取周报所需记录…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {error || (loaded && loaded.revision !== revision) ? <button className="session-button" type="button" disabled={loading} onClick={() => void refresh()}>更新本机周报数据</button> : null}
      {loaded ? <TrainingWeeklyReport localSessions={loaded.sessions} /> : null}
    </details>
  );
}
