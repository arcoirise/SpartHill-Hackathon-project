"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

const KEY_STEP = 2;

const clamp = (value: number) => Math.min(100, Math.max(0, value));

type ComparisonSliderProps = {
  rawSrc?: string;
  rawAlt?: string;
  skeletalSrc?: string;
  skeletalAlt?: string;
  label?: string;
};

export default function ComparisonSlider({
  rawSrc = "/raw-worker.png",
  rawAlt = "Raw camera image of the worker",
  skeletalSrc = "/skeletal-worker.png",
  skeletalAlt = "AI visualization of the worker as a skeletal wireframe",
  label = "Compare raw image and AI visualization",
}: ComparisonSliderProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [position, setPosition] = useState(50);

  const updateFromPointer = (clientX: number) => {
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    if (rect.width === 0) return;
    setPosition(clamp(((clientX - rect.left) / rect.width) * 100));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    updateFromPointer(e.clientX);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) updateFromPointer(e.clientX);
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP * 5 : KEY_STEP;
    if (e.key === "ArrowLeft") setPosition((p) => clamp(p - step));
    else if (e.key === "ArrowRight") setPosition((p) => clamp(p + step));
    else if (e.key === "Home") setPosition(0);
    else if (e.key === "End") setPosition(100);
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={frameRef}
      className="absolute inset-0 touch-pan-y select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* Right of the divider: AI visualization (full frame underneath). */}
      <Image
        src={skeletalSrc}
        alt={skeletalAlt}
        fill
        sizes="(min-width: 1024px) 50vw, 100vw"
        draggable={false}
        className="pointer-events-none object-cover"
      />

      {/* Left of the divider: raw image, clipped so it never resizes or shifts. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
      >
        <Image
          src={rawSrc}
          alt={rawAlt}
          fill
          sizes="(min-width: 1024px) 50vw, 100vw"
          draggable={false}
          className="object-cover"
        />
      </div>

      <span className="pointer-events-none absolute left-3 top-3 rounded bg-black/40 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.15em] text-white/80">
        RAW IMAGE
      </span>
      <span className="pointer-events-none absolute right-3 top-3 rounded bg-black/40 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.15em] text-white/80">
        AI VISUALIZATION
      </span>

      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(position)}
        aria-valuetext={`${Math.round(position)}% raw image visible`}
        onKeyDown={onKeyDown}
        className="absolute inset-y-0 w-px -translate-x-1/2 cursor-ew-resize bg-white outline-none focus-visible:[&>div]:ring-2 focus-visible:[&>div]:ring-white"
        style={{ left: `${position}%` }}
      >
        <div className="absolute left-1/2 top-1/2 flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-[#1c1c1e]/90 ring-1 ring-white/40">
          <svg
            width="20"
            height="12"
            viewBox="0 0 20 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-white/80"
            aria-hidden="true"
          >
            <path d="M6 2 2 6l4 4" />
            <path d="M14 2l4 4-4 4" />
          </svg>
        </div>
      </div>
    </div>
  );
}
