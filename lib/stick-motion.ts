export interface StickPosition {
  x: number;
  y: number;
}

export interface StickMotionSample {
  sequence: number;
  left: StickPosition;
  right: StickPosition;
}

export interface StickPeakTracker {
  neutral: StickPosition;
  active: boolean;
  currentPeak: StickPosition | null;
  currentPeakDistance: number;
  lastCompletedPeak: StickPosition | null;
}

export interface StickMotionVisualization {
  samples: StickMotionSample[];
  leftPeak: StickPosition | null;
  rightPeak: StickPosition | null;
}

export const EMPTY_STICK_MOTION: StickMotionVisualization = {
  samples: [],
  leftPeak: null,
  rightPeak: null,
};

export function createStickPeakTracker(neutral: StickPosition): StickPeakTracker {
  return {
    neutral,
    active: false,
    currentPeak: null,
    currentPeakDistance: 0,
    lastCompletedPeak: null,
  };
}

function distanceFromNeutral(point: StickPosition, neutral: StickPosition) {
  return Math.hypot(point.x - neutral.x, point.y - neutral.y);
}

export function advanceStickPeakTracker(
  tracker: StickPeakTracker,
  point: StickPosition,
  enterThreshold = 25,
  exitThreshold = 15,
): StickPeakTracker {
  const distance = distanceFromNeutral(point, tracker.neutral);

  if (!tracker.active) {
    if (distance < enterThreshold) return tracker;
    return {
      ...tracker,
      active: true,
      currentPeak: point,
      currentPeakDistance: distance,
    };
  }

  const isNewPeak = distance > tracker.currentPeakDistance;
  const currentPeak = isNewPeak ? point : tracker.currentPeak;
  const currentPeakDistance = isNewPeak ? distance : tracker.currentPeakDistance;
  if (distance > exitThreshold) {
    return { ...tracker, currentPeak, currentPeakDistance };
  }

  return {
    ...tracker,
    active: false,
    currentPeak: null,
    currentPeakDistance: 0,
    lastCompletedPeak: currentPeak,
  };
}

export function visibleStickPeak(tracker: StickPeakTracker) {
  return tracker.lastCompletedPeak ?? tracker.currentPeak;
}

export function appendStickMotionSample(
  samples: StickMotionSample[],
  sample: StickMotionSample,
  maximumSamples = 20,
) {
  return [...samples.slice(-(maximumSamples - 1)), sample];
}
