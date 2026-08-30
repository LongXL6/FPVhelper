import { describe, expect, it } from "vitest";
import {
  constrainStickOverlayLayout,
  moveStickOverlayLayout,
  resizeStickOverlayLayout,
} from "./stick-overlay-layout";

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
});
