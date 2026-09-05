"use client";

import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { VisionRect } from "@/lib/vision-lab-types";
import styles from "./vision-lab.module.css";

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeRect(rect: VisionRect): VisionRect {
  const width = clamp(rect.width, 0.01, 1);
  const height = clamp(rect.height, 0.01, 1);
  return { x: clamp(rect.x, 0, 1 - width), y: clamp(rect.y, 0, 1 - height), width, height };
}

export function VisionReferenceSelection({ reference, disabled, onChange }: {
  reference: { url: string; rect: VisionRect };
  disabled: boolean;
  onChange: (rect: VisionRect) => void;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; original: VisionRect } | null>(null);
  const rect = reference.rect;
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = imageRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0 || !imageRef.current?.naturalWidth) return null;
    return { x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1), y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1) };
  };
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    const position = point(event);
    if (!position) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, ...position, original: rect };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const origin = drag.current;
    if (disabled || !origin || origin.id !== event.pointerId) return;
    const position = point(event);
    if (!position) return;
    onChange(normalizeRect({ x: Math.min(origin.x, position.x), y: Math.min(origin.y, position.y), width: Math.abs(position.x - origin.x), height: Math.abs(position.y - origin.y) }));
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    if (event.type === "pointercancel") onChange(drag.current.original);
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const moveWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const delta = event.shiftKey ? 0.05 : 0.01;
    onChange(normalizeRect({ ...rect, x: rect.x + (event.key === "ArrowLeft" ? -delta : event.key === "ArrowRight" ? delta : 0), y: rect.y + (event.key === "ArrowUp" ? -delta : event.key === "ArrowDown" ? delta : 0) }));
  };

  return <div className={styles.referenceEditor}>
    <div className={styles.referenceImage} onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} data-disabled={disabled}>
      {/* eslint-disable-next-line @next/next/no-img-element -- The reference is a local Blob URL and must retain its decoded geometry for selection. */}
      <img ref={imageRef} src={reference.url} alt="本机计时门参考照片" draggable={false} />
      <div className={styles.referenceRect} role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} aria-label="门框选区，用方向键移动，或使用下方数值调整大小" onKeyDown={moveWithKeyboard}
        style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}><span>计时门</span></div>
    </div>
    <p className={styles.hint}>拖动框选完整门框。方向键移动选区；下方可精细调整。</p>
    <div className={styles.rectFields}>
      {([{ key: "x", label: "左" }, { key: "y", label: "上" }, { key: "width", label: "宽" }, { key: "height", label: "高" }] as const).map(({ key, label }) => <label key={key}>
        <span>{label} %</span>
        <input type="number" min={key === "width" || key === "height" ? 1 : 0} max="100" step="1" value={Math.round(rect[key] * 100)} disabled={disabled} aria-label={`门框${label}百分比`} onChange={(event) => {
          const value = event.currentTarget.valueAsNumber;
          if (Number.isFinite(value)) onChange(normalizeRect({ ...rect, [key]: value / 100 }));
        }} />
      </label>)}
    </div>
  </div>;
}
