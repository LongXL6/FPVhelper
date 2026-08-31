import { clamp } from "./telemetry";

export interface StickOverlayLayout {
  xPercent: number;
  yPercent: number;
  size: number;
}

export type StickOverlayMember = "left" | "right";

export interface StickOverlayPairLayout {
  left: StickOverlayLayout;
  right: StickOverlayLayout;
  docked: boolean;
  locked: boolean;
}

const OVERLAY_PADDING = 8;
const MIN_OVERLAY_SIZE = 84;
const MAX_OVERLAY_SIZE = 260;
const OVERLAY_SNAP_DISTANCE = 24;

interface PixelLayout {
  x: number;
  y: number;
  size: number;
}

function toPixels(layout: StickOverlayLayout, areaWidth: number, areaHeight: number): PixelLayout {
  return {
    x: (layout.xPercent / 100) * areaWidth,
    y: (layout.yPercent / 100) * areaHeight,
    size: layout.size,
  };
}

function fromPixels(layout: PixelLayout, areaWidth: number, areaHeight: number): StickOverlayLayout {
  return {
    xPercent: Number(((layout.x / areaWidth) * 100).toFixed(4)),
    yPercent: Number(((layout.y / areaHeight) * 100).toFixed(4)),
    size: Number(layout.size.toFixed(2)),
  };
}

function constrainDockedStickOverlayPair(
  pair: StickOverlayPairLayout,
  areaWidth: number,
  areaHeight: number,
): StickOverlayPairLayout {
  if (areaWidth <= 0 || areaHeight <= 0) return pair;

  const maximumSize = Math.max(1, Math.min(
    MAX_OVERLAY_SIZE,
    (areaWidth - OVERLAY_PADDING * 2) / 2,
    areaHeight - OVERLAY_PADDING * 2,
  ));
  const minimumSize = Math.min(MIN_OVERLAY_SIZE, maximumSize);
  const size = clamp(pair.left.size, minimumSize, maximumSize);
  const maximumX = Math.max(OVERLAY_PADDING, areaWidth - size * 2 - OVERLAY_PADDING);
  const maximumY = Math.max(OVERLAY_PADDING, areaHeight - size - OVERLAY_PADDING);
  const leftPixels = toPixels(pair.left, areaWidth, areaHeight);
  const x = clamp(leftPixels.x, OVERLAY_PADDING, maximumX);
  const y = clamp(leftPixels.y, OVERLAY_PADDING, maximumY);

  return {
    left: fromPixels({ x, y, size }, areaWidth, areaHeight),
    right: fromPixels({ x: x + size, y, size }, areaWidth, areaHeight),
    docked: true,
    locked: pair.locked,
  };
}

function layoutsOverlap(first: PixelLayout, second: PixelLayout) {
  return first.x < second.x + second.size
    && first.x + first.size > second.x
    && first.y < second.y + second.size
    && first.y + first.size > second.y;
}

function keepPairMembersSeparate(
  pair: StickOverlayPairLayout,
  member: StickOverlayMember,
  areaWidth: number,
  areaHeight: number,
) {
  const active = toPixels(pair[member], areaWidth, areaHeight);
  const peerMember = member === "left" ? "right" : "left";
  const peer = toPixels(pair[peerMember], areaWidth, areaHeight);
  if (!layoutsOverlap(active, peer)) return pair;

  const candidates: PixelLayout[] = [
    { ...active, x: peer.x - active.size },
    { ...active, x: peer.x + peer.size },
    { ...active, y: peer.y - active.size },
    { ...active, y: peer.y + peer.size },
  ].filter((candidate) => (
    candidate.x >= OVERLAY_PADDING
    && candidate.y >= OVERLAY_PADDING
    && candidate.x + candidate.size <= areaWidth - OVERLAY_PADDING
    && candidate.y + candidate.size <= areaHeight - OVERLAY_PADDING
  ));
  const closest = candidates.sort((first, second) => (
    Math.abs(first.x - active.x) + Math.abs(first.y - active.y)
    - Math.abs(second.x - active.x) - Math.abs(second.y - active.y)
  ))[0];
  if (!closest) return pair;

  return {
    ...pair,
    [member]: fromPixels(closest, areaWidth, areaHeight),
  };
}

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

export function constrainStickOverlayPairLayout(
  pair: StickOverlayPairLayout,
  areaWidth: number,
  areaHeight: number,
) {
  if (pair.docked) return constrainDockedStickOverlayPair(pair, areaWidth, areaHeight);
  return {
    left: constrainStickOverlayLayout(pair.left, areaWidth, areaHeight),
    right: constrainStickOverlayLayout(pair.right, areaWidth, areaHeight),
    docked: false,
    locked: false,
  };
}

