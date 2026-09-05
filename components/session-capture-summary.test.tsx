import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { calculateTrainingCaptureQuality, createTrainingCaptureContext } from "@/lib/training-capture-quality";
import type { TrainingSession } from "@/lib/training-session";
import { SessionCaptureSummary } from "./session-capture-summary";

const noVideo = { recorded: false, synchronized: false } as const;

describe("SessionCaptureSummary", () => {
  it("shows missing legacy quality and receipt as unrecorded rather than zero", () => {
    const html = renderToStaticMarkup(<SessionCaptureSummary session={{ video: noVideo }} />);
    expect(html).toContain("这条记录未记录采集质量");
    expect(html).toContain("暂无已确认保存的录像");
    expect(html).not.toContain("间隔中位数");
    expect(html).not.toContain("缺口：0");
    expect(html).not.toContain("已烧录摇杆");
  });

  it("shows observed intervals, batching anomalies and gaps as host quality only", () => {
    const captureQuality = calculateTrainingCaptureQuality([0, 10, 10, 110].map((elapsedMs) => ({ elapsedMs, source: "ground_rc" })));
    const html = renderToStaticMarkup(<SessionCaptureSummary session={{ video: noVideo, captureQuality, captureContext: createTrainingCaptureContext() }} />);
    expect(html).toContain("目标 100 Hz");
    expect(html).toContain("真实遥控");
    expect(html).toContain("P95 间隔");
    expect(html).toContain("95.5");
    expect(html).toContain("P99 间隔");
    expect(html).toContain("99.1");
    expect(html).toContain("大于 50 ms 的缺口：1");
    expect(html).toContain("异常间隔：1");
    expect(html).toContain("不代表 RF 丢包");
  });

  it("labels demo and refuses to show null interval statistics as zero", () => {
    const captureQuality = calculateTrainingCaptureQuality([{ elapsedMs: 0, source: "demo" }]);
    const html = renderToStaticMarkup(<SessionCaptureSummary session={{ video: noVideo, captureQuality }} />);
    expect(html).toContain("演示（模拟）");
    expect(html.match(/未测得/g)).toHaveLength(4);
    expect(html).toContain("采集上下文未记录");
  });

  it("shows the saved receipt, burned overlay and uncalibrated timing", () => {
    const video: TrainingSession["video"] = {
      recorded: true, synchronized: false, receiptVersion: 1,
      receiptEvidence: "write_and_close_resolved", filename: "pilot.webm", bytes: 12_345,
      mimeType: "video/webm", startedAtEpochMs: 1_700_000_000_000, finishedAtEpochMs: 1_700_000_010_000,
      overlay: "sticks", overlayTiming: "latest_available_host_sample",
    };
    const html = renderToStaticMarkup(<SessionCaptureSummary session={{ video }} />);
    expect(html).toContain("pilot.webm · 12,345 字节");
    expect(html).toContain("已烧录摇杆，使用主机最新样本");
    expect(html).toContain("未校准视频与遥控同步");
    expect(html).not.toContain("暂无已确认保存的录像");
    const plain = renderToStaticMarkup(<SessionCaptureSummary session={{ video: { ...video, overlay: "none", overlayTiming: "none" } }} />);
    expect(plain).toContain("未烧录摇杆");
  });
});
