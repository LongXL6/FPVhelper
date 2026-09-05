import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PilotChannelConfig } from "@/lib/video-workspace";
import { PilotNameField } from "./pilot-name-field";

let renderer: ReactTestRenderer | undefined;
const onChange = vi.fn();
const onUseDeviceName = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function channel(id = "pilot-1", athleteCode = "", athleteCodeMode: "auto" | "manual" = "auto"): PilotChannelConfig {
  return {
    id, athleteCode, athleteCodeMode, sourceId: "source-1", slot: 0,
    gateProfileId: null, videoProfileId: null, viewMode: "full",
    crop: { xPercent: 0, yPercent: 0, widthPercent: 100, heightPercent: 100 },
  };
}

function renderChannel(current: PilotChannelConfig) {
  const element = <PilotNameField channel={current} disabled={false} onChange={onChange} onUseDeviceName={onUseDeviceName} />;
  act(() => {
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}
const input = () => renderer!.root.findByType("input");
function focusInput() {
  act(() => input().props.onFocus?.({ currentTarget: { value: input().props.value } }));
}

it("keeps the focused text stable when a device name arrives before the first manual input", () => {
  renderChannel(channel());
  focusInput();
  renderChannel(channel("pilot-1", "LATE-PILOT"));
  expect(input().props.value).toBe("");
  expect(onChange).not.toHaveBeenCalled();

  act(() => input().props.onChange({ target: { value: "VIDEO-01" } }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("VIDEO-01");
  renderChannel(channel("pilot-1", "VIDEO-01", "manual"));
  act(() => input().props.onBlur?.());
  expect(input().props.value).toBe("VIDEO-01");
});

it("resumes the latest automatic name on an unedited blur without persisting a manual name", () => {
  renderChannel(channel("pilot-1", "BEFORE"));
  focusInput();
  renderChannel(channel("pilot-1", "AFTER"));
  expect(input().props.value).toBe("BEFORE");
  act(() => input().props.onBlur?.());
  expect(input().props.value).toBe("AFTER");
  expect(onChange).not.toHaveBeenCalled();
});

it("discards a focused draft when the selected pilot changes, including a later return", () => {
  renderChannel(channel("pilot-1", "ALPHA"));
  focusInput();
  act(() => input().props.onChange({ target: { value: "ALPHA EDIT" } }));
  renderChannel(channel("pilot-2", "BRAVO"));
  expect(input().props.value).toBe("BRAVO");
  renderChannel(channel("pilot-1", "ALPHA NEW"));
  expect(input().props.value).toBe("ALPHA NEW");
  expect(onChange).toHaveBeenCalledExactlyOnceWith("ALPHA EDIT");
});
