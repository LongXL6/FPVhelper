import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AnalyticsTokenReplacementAction,
  AnalyticsWorkstationId,
} from "./analytics-workstation-id";

const WORKSTATION_ID = "10000000-0000-4000-8000-000000000001";

describe("AnalyticsWorkstationId", () => {
  it("renders the complete provisionable ID without implying analytics is active", () => {
    const markup = renderToStaticMarkup(<AnalyticsWorkstationId workstationId={WORKSTATION_ID} />);

    expect(markup).toContain(WORKSTATION_ID);
    expect(markup).toContain("复制完整 ID");
    expect(markup).not.toContain("已开启");
    expect(markup).not.toContain("fpvh_ingest_");
  });

  it("provides an explicit token replacement action while analytics is enabled", () => {
    const onReplace = vi.fn();
    const action = <AnalyticsTokenReplacementAction onReplace={onReplace} />;
    const markup = renderToStaticMarkup(action);

    expect(markup).toContain("更换工作站令牌");
    action.props.onReplace();
    expect(onReplace).toHaveBeenCalledOnce();
  });
});
