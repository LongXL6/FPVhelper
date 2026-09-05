import { describe, expect, it } from "vitest";
import {
  constrainStickOverlayLayout,
  finishStickOverlayPairInteraction,
  moveStickOverlayLayout,
  moveStickOverlayPairLayout,
  resizeStickOverlayLayout,
  resizeStickOverlayPairLayout,
  snapStickOverlayLayoutToEdges,
  type StickOverlayPairLayout,
} from "./stick-overlay-layout";

const DOCKED_PAIR: StickOverlayPairLayout = {
  left: { xPercent: 10, yPercent: 20, size: 140 },
  right: { xPercent: 27.5, yPercent: 20, size: 140 },
  docked: true,
  locked: true,
};

describe("stick overlay layout", () => {
  it("keeps an overlay inside the video stage", () => {
    expect(constrainStickOverlayLayout({ xPercent: 95, yPercent: 95, size: 180 }, 800, 500)).toEqual({
      xPercent: 76.5,
      yPercent: 62.4,
      size: 180,
    });
  });

  it("clamps drag movement against every edge", () => {
    expect(moveStickOverlayLayout({ xPercent: 20, yPercent: 20, size: 140 }, -1000, -1000, 600, 400)).toMatchObject({
      xPercent: 1.3333,
      yPercent: 2,
    });
  });

  it("limits resize to the remaining stage space", () => {
    const resized = resizeStickOverlayLayout({ xPercent: 70, yPercent: 50, size: 140 }, 500, 600, 400);
    expect(resized.size).toBe(172);
    expect(resized.xPercent).toBe(70);
  });

  it("keeps compact overlays large enough for their axis labels", () => {
    expect(constrainStickOverlayLayout({ xPercent: 10, yPercent: 10, size: 20 }, 500, 400).size).toBe(132);
    expect(resizeStickOverlayLayout({ xPercent: 10, yPercent: 10, size: 180 }, -1000, 500, 400).size).toBe(132);
  });

  it("magnetically snaps an overlay into a stage corner", () => {
    expect(snapStickOverlayLayoutToEdges({ xPercent: 3, yPercent: 69, size: 140 }, 800, 500)).toEqual({
      xPercent: 1,
      yPercent: 70.4,
      size: 140,
    });
  });

  it("docks nearby equalized overlays without overlap", () => {
    const pair = finishStickOverlayPairInteraction({
      left: { xPercent: 25, yPercent: 30, size: 150 },
      right: { xPercent: 44.25, yPercent: 31, size: 140 },
      docked: false,
      locked: false,
    }, "right", 800, 500);

    expect(pair).toEqual({
      left: { xPercent: 25, yPercent: 30, size: 140 },
      right: { xPercent: 42.5, yPercent: 30, size: 140 },
      docked: true,
      locked: false,
    });
  });

  it("moves a locked pair as one unit", () => {
    expect(moveStickOverlayPairLayout(DOCKED_PAIR, "right", 50, 20, 800, 500)).toEqual({
      left: { xPercent: 16.25, yPercent: 24, size: 140 },
      right: { xPercent: 33.75, yPercent: 24, size: 140 },
      docked: true,
      locked: true,
    });
  });

  it("resizes both members of a locked pair", () => {
    expect(resizeStickOverlayPairLayout(DOCKED_PAIR, "left", 30, 800, 500)).toEqual({
      left: { xPercent: 10, yPercent: 20, size: 170 },
      right: { xPercent: 31.25, yPercent: 20, size: 170 },
      docked: true,
      locked: true,
    });
  });

  it("applies the readable minimum to both members when shrinking a locked pair", () => {
    expect(resizeStickOverlayPairLayout(DOCKED_PAIR, "right", -1000, 800, 500)).toEqual({
      left: { xPercent: 10, yPercent: 20, size: 132 },
      right: { xPercent: 26.5, yPercent: 20, size: 132 },
      docked: true,
      locked: true,
    });
  });

  it("lets a locked pair fit a stage smaller than the readable minimum", () => {
    expect(resizeStickOverlayPairLayout(DOCKED_PAIR, "left", -1000, 200, 100)).toEqual({
      left: { xPercent: 10, yPercent: 8, size: 84 },
      right: { xPercent: 52, yPercent: 8, size: 84 },
      docked: true,
      locked: true,
    });
  });

  it("keeps independently moved overlays from crossing", () => {
    const pair = moveStickOverlayPairLayout({
      left: { xPercent: 10, yPercent: 20, size: 140 },
      right: { xPercent: 40, yPercent: 20, size: 140 },
      docked: false,
      locked: false,
    }, "left", 180, 0, 800, 500);

    expect(pair.left.xPercent).toBe(22.5);
    expect(pair.right.xPercent).toBe(40);
  });
});
