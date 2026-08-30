import { clamp } from "./telemetry";

export interface StickOverlayLayout {
  xPercent: number;
  yPercent: number;
  size: number;
}

const OVERLAY_PADDING = 8;
const MIN_OVERLAY_SIZE = 84;
const MAX_OVERLAY_SIZE = 260;

export function constrainStickOverlayLayout(
  layout: StickOverlayLayout,
  areaWidth: number,
  areaHeight: number,
): StickOverlayLayout {
  if (areaWidth <= 0 || areaHeight <= 0) return layout;

  const maximumSize = Math.max(72, Math.min(MAX_OVERLAY_SIZE, areaWidth - OVERLAY_PADDING * 2, areaHeight - OVERLAY_PADDING * 2));
  const minimumSize = Math.min(MIN_OVERLAY_SIZE, maximumSize);
  const size = clamp(layout.size, minimumSize, maximumSize);
  const maximumX = Math.max(OVERLAY_PADDING, areaWidth - size - OVERLAY_PADDING);
  const maximumY = Math.max(OVERLAY_PADDING, areaHeight - size - OVERLAY_PADDING);
  const x = clamp((layout.xPercent / 100) * areaWidth, OVERLAY_PADDING, maximumX);
  const y = clamp((layout.yPercent / 100) * areaHeight, OVERLAY_PADDING, maximumY);

  return {
    xPercent: Number(((x / areaWidth) * 100).toFixed(4)),
    yPercent: Number(((y / areaHeight) * 100).toFixed(4)),
    size: Number(size.toFixed(2)),
  };
}

export function moveStickOverlayLayout(
  layout: StickOverlayLayout,
  deltaX: number,
  deltaY: number,
  areaWidth: number,
  areaHeight: number,
) {
  const constrained = constrainStickOverlayLayout(layout, areaWidth, areaHeight);
  return constrainStickOverlayLayout(
    {
      ...constrained,
      xPercent: (((constrained.xPercent / 100) * areaWidth + deltaX) / areaWidth) * 100,
      yPercent: (((constrained.yPercent / 100) * areaHeight + deltaY) / areaHeight) * 100,
    },
    areaWidth,
    areaHeight,
  );
}

export function resizeStickOverlayLayout(
  layout: StickOverlayLayout,
  delta: number,
  areaWidth: number,
  areaHeight: number,
) {
  const constrained = constrainStickOverlayLayout(layout, areaWidth, areaHeight);
  const x = (constrained.xPercent / 100) * areaWidth;
  const y = (constrained.yPercent / 100) * areaHeight;
  const maximumSize = Math.max(72, Math.min(MAX_OVERLAY_SIZE, areaWidth - x - OVERLAY_PADDING, areaHeight - y - OVERLAY_PADDING));
  const minimumSize = Math.min(MIN_OVERLAY_SIZE, maximumSize);

  return constrainStickOverlayLayout(
    { ...constrained, size: clamp(constrained.size + delta, minimumSize, maximumSize) },
    areaWidth,
    areaHeight,
  );
}
