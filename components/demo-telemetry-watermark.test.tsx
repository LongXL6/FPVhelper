import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DemoTelemetryWatermark } from "./demo-telemetry-watermark";

describe("DemoTelemetryWatermark", () => {
  it("labels demo telemetry as non-real training data", () => {
    const markup = renderToStaticMarkup(<DemoTelemetryWatermark source="demo" />);

    expect(markup).toContain("演示数据 / 非真实训练");
    expect(markup).toContain('role="status"');
  });

  it("disappears for a real serial source", () => {
    expect(renderToStaticMarkup(<DemoTelemetryWatermark source="serial" />)).toBe("");
  });
});
