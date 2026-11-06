"use client";

import { useRef, useState, type PointerEvent } from "react";

/**
 * A signature, drawn with a finger. The drawing goes into a hidden field as a picture, so the
 * form needs nothing else from it. Canvas colours are read from the theme, so the ink shows in
 * both themes.
 */
export function SignaturePad({ name, clearLabel, hint }: { name: string; clearLabel: string; hint: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [value, setValue] = useState("");

  const at = (e: PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const scaleX = e.currentTarget.width / box.width;
    const scaleY = e.currentTarget.height / box.height;
    return { x: (e.clientX - box.left) * scaleX, y: (e.clientY - box.top) * scaleY };
  };

  const start = (e: PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    drawing.current = true;
    const { x, y } = at(e);
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.strokeStyle = getComputedStyle(e.currentTarget).color;
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = e.currentTarget.getContext("2d");
    const { x, y } = at(e);
    ctx?.lineTo(x, y);
    ctx?.stroke();
  };

  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    setValue(canvas.current?.toDataURL("image/png") ?? "");
  };

  const clear = () => {
    const c = canvas.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    setValue("");
  };

  return (
    <div className="flex flex-col gap-1">
      <input type="hidden" name={name} value={value} />
      <canvas
        ref={canvas}
        width={600}
        height={200}
        aria-label={hint}
        className="h-32 w-full touch-none rounded-lg border border-sand-300 bg-surface text-ink"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-sand-500">{hint}</span>
        <button type="button" onClick={clear} className="text-sm font-medium underline">{clearLabel}</button>
      </div>
    </div>
  );
}
