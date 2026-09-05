import { clamp } from "./telemetry";

// Presentation units only. Stored RC channels and percentages keep their original units.
export function stickAxisValue(centeredPercent: number) {
  return Math.round(clamp(centeredPercent, -100, 100) * 10);
}

export function formatStickAxisValue(centeredPercent: number) {
  const value = stickAxisValue(centeredPercent);
  return value > 0 ? `+${value}` : String(value);
}
