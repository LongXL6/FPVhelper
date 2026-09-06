"use client";

import { useEffect, useMemo, useState } from "react";
import { liveThrottleSegments, type LiveThrottleSample } from "@/lib/live-throttle-history";
import { measurementEnabled, measurementEvent } from "@/lib/capture-measurement";

export function ThrottleTimeline({ samples, active = true }: { samples: readonly LiveThrottleSample[]; active?: boolean }) {
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    if (!active) return;
    // The clock must advance even when RC reception stops. Keep this tick local
    // to the visible chart; it never publishes or changes telemetry samples.
    if (measurementEnabled()) measurementEvent("throttle.timer.start", { intervalMs: 50, active });
    const timer = setInterval(() => {
      if (measurementEnabled()) measurementEvent("throttle.tick", { intervalMs: 50, active });
      setNowMs(performance.now());
    }, 50);
    return () => {
      clearInterval(timer);
      if (measurementEnabled()) measurementEvent("throttle.timer.stop", { intervalMs: 50, active });
    };
  }, [active]);
  const segments = useMemo(() => liveThrottleSegments(samples, nowMs), [nowMs, samples]);

  return (
    <div className="timeline-plot" aria-label="最近三秒的油门曲线">
      <svg viewBox="0 0 640 104" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1="24" x2="640" y2="24" />
        <line x1="0" y1="60" x2="640" y2="60" />
        <line x1="0" y1="96" x2="640" y2="96" />
        {segments.map((segment, index) => segment.length === 1
          ? <circle key={index} cx={segment[0].x} cy={segment[0].y} r="2" fill="var(--alert)" />
          : <polyline key={index} points={segment.map(({ x, y }) => `${x},${y}`).join(" ")} />)}
      </svg>
      <div className="timeline-labels"><span>-3.0 s</span><span>现在</span></div>
      <p className="session-save-feedback">按主机接收时间显示；空白表示无连续观测，不代表无线丢包。</p>
    </div>
  );
}
