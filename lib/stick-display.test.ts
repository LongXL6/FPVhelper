import { describe, expect, it } from "vitest";
import { formatStickAxisValue, stickAxisValue } from "./stick-display";
import { normalizeRcAxis, normalizeThrottle } from "./telemetry";

describe("stick display units", () => {
  it.each([[1000, -1000], [1250, -500], [1500, 0], [1750, 500], [2000, 1000]])(
    "maps raw RC %i to centered travel %i on every axis",
    (raw, expected) => {
      expect(stickAxisValue(normalizeRcAxis(raw))).toBe(expected);
      expect(stickAxisValue(normalizeThrottle(raw) * 2 - 100)).toBe(expected);
    },
  );

  it("clamps display endpoints, retains signs and rounds only after scaling", () => {
    expect(formatStickAxisValue(-130)).toBe("-1000");
    expect(formatStickAxisValue(130)).toBe("+1000");
    expect(formatStickAxisValue(0)).toBe("0");
    expect(formatStickAxisValue(-0.01)).toBe("0");
    expect(formatStickAxisValue(1.25)).toBe("+13");
  });
});
