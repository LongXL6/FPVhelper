import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AnalyticsTokenReplacementAction,
  AnalyticsWorkstationId,
  prepareAnalyticsTokenReplacementAction,
} from "./analytics-workstation-id";
import type { AnalyticsLocalStatus } from "../lib/analytics/client";

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

  it("uses the dashboard action path to transition enabled into waiting replacement", () => {
    const controller: {
      status: AnalyticsLocalStatus;
      prepareTokenReplacement: () => boolean;
    } = {
      status: { state: "enabled", reason: "installed" },
      prepareTokenReplacement: () => {
        controller.status = {
          state: "waiting_token",
          reason: "replacement",
          workstationId: WORKSTATION_ID,
        };
        return true;
      },
    };

    const result = prepareAnalyticsTokenReplacementAction(controller);

    expect(result.prepared).toBe(true);
    expect(result.message).toContain("发送已暂停");
    expect(controller.status).toEqual({
      state: "waiting_token",
      reason: "replacement",
      workstationId: WORKSTATION_ID,
    });
  });
});
