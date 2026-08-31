import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnalyticsWorkstationId } from "./analytics-workstation-id";

const WORKSTATION_ID = "10000000-0000-4000-8000-000000000001";

describe("AnalyticsWorkstationId", () => {
  it("renders the complete provisionable ID without implying analytics is active", () => {
    const markup = renderToStaticMarkup(<AnalyticsWorkstationId workstationId={WORKSTATION_ID} />);

    expect(markup).toContain(WORKSTATION_ID);
    expect(markup).toContain("复制完整 ID");
    expect(markup).not.toContain("已开启");
    expect(markup).not.toContain("fpvh_ingest_");
  });
});
