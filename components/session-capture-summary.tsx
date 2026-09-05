import type { TrainingSession } from "@/lib/training-session";

interface SessionCaptureSummaryProps {
  session: Pick<TrainingSession, "captureQuality" | "captureContext" | "video">;
}

const sourceLabels = { ground_rc: "真实遥控", demo: "演示（模拟）", mixed: "混合来源", empty: "无样本" };

export function SessionCaptureSummary({ session }: SessionCaptureSummaryProps) {
  const { captureQuality: quality, captureContext: context, video } = session;
  const abnormalIntervals = quality
    ? quality.zeroIntervalCount + quality.negativeIntervalCount + quality.invalidIntervalCount
    : null;

  return (
    <section className="session-chart-section" aria-label="采集质量与录像">
      <div className="session-section-heading">
        <div>
          <h3>主机采集质量</h3>
          <p>仅统计正间隔；批量接收可能同刻，不代表 RF 丢包。</p>
        </div>
        {quality ? <span>目标 {quality.targetPollHz} Hz · {sourceLabels[quality.source]}</span> : null}
      </div>
      {quality ? (
        <>
          <dl className="session-metrics">
            {([
              ["间隔中位数", quality.intervalStatsMs.median],
              ["P95 间隔", quality.intervalStatsMs.p95],
              ["P99 间隔", quality.intervalStatsMs.p99],
              ["最大间隔", quality.intervalStatsMs.max],
            ] as const).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value === null ? "未测得" : <>{value}<small> ms</small></>}</dd>
              </div>
            ))}
          </dl>
          <p className="session-save-feedback">
            大于 {quality.gapThresholdMs} ms 的缺口：{quality.gaps.length} · 异常间隔：{abnormalIntervals}（零值、倒序或无效时间）
            {!context ? " · 采集上下文未记录" : ""}
          </p>
        </>
      ) : <p className="session-inline-empty">这条记录未记录采集质量。</p>}
      <div className="session-section-heading">
        <div>
          <h3>录像文件</h3>
          {video.recorded ? (
            <>
              <p style={{ overflowWrap: "anywhere" }}>{video.filename} · {video.bytes.toLocaleString("en-US")} 字节</p>
              <p>{video.overlay === "sticks" ? "已烧录摇杆，使用主机最新样本" : "未烧录摇杆"} · 未校准视频与遥控同步。</p>
            </>
          ) : <p>暂无已确认保存的录像。</p>}
        </div>
      </div>
    </section>
  );
}
