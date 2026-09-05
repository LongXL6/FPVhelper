import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceVideoElement } from "./video-workspace-display";

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("keeps a recording crop drawing without relying on visible-video compositor callbacks", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("HTMLMediaElement", { HAVE_CURRENT_DATA: 2 });
  let drawNextFrame: FrameRequestCallback | undefined;
  const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => { drawNextFrame = callback; return 7; });
  const cancelAnimationFrame = vi.fn();
  vi.stubGlobal("window", { requestAnimationFrame, cancelAnimationFrame });
  const drawImage = vi.fn();
  const video = {
    readyState: 2, videoWidth: 640, videoHeight: 480,
    requestVideoFrameCallback: vi.fn(() => 42), cancelVideoFrameCallback: vi.fn(),
  };
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }) };
  const props = {
    sourceId: "source-1", pilotChannelId: "pilot-1", cropped: true,
    crop: { xPercent: 50, yPercent: 0, widthPercent: 50, heightPercent: 50 },
    registerVideoElement: () => undefined, registerOutputCanvas: () => undefined,
  };
  act(() => {
    renderer = create(<WorkspaceVideoElement {...props} keepFramesActive={false} />, {
      createNodeMock: (element) => element.type === "video" ? video : canvas,
    });
  });
  expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(1);
  act(() => renderer!.update(<WorkspaceVideoElement {...props} keepFramesActive />));
  expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(42);
  expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  act(() => drawNextFrame!(0));
  expect(drawImage).toHaveBeenCalledWith(video, 320, 0, 320, 240, 0, 0, 320, 240);
  expect(canvas.width).toBe(320);
  expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
  act(() => renderer!.unmount());
  renderer = undefined;
  expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
});
