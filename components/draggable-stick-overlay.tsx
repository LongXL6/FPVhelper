"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { clamp } from "@/lib/telemetry";
import { StickAxes } from "@/components/stick-axes";
import { formatStickAxisValue } from "@/lib/stick-display";
import {
  constrainStickOverlayPairLayout,
  finishStickOverlayPairInteraction,
  moveStickOverlayPairLayout,
  resizeStickOverlayPairLayout,
  type StickOverlayLayout,
  type StickOverlayMember,
  type StickOverlayPairLayout,
} from "@/lib/stick-overlay-layout";
import type { StickPosition } from "@/lib/stick-motion";

export type StickOverlayMode = "trail" | "simple";

interface DraggableStickOverlayProps {
  member: StickOverlayMember;
  pairLayout: StickOverlayPairLayout;
  label: string;
  xLabel: string;
  yLabel: string;
  x: number;
  y: number;
  tone: "blue" | "orange";
  mode: StickOverlayMode;
  opacity?: number;
  trail: StickPosition[];
  peak: StickPosition | null;
  onPairChange: (pair: StickOverlayPairLayout, persist: boolean) => void;
  onInteractionStart?: () => void;
  onInteractionCommit?: (pair: StickOverlayPairLayout) => void;
  onToggleLock: () => void;
}

interface PointerInteraction {
  mode: "move" | "resize";
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startPair: StickOverlayPairLayout;
  latestPair: StickOverlayPairLayout;
  areaWidth: number;
  areaHeight: number;
}

