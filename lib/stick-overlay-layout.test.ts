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
  left: { xPercent: 10, yPercent: 20, size: 100 },
  right: { xPercent: 22.5, yPercent: 20, size: 100 },
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
    const resized = resizeStickOverlayLayout({ xPercent: 70, yPercent: 50, size: 120 }, 500, 600, 400);
    expect(resized.size).toBe(172);
    expect(resized.xPercent).toBe(70);
  });

  it("allows the compact mode to shrink to a small live frame", () => {
    expect(constrainStickOverlayLayout({ xPercent: 10, yPercent: 10, size: 20 }, 500, 400).size).toBe(84);
  });

  it("magnetically snaps an overlay into a stage corner", () => {
    expect(snapStickOverlayLayoutToEdges({ xPercent: 3, yPercent: 75, size: 100 }, 800, 500)).toEqual({
      xPercent: 1,
      yPercent: 78.4,
      size: 100,
    });
  });

  it("docks nearby equalized overlays without overlap", () => {
    const pair = finishStickOverlayPairInteraction({
      left: { xPercent: 25, yPercent: 30, size: 120 },
      right: { xPercent: 40.5, yPercent: 31, size: 110 },
      docked: false,
      locked: false,
    }, "right", 800, 500);

    expect(pair).toEqual({
      left: { xPercent: 25, yPercent: 30, size: 110 },
      right: { xPercent: 38.75, yPercent: 30, size: 110 },
      docked: true,
      locked: false,
    });
  });

  it("moves a locked pair as one unit", () => {
    expect(moveStickOverlayPairLayout(DOCKED_PAIR, "right", 50, 20, 800, 500)).toEqual({
      left: { xPercent: 16.25, yPercent: 24, size: 100 },
      right: { xPercent: 28.75, yPercent: 24, size: 100 },
      docked: true,
      locked: true,
    });
  });

  it("resizes both members of a locked pair", () => {
    expect(resizeStickOverlayPairLayout(DOCKED_PAIR, "left", 30, 800, 500)).toEqual({
      left: { xPercent: 10, yPercent: 20, size: 130 },
      right: { xPercent: 26.25, yPercent: 20, size: 130 },
      docked: true,
      locked: true,
    });
  });

  it("keeps independently moved overlays from crossing", () => {
    const pair = moveStickOverlayPairLayout({
      left: { xPercent: 10, yPercent: 20, size: 120 },
      right: { xPercent: 40, yPercent: 20, size: 120 },
      docked: false,
      locked: false,
    }, "left", 180, 0, 800, 500);

    expect(pair.left.xPercent).toBe(25);
    expect(pair.right.xPercent).toBe(40);
  });
});
