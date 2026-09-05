"use client";

import { memo } from "react";
import { Icon } from "@/components/ui/icon";
import type { LiveVisionController } from "@/lib/live-vision-types";
import styles from "./live-gate-panel.module.css";

export interface LiveGateSummaryData {
  state: LiveVisionController["state"];
  gateName: string | null;
  pilotName: string;
  hasRun: boolean;
  lapElapsedMs: number | null;
  reviewedLapCount: number;
  pendingCount: number;
}

const labels: Record<LiveVisionController["state"], string> = {
  idle: "待准备", loading: "准备模型", monitoring: "监测中", stopped: "已停止", interrupted: "已中断", error: "需要处理",
};

function clockText(milliseconds: number | null) {
  if (milliseconds === null) return "—";
  const tenths = Math.floor(Math.max(0, milliseconds) / 100);
  return `${String(Math.floor(tenths / 600)).padStart(2, "0")}:${String(Math.floor(tenths / 10) % 60).padStart(2, "0")}.${tenths % 10}`;
}

export const LiveGateSummary = memo(function LiveGateSummary({ summary }: { summary: LiveGateSummaryData | null }) {
  const state = summary?.state ?? "idle";
  const previous = summary?.hasRun && state !== "monitoring" && state !== "loading";
  return <div className={styles.compactSummary} role="region" aria-label="视频旁过门计时" data-state={state}>
    <div className={styles.compactIdentity}><span>过门计时 <em>实验</em></span><b>{summary?.gateName || "未选择计时门"}</b><small>{previous ? "最近记录 · " : ""}{summary?.pilotName || "当前选手"}</small></div>
    <span className={styles.status} data-state={state}><i />{labels[state]}</span>
    <div className={styles.compactClock}><span>本圈参考</span><b>{clockText(summary?.lapElapsedMs ?? null)}</b></div>
    <div className={styles.compactCount}><span>{previous ? "上轮已复核" : "已复核圈"}</span><b>{summary?.reviewedLapCount ?? 0}</b></div>
    <div className={styles.compactCount}><span>待确认</span><b>{summary?.pendingCount ?? 0}</b></div>
    <a href="#live-gate-panel" aria-label="配置与复核实时过门计时">配置与复核 <Icon name="arrow-right" size={13} /></a>
  </div>;
});
