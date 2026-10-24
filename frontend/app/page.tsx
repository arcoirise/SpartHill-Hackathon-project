"use client";

import Link from "next/link";
import { useState } from "react";

const INITIAL_VIDEOS = [
  "/warehouse14.mp4",
  "/warehouse19.mp4",
  "/warehouse6.mp4",
  "/warehouse9.mp4",
];

const GRID_SIZE = 40;

const GRID_LINE = "rgba(255,255,255,0.08)";
const CELL_SIZE = GRID_SIZE - 1;

// Both gradients run from the top-left origin; each cell's 1px line sits in its
// last pixel, so a CELL_SIZE block at a multiple of GRID_SIZE fits inside it.
const gridStyle = {
  backgroundImage: [
    `repeating-linear-gradient(180deg, transparent 0, transparent ${CELL_SIZE}px, ${GRID_LINE} ${CELL_SIZE}px, ${GRID_LINE} ${GRID_SIZE}px)`,
    `repeating-linear-gradient(90deg, transparent 0, transparent ${CELL_SIZE}px, ${GRID_LINE} ${CELL_SIZE}px, ${GRID_LINE} ${GRID_SIZE}px)`,
  ].join(", "),
};

// Fixed grid-cell coordinates so server and client render identically.
const BLOCKS = [
  { col: 2, row: 3 },
  { col: 7, row: 1 },
  { col: 12, row: 5 },
  { col: 18, row: 2 },
  { col: 22, row: 8 },
  { col: 4, row: 10 },
  { col: 15, row: 12 },
  { col: 9, row: 15 },
  { col: 25, row: 14 },
  { col: 30, row: 4 },
  { col: 33, row: 11 },
  { col: 20, row: 17 },
];

export default function Home() {
  const [videos] = useState(INITIAL_VIDEOS);
  const [index, setIndex] = useState(0);

  return (
    <main className="relative h-screen w-full overflow-hidden bg-black">
      <video
        className="absolute inset-0 h-full w-full object-cover [image-rendering:pixelated]"
        src={videos[index]}
        autoPlay
        muted
        playsInline
        onEnded={() => setIndex((i) => (i + 1) % videos.length)}
      />

      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-[4px]"
        style={gridStyle}
      >
        {BLOCKS.map((b, i) => (
          <div
            key={i}
            className="absolute backdrop-blur-[1px] [image-rendering:pixelated]"
            style={{
              left: b.col * GRID_SIZE,
              top: b.row * GRID_SIZE,
              width: CELL_SIZE,
              height: CELL_SIZE,
              backgroundColor: "rgba(255, 255, 255, 0.08)",
            }}
          />
        ))}
      </div>

      <div className="relative z-10 flex h-screen w-full select-none flex-col justify-between px-16 py-8 text-white md:px-36 lg:px-48">
        <header className="relative flex w-full flex-col items-start gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="text-3xl font-bold tracking-tight text-white md:text-4xl">
            EdgeSense
          </div>
          <nav className="flex flex-wrap items-center gap-x-6 gap-y-1 text-lg font-medium text-white/90 md:text-xl lg:flex-nowrap lg:gap-0 lg:space-x-8 xl:absolute xl:left-1/2 xl:-translate-x-1/2 xl:space-x-12">
            <Link href="/our-mission" className="cursor-pointer">
              Our mission
            </Link>
            <Link href="/demo" className="cursor-pointer">
              Demo
            </Link>
            <Link href="/live-demo" className="cursor-pointer">
              Launch live demo
            </Link>
          </nav>
          <div className="hidden lg:block" />
        </header>

        <section className="my-auto max-w-6xl text-left">
          <h1 className="mb-8 font-serif text-6xl font-normal leading-[1.05] tracking-tight text-white drop-shadow-sm md:text-8xl lg:text-[5.5rem]">
            Preventative solutions for Essential workers
          </h1>
          <p className="max-w-5xl font-sans text-lg font-normal leading-relaxed text-white/90 drop-shadow-sm md:text-xl lg:text-2xl">
            Essential workers suffer high rates of preventable ergonomic injuries and hazards, yet strongly oppose traditional AI camera surveillance due to privacy invasions, data leaks, and punitive micromanagement. EdgeSense solves this as a zero-video-storage, edge-first safety assistant that converts live feeds into anonymous skeletal wireframe coordinates locally in the browser. By immediately discarding raw video frames, our system detects unsafe lifting posture and repetitive strain in real time without ever recording or identifying the worker.
          </p>
        </section>
      </div>
    </main>
  );
}
