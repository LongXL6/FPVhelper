import type { TelemetrySource } from "@/lib/telemetry";

export function DemoTelemetryWatermark({ source }: { source: TelemetrySource }) {
  if (source !== "demo") return null;

  return (
    <div className="demo-watermark" role="status" aria-label="演示数据，非真实训练">
      <span>DEMO FEED</span>
      <b>演示数据 / 非真实训练</b>
    </div>
  );
}