export function moveStickOverlayPairLayout(
  pair: StickOverlayPairLayout,
  member: StickOverlayMember,
  deltaX: number,
  deltaY: number,
  areaWidth: number,
  areaHeight: number,
) {
  const constrained = constrainStickOverlayPairLayout(pair, areaWidth, areaHeight);
  if (constrained.docked && constrained.locked) {
    const left = toPixels(constrained.left, areaWidth, areaHeight);
    const maximumX = Math.max(OVERLAY_PADDING, areaWidth - left.size * 2 - OVERLAY_PADDING);
    const maximumY = Math.max(OVERLAY_PADDING, areaHeight - left.size - OVERLAY_PADDING);
    const movedLeft = fromPixels({
      x: clamp(left.x + deltaX, OVERLAY_PADDING, maximumX),
      y: clamp(left.y + deltaY, OVERLAY_PADDING, maximumY),
      size: left.size,
    }, areaWidth, areaHeight);
    return constrainDockedStickOverlayPair({ ...constrained, left: movedLeft }, areaWidth, areaHeight);
  }

  const moved = {
    ...constrained,
    [member]: moveStickOverlayLayout(constrained[member], deltaX, deltaY, areaWidth, areaHeight),
    docked: false,
    locked: false,
  };
  return keepPairMembersSeparate(moved, member, areaWidth, areaHeight);
}

export function resizeStickOverlayPairLayout(
  pair: StickOverlayPairLayout,
  member: StickOverlayMember,
  delta: number,
  areaWidth: number,
  areaHeight: number,
) {
  const constrained = constrainStickOverlayPairLayout(pair, areaWidth, areaHeight);
  if (constrained.docked && constrained.locked) {
    return constrainDockedStickOverlayPair({
      ...constrained,
      left: { ...constrained.left, size: constrained.left.size + delta },
    }, areaWidth, areaHeight);
  }

  const resized = {
    ...constrained,
    [member]: resizeStickOverlayLayout(constrained[member], delta, areaWidth, areaHeight),
    docked: false,
    locked: false,
  };
  return keepPairMembersSeparate(resized, member, areaWidth, areaHeight);
}

export function snapStickOverlayLayoutToEdges(
  layout: StickOverlayLayout,
  areaWidth: number,
  areaHeight: number,
) {
  const constrained = constrainStickOverlayLayout(layout, areaWidth, areaHeight);
  const pixels = toPixels(constrained, areaWidth, areaHeight);
  const maximumX = areaWidth - pixels.size - OVERLAY_PADDING;
  const maximumY = areaHeight - pixels.size - OVERLAY_PADDING;
  if (Math.abs(pixels.x - OVERLAY_PADDING) <= OVERLAY_SNAP_DISTANCE) pixels.x = OVERLAY_PADDING;
  if (Math.abs(pixels.x - maximumX) <= OVERLAY_SNAP_DISTANCE) pixels.x = maximumX;
  if (Math.abs(pixels.y - OVERLAY_PADDING) <= OVERLAY_SNAP_DISTANCE) pixels.y = OVERLAY_PADDING;
  if (Math.abs(pixels.y - maximumY) <= OVERLAY_SNAP_DISTANCE) pixels.y = maximumY;
  return fromPixels(pixels, areaWidth, areaHeight);
}

export function finishStickOverlayPairInteraction(
  pair: StickOverlayPairLayout,
  member: StickOverlayMember,
  areaWidth: number,
  areaHeight: number,
) {
  if (pair.docked && pair.locked) {
    const constrained = constrainDockedStickOverlayPair(pair, areaWidth, areaHeight);
    const left = snapStickOverlayLayoutToEdges(constrained.left, areaWidth, areaHeight);
    return constrainDockedStickOverlayPair({ ...constrained, left }, areaWidth, areaHeight);
  }

  const constrained = constrainStickOverlayPairLayout({
    ...pair,
    [member]: snapStickOverlayLayoutToEdges(pair[member], areaWidth, areaHeight),
  }, areaWidth, areaHeight);
  const left = toPixels(constrained.left, areaWidth, areaHeight);
  const right = toPixels(constrained.right, areaWidth, areaHeight);
  const edgesAreClose = Math.abs(left.x + left.size - right.x) <= OVERLAY_SNAP_DISTANCE;
  const rowsAreClose = Math.abs((left.y + left.size / 2) - (right.y + right.size / 2)) <= OVERLAY_SNAP_DISTANCE;
  if (!edgesAreClose || !rowsAreClose) return constrained;

  const size = constrained[member].size;
  const anchorX = member === "left" ? right.x - size : left.x;
  const anchorY = member === "left" ? right.y : left.y;
  return constrainDockedStickOverlayPair({
    left: fromPixels({ x: anchorX, y: anchorY, size }, areaWidth, areaHeight),
    right: constrained.right,
    docked: true,
    locked: false,
  }, areaWidth, areaHeight);
}

export function stickOverlayPairIsDefault(
  pair: StickOverlayPairLayout,
  defaultPair: StickOverlayPairLayout,
) {
  return JSON.stringify(pair) === JSON.stringify(defaultPair);
}
