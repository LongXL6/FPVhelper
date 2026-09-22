import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DraggableStickOverlay } from "./draggable-stick-overlay";
import type { StickOverlayPairLayout } from "../lib/stick-overlay-layout";

vi.mock("@/lib/telemetry", () => import("../lib/telemetry"));
vi.mock("@/lib/stick-overlay-layout", () => import("../lib/stick-overlay-layout"));

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("accessible stick overlay layout", () => {
  it.each([[-40, 0], [0, -40], [-40, 5]])("shrinks with pointer movement %s, %s instead of discarding the negative delta", (deltaX, deltaY) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const pair: StickOverlayPairLayout = {
      left: { xPercent: 10, yPercent: 30, size: 140 },
      right: { xPercent: 50, yPercent: 30, size: 140 }, docked: false, locked: false,
    };
    const onPairChange = vi.fn();
    act(() => {
      renderer = create(<DraggableStickOverlay member="left" pairLayout={pair} label="左摇杆" xLabel="YAW" yLabel="THR" x={0} y={0} tone="orange" mode="trail" trail={[]} peak={null} onPairChange={onPairChange} onToggleLock={() => undefined} />, {
        createNodeMock: () => ({ parentElement: { getBoundingClientRect: () => ({ width: 1000, height: 600 }) } }),
      });
    });
    const target = { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() };
    const event = (clientX: number, clientY: number) => ({ clientX, clientY, pointerId: 1, currentTarget: target, preventDefault: vi.fn() });
    const handle = renderer!.root.findByProps({ "aria-label": "调整左摇杆大小" });
    act(() => handle.props.onPointerDown(event(100, 100)));
    act(() => handle.props.onPointerMove(event(100 + deltaX, 100 + deltaY)));
    expect(onPairChange.mock.lastCall?.[0].left.size).toBe(100);
    expect(onPairChange.mock.lastCall?.[0].right.size).toBe(140);
    act(() => handle.props.onPointerUp(event(100 + deltaX, 100 + deltaY)));
    expect(onPairChange.mock.lastCall?.[1]).toBe(true);
  });

  it.each(["trail", "simple"] as const)("keeps endpoints and origin in %s mode with matching readout units", (mode) => {
    const pair: StickOverlayPairLayout = {
      left: { xPercent: 10, yPercent: 30, size: 132 },
      right: { xPercent: 50, yPercent: 30, size: 132 },
      docked: false, locked: false,
    };
    const html = renderToStaticMarkup(<DraggableStickOverlay member="left" pairLayout={pair} label="左摇杆" xLabel="YAW" yLabel="THR" x={-100} y={100} tone="orange" mode={mode} trail={[]} peak={null} onPairChange={() => undefined} onToggleLock={() => undefined} />);
    expect(html).toContain("YAW -1000，THR +1000");
    expect(html.match(/stick-tick--(?:left|right|top|bottom|zero)/g)).toHaveLength(5);
    expect(html).toContain("<b>-1000</b>");
    expect(html).toContain("<b>+1000</b>");
  });

  it("moves and resizes a locked pair from the keyboard, and ignores hidden stages", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const pair: StickOverlayPairLayout = {
      left: { xPercent: 10, yPercent: 30, size: 150 },
      right: { xPercent: 25, yPercent: 30, size: 150 },
      docked: true, locked: true,
    };
    const onPairChange = vi.fn();
    let width = 1000;
    act(() => {
      renderer = create(<DraggableStickOverlay member="left" pairLayout={pair} label="左摇杆" xLabel="YAW" yLabel="THR" x={0} y={0} tone="orange" mode="trail" trail={[]} peak={null} onPairChange={onPairChange} onToggleLock={() => undefined} />, {
        createNodeMock: () => ({ parentElement: { getBoundingClientRect: () => ({ width, height: 600 }) } }),
      });
    });
    onPairChange.mockClear();
    const event = (key: string) => ({ key, shiftKey: true, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    act(() => renderer!.root.findByProps({ "aria-label": "拖动左摇杆" }).props.onKeyDown(event("ArrowRight")));
    const moved = onPairChange.mock.lastCall![0] as StickOverlayPairLayout;
    expect(moved.left.xPercent).toBe(11);
    expect(moved.right.xPercent).toBe(26);
    expect(moved.locked).toBe(true);
    act(() => renderer!.root.findByProps({ "aria-label": "调整左摇杆大小" }).props.onKeyDown(event("ArrowDown")));
    const resized = onPairChange.mock.lastCall![0] as StickOverlayPairLayout;
    expect(resized.left.size).toBe(160);
    expect(resized.right.size).toBe(160);
    width = 0;
    onPairChange.mockClear();
    act(() => renderer!.root.findByProps({ "aria-label": "拖动左摇杆" }).props.onKeyDown(event("ArrowRight")));
    expect(onPairChange).not.toHaveBeenCalled();
  });
});
