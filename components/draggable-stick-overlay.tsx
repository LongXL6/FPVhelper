"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { clamp } from "@/lib/telemetry";
import {
  constrainStickOverlayLayout,
  moveStickOverlayLayout,
  resizeStickOverlayLayout,
  type StickOverlayLayout,
} from "@/lib/stick-overlay-layout";
import type { StickPosition } from "@/lib/stick-motion";

export type StickOverlayMode = "trail" | "simple";

interface DraggableStickOverlayProps {
  storageKey: string;
  label: string;
  xLabel: string;
  yLabel: string;
  x: number;
  y: number;
  tone: "blue" | "orange";
  mode: StickOverlayMode;
  trail: StickPosition[];
  peak: StickPosition | null;
  defaultLayout: StickOverlayLayout;
}

interface PointerInteraction {
  mode: "move" | "resize";
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startLayout: StickOverlayLayout;
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
    return localStorage.getItem(storageKey) ?? memoryLayoutSnapshots.get(storageKey) ?? fallback;
  } catch {
    return memoryLayoutSnapshots.get(storageKey) ?? fallback;
  }
}

export function storeStickOverlayLayout(storageKey: string, layout: StickOverlayLayout) {
  if (typeof window === "undefined") return;
  const snapshot = JSON.stringify(layout);
  memoryLayoutSnapshots.set(storageKey, snapshot);
  try {
    localStorage.setItem(storageKey, snapshot);
  } catch {
    // Restricted storage still keeps the layout for the current page session.
  }
  window.dispatchEvent(new CustomEvent(STICK_OVERLAY_LAYOUT_EVENT, { detail: storageKey }));
}

export function DraggableStickOverlay({
  storageKey,
  label,
  xLabel,
  yLabel,
  x,
  y,
  tone,
  mode,
  trail,
  peak,
  defaultLayout,
}: DraggableStickOverlayProps) {
  const overlayRef = useRef<HTMLElement | null>(null);
  const interactionRef = useRef<PointerInteraction | null>(null);
  const defaultSnapshot = useMemo(() => JSON.stringify(defaultLayout), [defaultLayout]);
  const subscribe = useCallback((onStoreChange: () => void) => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === storageKey) onStoreChange();
    };
    const handleLocalChange = (event: Event) => {
      if ((event as CustomEvent<string>).detail === storageKey) onStoreChange();
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(STICK_OVERLAY_LAYOUT_EVENT, handleLocalChange);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(STICK_OVERLAY_LAYOUT_EVENT, handleLocalChange);
    };
  }, [storageKey]);
  const getSnapshot = useCallback(() => readStickOverlaySnapshot(storageKey, defaultSnapshot), [defaultSnapshot, storageKey]);
  const layoutSnapshot = useSyncExternalStore(subscribe, getSnapshot, () => defaultSnapshot);
  const layout = useMemo(() => {
    try {
      const parsed: unknown = JSON.parse(layoutSnapshot);
      return isStoredLayout(parsed) ? parsed : defaultLayout;
    } catch {
      return defaultLayout;
    }
  }, [defaultLayout, layoutSnapshot]);
  const left = `${(clamp(x, -100, 100) + 100) / 2}%`;
  const top = `${(100 - clamp(y, -100, 100)) / 2}%`;
  const visibleTrail = mode === "trail" ? trail.slice(-14, -1) : [];
  const peakLeft = peak ? `${(clamp(peak.x, -100, 100) + 100) / 2}%` : "50%";
  const peakTop = peak ? `${(100 - clamp(peak.y, -100, 100)) / 2}%` : "50%";

  useEffect(() => {
    const overlay = overlayRef.current;
    const stage = overlay?.parentElement;
    if (!stage) return;

    const constrainToStage = () => {
      const bounds = stage.getBoundingClientRect();
      const constrained = constrainStickOverlayLayout(layout, bounds.width, bounds.height);
      if (JSON.stringify(constrained) !== JSON.stringify(layout)) storeStickOverlayLayout(storageKey, constrained);
    };
    constrainToStage();
    const observer = new ResizeObserver(constrainToStage);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [layout, storageKey]);

  const startInteraction = useCallback((mode: PointerInteraction["mode"], event: ReactPointerEvent<HTMLButtonElement>) => {
    const stage = overlayRef.current?.parentElement;
    if (!stage) return;
    const bounds = stage.getBoundingClientRect();
    interactionRef.current = {
      mode,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startLayout: constrainStickOverlayLayout(layout, bounds.width, bounds.height),
      areaWidth: bounds.width,
      areaHeight: bounds.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [layout]);

  const continueInteraction = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - interaction.startClientX;
    const deltaY = event.clientY - interaction.startClientY;
    storeStickOverlayLayout(
      storageKey,
      interaction.mode === "move"
        ? moveStickOverlayLayout(interaction.startLayout, deltaX, deltaY, interaction.areaWidth, interaction.areaHeight)
        : resizeStickOverlayLayout(interaction.startLayout, Math.max(deltaX, deltaY), interaction.areaWidth, interaction.areaHeight),
    );
    event.preventDefault();
  }, [storageKey]);

  const endInteraction = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (interactionRef.current?.pointerId !== event.pointerId) return;
    interactionRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  return (
    <section
      ref={overlayRef}
      className={`video-stick-overlay video-stick-overlay--${tone} video-stick-overlay--${mode}`}
      style={{ left: `${layout.xPercent}%`, top: `${layout.yPercent}%`, width: layout.size, height: layout.size }}
      aria-label={`${label}视频叠层`}
    >
      <button
        className="video-stick-overlay__drag"
        type="button"
        aria-label={`拖动${label}`}
        onPointerDown={(event) => startInteraction("move", event)}
        onPointerMove={continueInteraction}
        onPointerUp={endInteraction}
        onPointerCancel={endInteraction}
      >
        <span aria-hidden="true">⠿</span><b>{label}</b><small>拖动</small>
      </button>
      <div className="video-stick-overlay__field" aria-label={`${xLabel} ${Math.round(x)}，${yLabel} ${Math.round(y)}`}>
        <span className="axis axis-x" />
        <span className="axis axis-y" />
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
        <small className="axis-label axis-label-x">{xLabel}</small>
        <small className="axis-label axis-label-y">{yLabel}</small>
      </div>
      <div className="video-stick-overlay__values">
        <span>{xLabel}<b>{Math.round(x)}</b></span>
        <span>{yLabel}<b>{Math.round(y)}</b></span>
      </div>
      <button
        className="video-stick-overlay__resize"
        type="button"
        aria-label={`调整${label}大小`}
        onPointerDown={(event) => startInteraction("resize", event)}
        onPointerMove={continueInteraction}
        onPointerUp={endInteraction}
        onPointerCancel={endInteraction}
      ><span aria-hidden="true" /></button>
    </section>
  );
}
