"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

const ORIGINAL_SRC = "/warehouse14.mp4";
const AI_SRC = "/skeletal-warehouse14-dreamina.mp4";

// Only re-seek the follower video when it has drifted by more than this.
const DRIFT_THRESHOLD = 0.2;
const KEY_STEP = 1;

const formatTime = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
};

const playable = (...videos: (HTMLVideoElement | null)[]) =>
  videos.filter((v): v is HTMLVideoElement => v !== null && !v.error);

function PlayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 4.5v15a.5.5 0 0 0 .77.42l12-7.5a.5.5 0 0 0 0-.84l-12-7.5A.5.5 0 0 0 7 4.5Z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="4.5" width="4" height="15" rx="1" />
      <rect x="14" y="4.5" width="4" height="15" rx="1" />
    </svg>
  );
}

function VolumeIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      {muted ? (
        <>
          <path d="m16 9.5 5 5" />
          <path d="m21 9.5-5 5" />
        </>
      ) : (
        <>
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M18.5 5.5a9 9 0 0 1 0 13" />
        </>
      )}
    </svg>
  );
}

const labelClass =
  "pointer-events-none absolute left-3 top-3 rounded bg-black/40 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.15em] text-white/80";

export default function DemoPlayer() {
  const originalRef = useRef<HTMLVideoElement>(null);
  const aiRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const playingRef = useRef(false);
  const durationRef = useRef<number | null>(null);
  const lastShownRef = useRef(0);
  const scrubbingRef = useRef(false);
  const rafRef = useRef(0);

  const [playing, setPlayingState] = useState(false);
  const [ended, setEnded] = useState(false);
  const [time, setTime] = useState(0);
  const [muted, setMuted] = useState(true);
  const [durations, setDurations] = useState<{
    original: number | null;
    ai: number | null;
  }>({ original: null, ai: null });
  const [failed, setFailed] = useState({ original: false, ai: false });

  // Shared timeline = the shorter of the loaded videos' real durations.
  const duration = useMemo(() => {
    const parts: number[] = [];
    if (!failed.original) {
      if (durations.original === null) return null;
      parts.push(durations.original);
    }
    if (!failed.ai) {
      if (durations.ai === null) return null;
      parts.push(durations.ai);
    }
    return parts.length ? Math.min(...parts) : null;
  }, [durations, failed]);

  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  // Metadata or errors may already be in place before React attached handlers.
  useEffect(() => {
    const o = originalRef.current;
    const a = aiRef.current;
    const read = (v: HTMLVideoElement | null) =>
      v && v.readyState >= 1 && Number.isFinite(v.duration) ? v.duration : null;
    setDurations((d) => ({
      original: read(o) ?? d.original,
      ai: read(a) ?? d.ai,
    }));
    setFailed((f) => ({
      original: f.original || !!o?.error,
      ai: f.ai || !!a?.error,
    }));
  }, []);

  const setPlaying = (value: boolean) => {
    playingRef.current = value;
    setPlayingState(value);
  };

  const finish = useCallback(() => {
    playable(originalRef.current, aiRef.current).forEach((v) => v.pause());
    playingRef.current = false;
    setPlayingState(false);
    setEnded(true);
    if (durationRef.current !== null) {
      lastShownRef.current = durationRef.current;
      setTime(durationRef.current);
    }
  }, []);

  const tick = useCallback(() => {
    const o = originalRef.current;
    const a = aiRef.current;
    const master = o && !o.error ? o : a;
    if (!master) return;
    const t = master.currentTime;
    const d = durationRef.current;
    if (d !== null && t >= d) {
      finish();
      return;
    }
    // The original is the clock; the AI video follows and is only corrected on real drift.
    if (
      playingRef.current &&
      o &&
      a &&
      !o.error &&
      !a.error &&
      Math.abs(a.currentTime - o.currentTime) > DRIFT_THRESHOLD
    ) {
      a.currentTime = o.currentTime;
    }
    if (!scrubbingRef.current && Math.abs(t - lastShownRef.current) >= 0.05) {
      lastShownRef.current = t;
      setTime(t);
    }
  }, [finish]);

  useEffect(() => {
    if (!playing) return;
    const loop = () => {
      tick();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, tick]);

  const seekTo = (target: number) => {
    const d = durationRef.current ?? 0;
    const t = Math.min(Math.max(target, 0), d);
    playable(originalRef.current, aiRef.current).forEach((v) => {
      v.currentTime = Number.isFinite(v.duration) ? Math.min(t, v.duration) : t;
    });
    lastShownRef.current = t;
    setTime(t);
    if (t < d) setEnded(false);
  };

  const togglePlay = async () => {
    const d = durationRef.current;
    if (d === null) return;
    const videos = playable(originalRef.current, aiRef.current);
    if (playingRef.current) {
      videos.forEach((v) => v.pause());
      setPlaying(false);
      return;
    }
    if (ended || time >= d - 0.05) seekTo(0);
    setPlaying(true);
    try {
      await Promise.all(videos.map((v) => v.play()));
    } catch (err) {
      if ((err as DOMException).name === "AbortError") return;
      videos.forEach((v) => v.pause());
      setPlaying(false);
    }
  };

  // A pause that did not come from our button (browser, OS) pauses both videos.
  const handleNativePause = () => {
    if (!playingRef.current) return;
    playable(originalRef.current, aiRef.current).forEach((v) => v.pause());
    setPlaying(false);
  };

  const seekFromPointer = (clientX: number) => {
    const track = trackRef.current;
    const d = durationRef.current;
    if (!track || d === null) return;
    const rect = track.getBoundingClientRect();
    if (rect.width === 0) return;
    seekTo(((clientX - rect.left) / rect.width) * d);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (durationRef.current === null) return;
    scrubbingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromPointer(e.clientX);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (scrubbingRef.current) seekFromPointer(e.clientX);
  };

  const endScrub = (e: PointerEvent<HTMLDivElement>) => {
    scrubbingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onSliderKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = durationRef.current;
    if (d === null) return;
    const step = e.shiftKey ? KEY_STEP * 5 : KEY_STEP;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") seekTo(time - step);
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") seekTo(time + step);
    else if (e.key === "Home") seekTo(0);
    else if (e.key === "End") seekTo(d);
    else return;
    e.preventDefault();
  };

  const ready = duration !== null;
  const progress = ready && duration > 0 ? Math.min(100, (time / duration) * 100) : 0;
  const playLabel = playing ? "Pause" : ended ? "Replay" : "Play";

  return (
    <>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6">
        <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-[#2c2c2e]">
          <video
            ref={originalRef}
            src={ORIGINAL_SRC}
            aria-label="Original warehouse footage"
            className="absolute inset-0 h-full w-full object-contain"
            muted={muted}
            playsInline
            preload="auto"
            disablePictureInPicture
            onLoadedMetadata={(e) => {
              const duration = e.currentTarget.duration;
              setDurations((prev) => ({ ...prev, original: duration }));
            }}
            onError={() => setFailed((f) => ({ ...f, original: true }))}
            onPause={handleNativePause}
            onEnded={finish}
            onTimeUpdate={tick}
          />
          <span className={labelClass}>ORIGINAL FOOTAGE</span>
          {failed.original && (
            <p className="relative font-sans text-sm text-white/60">Video unavailable</p>
          )}
        </div>
        <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-[#0b0b0c]">
          <video
            ref={aiRef}
            src={AI_SRC}
            aria-label="AI visualization concept video"
            className="absolute inset-0 h-full w-full object-contain"
            muted
            playsInline
            preload="auto"
            disablePictureInPicture
            onLoadedMetadata={(e) => {
              const duration = e.currentTarget.duration;
              setDurations((prev) => ({ ...prev, ai: duration }));
            }}
            onError={() => setFailed((f) => ({ ...f, ai: true }))}
            onPause={handleNativePause}
            onEnded={finish}
          />
          <span className={labelClass}>AI VISUALIZATION</span>
          {failed.ai && (
            <p className="relative font-sans text-sm text-white/60">Video unavailable</p>
          )}
        </div>
      </div>

      <div className="mt-6 flex items-center gap-4 text-white/80">
        <button
          type="button"
          onClick={togglePlay}
          disabled={!ready}
          aria-label={playLabel}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50"
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>

        <div
          role="slider"
          tabIndex={ready ? 0 : -1}
          aria-label="Seek both videos"
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={ready ? Math.round(duration * 100) / 100 : 0}
          aria-valuenow={Math.round(time * 100) / 100}
          aria-valuetext={`${formatTime(time)} of ${ready ? formatTime(duration) : "unknown"}`}
          aria-disabled={!ready}
          onKeyDown={onSliderKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
          className="group flex h-5 flex-1 cursor-pointer touch-pan-y items-center outline-none focus-visible:[&>div]:ring-2 focus-visible:[&>div]:ring-white"
        >
          <div ref={trackRef} className="relative h-1 w-full rounded-full bg-white/15">
            <div
              className="absolute left-0 top-0 h-full rounded-full bg-white/40"
              style={{ width: `${progress}%` }}
            />
            <div
              className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white"
              style={{ left: `${progress}%` }}
            />
          </div>
        </div>

        <span className="shrink-0 font-sans text-sm tabular-nums text-white/60">
          {formatTime(time)} / {ready ? formatTime(duration) : "--:--"}
        </span>

        <button
          type="button"
          onClick={() => setMuted((m) => !m)}
          aria-label={muted ? "Unmute original footage" : "Mute original footage"}
          aria-pressed={!muted}
          className="shrink-0 rounded outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <VolumeIcon muted={muted} />
        </button>
      </div>
    </>
  );
}