function isStoredLayout(value: unknown): value is StickOverlayLayout {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StickOverlayLayout>;
  return [candidate.xPercent, candidate.yPercent, candidate.size].every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

const STICK_OVERLAY_LAYOUT_EVENT = "fpvhelper:stick-overlay-layout";
const memoryLayoutSnapshots = new Map<string, string>();

function readStickOverlaySnapshot(storageKey: string, fallback: string) {
  try {
    return memoryLayoutSnapshots.get(storageKey) ?? localStorage.getItem(storageKey) ?? fallback;
  } catch {
    return memoryLayoutSnapshots.get(storageKey) ?? fallback;
  }
}

function isStoredPairLayout(value: unknown): value is StickOverlayPairLayout {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StickOverlayPairLayout>;
  return isStoredLayout(candidate.left)
    && isStoredLayout(candidate.right)
    && typeof candidate.docked === "boolean"
    && typeof candidate.locked === "boolean";
}

function parseStoredLayout(snapshot: string, fallback: StickOverlayLayout) {
  try {
    const parsed: unknown = JSON.parse(snapshot);
    return isStoredLayout(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readStickOverlayPairSnapshot(options: StickOverlayPairStorageOptions) {
  const pairSnapshot = readStickOverlaySnapshot(options.storageKey, "");
  if (pairSnapshot) {
    try {
      if (isStoredPairLayout(JSON.parse(pairSnapshot))) return pairSnapshot;
    } catch {
      // Invalid pair state falls back to the previously stored individual layouts.
    }
  }

  return JSON.stringify({
    left: parseStoredLayout(
      readStickOverlaySnapshot(options.leftStorageKey, JSON.stringify(options.defaultPair.left)),
      options.defaultPair.left,
    ),
    right: parseStoredLayout(
      readStickOverlaySnapshot(options.rightStorageKey, JSON.stringify(options.defaultPair.right)),
      options.defaultPair.right,
    ),
    docked: false,
    locked: false,
  } satisfies StickOverlayPairLayout);
}

function writeLayoutSnapshot(storageKey: string, snapshot: string, persist: boolean) {
  memoryLayoutSnapshots.set(storageKey, snapshot);
  if (!persist) return;
  try {
    localStorage.setItem(storageKey, snapshot);
  } catch {
    // Restricted storage still keeps the layout for the current page session.
  }
}

export function storeStickOverlayLayout(storageKey: string, layout: StickOverlayLayout) {
  if (typeof window === "undefined") return;
  const snapshot = JSON.stringify(layout);
  writeLayoutSnapshot(storageKey, snapshot, true);
  window.dispatchEvent(new CustomEvent(STICK_OVERLAY_LAYOUT_EVENT, { detail: storageKey }));
}

interface StickOverlayPairStorageOptions {
  storageKey: string;
  leftStorageKey: string;
  rightStorageKey: string;
  defaultPair: StickOverlayPairLayout;
}

export function useStickOverlayPairLayout(options: StickOverlayPairStorageOptions) {
  const defaultSnapshot = useMemo(() => JSON.stringify(options.defaultPair), [options.defaultPair]);
  const subscribe = useCallback((onStoreChange: () => void) => {
    const relevantKeys = new Set([options.storageKey, options.leftStorageKey, options.rightStorageKey]);
    const handleStorage = (event: StorageEvent) => {
      if (!event.key || !relevantKeys.has(event.key)) return;
      memoryLayoutSnapshots.delete(event.key);
      onStoreChange();
    };
    const handleLocalChange = (event: Event) => {
      if (relevantKeys.has((event as CustomEvent<string>).detail)) onStoreChange();
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(STICK_OVERLAY_LAYOUT_EVENT, handleLocalChange);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(STICK_OVERLAY_LAYOUT_EVENT, handleLocalChange);
    };
  }, [options.leftStorageKey, options.rightStorageKey, options.storageKey]);
  const getSnapshot = useCallback(
    () => readStickOverlayPairSnapshot(options),
    [options],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => defaultSnapshot);
  const pairLayout = useMemo(() => {
    try {
      const parsed: unknown = JSON.parse(snapshot);
      return isStoredPairLayout(parsed) ? parsed : options.defaultPair;
    } catch {
      return options.defaultPair;
    }
  }, [options.defaultPair, snapshot]);
  const storePairLayout = useCallback((pair: StickOverlayPairLayout, persist = true) => {
    if (typeof window === "undefined") return;
    const pairSnapshot = JSON.stringify(pair);
    writeLayoutSnapshot(options.storageKey, pairSnapshot, persist);
    writeLayoutSnapshot(options.leftStorageKey, JSON.stringify(pair.left), persist);
    writeLayoutSnapshot(options.rightStorageKey, JSON.stringify(pair.right), persist);
    window.dispatchEvent(new CustomEvent(STICK_OVERLAY_LAYOUT_EVENT, { detail: options.storageKey }));
  }, [options.leftStorageKey, options.rightStorageKey, options.storageKey]);

  return { pairLayout, storePairLayout };
}

export function DraggableStickOverlay({
  member,
  pairLayout,
  label,
  xLabel,
  yLabel,
  x,
  y,
  tone,
  mode,
  opacity = 1,
  trail,
  peak,
  onPairChange,
  onInteractionStart,
  onInteractionCommit,
  onToggleLock,
}: DraggableStickOverlayProps) {
  const overlayRef = useRef<HTMLElement | null>(null);
  const interactionRef = useRef<PointerInteraction | null>(null);
  const layout = pairLayout[member];
  const left = `${(clamp(x, -100, 100) + 100) / 2}%`;
  const top = `${(100 - clamp(y, -100, 100)) / 2}%`;
  const visibleTrail = mode === "trail" ? trail.slice(-14, -1) : [];
  const peakLeft = peak ? `${(clamp(peak.x, -100, 100) + 100) / 2}%` : "50%";
  const peakTop = peak ? `${(100 - clamp(peak.y, -100, 100)) / 2}%` : "50%";

  useEffect(() => {
    if (member !== "left") return;
    const overlay = overlayRef.current;
    const stage = overlay?.parentElement;
    if (!stage) return;

    const constrainToStage = () => {
      const bounds = stage.getBoundingClientRect();
      const constrained = constrainStickOverlayPairLayout(pairLayout, bounds.width, bounds.height);
      if (JSON.stringify(constrained) !== JSON.stringify(pairLayout)) onPairChange(constrained, true);
    };
    constrainToStage();
    const observer = new ResizeObserver(constrainToStage);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [member, onPairChange, pairLayout]);

  const startInteraction = useCallback((mode: PointerInteraction["mode"], event: ReactPointerEvent<HTMLButtonElement>) => {
    const stage = overlayRef.current?.parentElement;
    if (!stage) return;
    const bounds = stage.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    interactionRef.current = {
      mode,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPair: constrainStickOverlayPairLayout(pairLayout, bounds.width, bounds.height),
      latestPair: constrainStickOverlayPairLayout(pairLayout, bounds.width, bounds.height),
      areaWidth: bounds.width,
      areaHeight: bounds.height,
    };
    onInteractionStart?.();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [onInteractionStart, pairLayout]);

  const continueInteraction = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - interaction.startClientX;
    const deltaY = event.clientY - interaction.startClientY;
    const nextPair = interaction.mode === "move"
      ? moveStickOverlayPairLayout(interaction.startPair, member, deltaX, deltaY, interaction.areaWidth, interaction.areaHeight)
      : resizeStickOverlayPairLayout(interaction.startPair, member, Math.abs(deltaX) >= Math.abs(deltaY) ? deltaX : deltaY, interaction.areaWidth, interaction.areaHeight);
    interaction.latestPair = nextPair;
    onPairChange(nextPair, false);
    event.preventDefault();
  }, [member, onPairChange]);

  const endInteraction = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (interactionRef.current?.pointerId !== event.pointerId) return;
    const interaction = interactionRef.current;
    interactionRef.current = null;
    const committedPair = finishStickOverlayPairInteraction(
      interaction.latestPair,
      member,
      interaction.areaWidth,
      interaction.areaHeight,
    );
    onPairChange(committedPair, true);
    onInteractionCommit?.(committedPair);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, [member, onInteractionCommit, onPairChange]);

  const handleKeyboard = (mode: "move" | "resize", event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const bounds = overlayRef.current?.parentElement?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 10 : 2;
    const deltaX = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const deltaY = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    const nextPair = mode === "move"
      ? moveStickOverlayPairLayout(pairLayout, member, deltaX, deltaY, bounds.width, bounds.height)
      : resizeStickOverlayPairLayout(pairLayout, member, deltaX + deltaY, bounds.width, bounds.height);
    onInteractionStart?.();
    onPairChange(nextPair, true);
    onInteractionCommit?.(nextPair);
  };

  return (
    <section
      ref={overlayRef}
      className={`video-stick-overlay video-stick-overlay--${tone} video-stick-overlay--${mode}${layout.size < 132 ? " video-stick-overlay--compact" : ""}${pairLayout.docked ? ` video-stick-overlay--docked-${member}` : ""}${pairLayout.locked ? " video-stick-overlay--locked" : ""}`}
      style={{ left: `${layout.xPercent}%`, top: `${layout.yPercent}%`, width: layout.size, height: layout.size, opacity }}
      aria-label={`${label}视频叠层`}
    >
      <button
        className="video-stick-overlay__drag"
        type="button"
        aria-label={`拖动${label}`}
        title="方向键微调，Shift + 方向键加速移动"
        onKeyDown={(event) => handleKeyboard("move", event)}
        onPointerDown={(event) => startInteraction("move", event)}
        onPointerMove={continueInteraction}
        onPointerUp={endInteraction}
        onPointerCancel={endInteraction}
      >
        <span aria-hidden="true">⠿</span><b>{label}</b><small>{pairLayout.locked ? "整组拖动" : "拖动"}</small>
      </button>
      {member === "left" && pairLayout.docked ? (
        <button
          className="video-stick-overlay__pair-lock"
          type="button"
          aria-label={pairLayout.locked ? "解锁左右摇杆布局" : "锁定左右摇杆为一组"}
          aria-pressed={pairLayout.locked}
          title={pairLayout.locked ? "点击后可重新单独移动" : "锁定后拖动或缩放任意摇杆会整组变化"}
          onClick={onToggleLock}
        >{pairLayout.locked ? "已锁" : "锁定"}</button>
      ) : null}
      <div className="video-stick-overlay__field" aria-label={`${xLabel} ${formatStickAxisValue(x)}，${yLabel} ${formatStickAxisValue(y)}；归一化行程 −1000 至 +1000，中心 0`}>
        {visibleTrail.map((point, index) => {
          const progress = (index + 1) / visibleTrail.length;
          return (
            <span
              key={`${index}-${point.x.toFixed(1)}-${point.y.toFixed(1)}`}
              className="video-stick-overlay__trail-dot"
              style={{
                left: `${(clamp(point.x, -100, 100) + 100) / 2}%`,
                top: `${(100 - clamp(point.y, -100, 100)) / 2}%`,
                opacity: 0.08 + progress * 0.35,
                filter: `blur(${(1 - progress) * 3}px)`,
              }}
              aria-hidden="true"
            />
          );
        })}
        {mode === "trail" && peak ? (
          <span className="video-stick-overlay__peak" style={{ left: peakLeft, top: peakTop }} title="上一段完整摇杆行程的峰值" aria-hidden="true" />
        ) : null}
        <span className="video-stick-overlay__trace" style={{ left, top }} />
        <span className="video-stick-overlay__dot" style={{ left, top }} />
        <StickAxes xLabel={xLabel} yLabel={yLabel} />
      </div>
      <div className="video-stick-overlay__values">
        <span>{xLabel}<b>{formatStickAxisValue(x)}</b></span>
        <span>{yLabel}<b>{formatStickAxisValue(y)}</b></span>
      </div>
      <button
        className="video-stick-overlay__resize"
        type="button"
        aria-label={`调整${label}大小`}
        title="方向键调整大小，Shift + 方向键加速"
        onKeyDown={(event) => handleKeyboard("resize", event)}
        onPointerDown={(event) => startInteraction("resize", event)}
        onPointerMove={continueInteraction}
        onPointerUp={endInteraction}
        onPointerCancel={endInteraction}
      ><span aria-hidden="true" /></button>
    </section>
  );
}
