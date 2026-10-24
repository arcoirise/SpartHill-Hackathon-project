import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { NormalizedLandmark, ObjectDetector, PoseLandmarker } from "@mediapipe/tasks-vision";
import { LandmarkFilter } from "../lift/oneEuro";
import type { ReplayClip } from "../lift/replay";
import { createPoseLandmarker, type Delegate, type Quality } from "../pose/landmarker";
import { LM } from "../pose/landmarks";
import { createObjectDetector } from "../pose/objectDetector";
import {
  GripTracker,
  HELD_LABELS,
  assessGrip,
  isCarryingLoad,
  pickHeldObject,
  updateTrack,
  visibleHandsBox,
  type GripAssessment,
  type TrackedObject,
} from "../pose/objectTracker";
import type { PoseFrame } from "../pose/types";
import { POSTURE_COLORS, drawHitbox, drawStickman, type HitboxBox, type Overlay } from "./draw";

export interface CameraStats {
  status: "loading" | "ready" | "running" | "error";
  message?: string;
  delegate?: Delegate;
  fps: number;
  personDetected: boolean;
}

interface Props {
  quality: Quality;
  /** When set, this landmark clip plays through the same pipeline instead of the camera. */
  replay: ReplayClip | null;
  onReplayEnd?: () => void;
  /** Called for every processed frame that contains a person. */
  onPose?: (frame: PoseFrame) => void;
  /** Read after onPose each frame to decide how to draw. */
  getOverlay?: () => Overlay | undefined;
  onStats?: (stats: CameraStats) => void;
  /** Label of the object the hands are holding (null when none); fires on change only. */
  onObjectLabel?: (label: string | null) => void;
  /** Grip on the detected object (null when none); fires when its status or badge changes. */
  onGripChange?: (grip: GripAssessment | null) => void;
  /** Second canvas that gets the same drawing on a plain background and never any video. */
  serverCanvasRef?: RefObject<HTMLCanvasElement | null>;
  /** HUD elements layered over the video. */
  children?: ReactNode;
}

/** Run the object detector every 2nd frame so pose keeps ~25–30 fps while walking; the box follows the hands in between. */
const OBJECT_EVERY_N_FRAMES = 2;
/** Hand points that can grip an object; only these may stretch a box up to a gripped backrest. */
const GRIP_POINTS = [LM.L_WRIST, LM.R_WRIST, LM.L_INDEX, LM.R_INDEX, LM.L_PINKY, LM.R_PINKY, LM.L_THUMB, LM.R_THUMB];
/** Fingertip points (thumb, index, pinky): the real contact points when grading where the hands hold the object. */
const FINGER_POINTS = [LM.L_INDEX, LM.R_INDEX, LM.L_PINKY, LM.R_PINKY, LM.L_THUMB, LM.R_THUMB];
/** Hand and arm points that can be in contact with a held object, from any angle. */
const CONTACT_POINTS = [...GRIP_POINTS, LM.L_ELBOW, LM.R_ELBOW];
const CONTACT_VISIBLE = 0.25;
/**
 * A new grip verdict must hold this long, and a detection must confirm it at the end, before it is shown: wrist
 * jitter at a threshold doesn't flicker it, and a single false detection (kept alive by the tracker for HOLD_MS, longer while carrying)
 * can never publish a grip on its own. 90 ms is two detector runs at 15 fps (OBJECT_EVERY_N_FRAMES = 2).
 */
const GRIP_STABLE_MS = 90;
/**
 * A pending verdict survives detector misses this long. At 10–15 fps the detector runs only every 133–200 ms, so a
 * shorter window dropped the pending verdict after one or two misses and an edge-on chair took seconds to show a grip.
 */
const GRIP_FRESH_MS = 900;
/** Give up on object detection only after this many failures in a row (one bad frame mustn't kill it). */
const MAX_DETECT_FAILURES = 10;
const REPLAY_WIDTH = 1280;
export const SERVER_VIEW_BG = "#060a13";

/**
 * The load hitbox for this frame: the tracked object, or during an active
 * bend/lift (never while standing) a box around the wrists, so a lift always
 * shows a load even if its class isn't recognised.
 */
function loadBox(
  pose: NormalizedLandmark[] | null,
  overlay: Overlay | undefined,
  object: TrackedObject | null,
  aspect: number,
): { box: HitboxBox; label?: string } | null {
  if (!pose) return null;
  if (object) return { box: object.box, label: object.label };
  if (!overlay?.holdingLoad) return null;
  const box = visibleHandsBox(pose[LM.L_WRIST], pose[LM.R_WRIST], aspect);
  return box && { box, label: "load" };
}

const visiblePoints = (pose: NormalizedLandmark[], ids: number[]) =>
  ids.filter((i) => (pose[i].visibility ?? 0) > CONTACT_VISIBLE).map((i) => pose[i]);

/** Visible hand/arm points; falls back to both wrists so the hands are never empty mid-turn. */
function contactPoints(pose: NormalizedLandmark[]): { x: number; y: number }[] {
  const seen = visiblePoints(pose, CONTACT_POINTS);
  return seen.length ? seen : [pose[LM.L_WRIST], pose[LM.R_WRIST]];
}

const gripKey = (g: GripAssessment | null) => (g ? `${g.status}|${g.badge}` : "");

/**
 * Draw the same stickman and load hitbox over the video (transparent) and on the video-free server canvas.
 * `grip` belongs to the tracked object only; the fallback hands box is built around the wrists, so it is never graded.
 */
function paint(
  main: HTMLCanvasElement,
  server: HTMLCanvasElement | null | undefined,
  pose: NormalizedLandmark[] | null,
  overlay: Overlay | undefined,
  object: TrackedObject | null,
  grip: GripAssessment | null,
) {
  const color = overlay?.color ?? POSTURE_COLORS.safe;
  const load = loadBox(pose, overlay, object, main.width / main.height);
  const graded = object ? grip : null;
  const drawAll = (canvas: HTMLCanvasElement, background?: string) => {
    const ctx = canvas.getContext("2d")!;
    // The hands and finger joints take the grip colour, so both views show where the fingers hold the object.
    drawStickman(ctx, canvas.width, canvas.height, true, pose, color, background, graded?.status);
    if (load) drawHitbox(ctx, canvas.width, canvas.height, true, load.box, graded?.badge ?? load.label, graded?.status);
  };
  drawAll(main);
  if (!server) return;
  if (server.width !== main.width || server.height !== main.height) {
    server.width = main.width;
    server.height = main.height;
  }
  drawAll(server, SERVER_VIEW_BG);
}

/**
 * Live webcam + stickman overlay. Video frames are handed straight to MediaPipe
 * in memory and never stored, copied, or sent anywhere; only landmarks and the
 * object's label leave this component.
 */
export default function CameraView({
  quality,
  replay,
  onReplayEnd,
  onPose,
  getOverlay,
  onStats,
  onObjectLabel,
  onGripChange,
  serverCanvasRef,
  children,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [aspect, setAspect] = useState(16 / 9);
  const [message, setMessage] = useState<{ text: string; button?: string } | null>({ text: "Loading pose model…" });
  // Bumping this restarts the whole pipeline (used by the "Try again" button).
  const [attempt, setAttempt] = useState(0);
  // Resolves the pending "wait for click" promise inside the effect.
  const startClickRef = useRef<(() => void) | null>(null);
  // After the first successful start, switching model quality restarts without another click.
  const cameraApproved = useRef(false);
  const replayActive = useRef(false);

  // Keep the latest callbacks without restarting the camera when they change.
  const cb = useRef({ onPose, getOverlay, onStats, onObjectLabel, onGripChange, onReplayEnd, serverCanvasRef });
  cb.current = { onPose, getOverlay, onStats, onObjectLabel, onGripChange, onReplayEnd, serverCanvasRef };

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let landmarker: PoseLandmarker | null = null;
    let objectDetector: ObjectDetector | null = null;
    let rafId = 0;

    const report = (stats: CameraStats) => cb.current.onStats?.(stats);

    async function start() {
      setMessage({ text: quality === "accurate" ? "Loading high-accuracy pose model…" : "Loading pose model…" });
      report({ status: "loading", fps: 0, personDetected: false });

      const created = await createPoseLandmarker(quality);
      if (cancelled) return created.landmarker.close();
      landmarker = created.landmarker;

      // Object detection is a bonus: if it fails to load, the hands box still works during lifts.
      createObjectDetector(quality)
        .then((d) => (cancelled ? d.close() : (objectDetector = d)))
        .catch((err) => console.warn("[object] detector unavailable", err));

      if (!cameraApproved.current) {
        // Ask for the camera only after a click, so the browser's permission
        // prompt appears right when the user is looking at the screen.
        setMessage({ text: "Pose model ready.", button: "Start camera" });
        report({ status: "ready", delegate: created.delegate, fps: 0, personDetected: false });
        await new Promise<void>((resolve) => (startClickRef.current = resolve));
        if (cancelled) return;
      }

      setMessage({
        text: "Waiting for camera permission… If no prompt appears: click the icon at the left of the address bar → Camera → Allow, then reload.",
      });
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: false,
      });
      if (cancelled) return;
      cameraApproved.current = true;

      const video = videoRef.current!;
      const canvas = canvasRef.current!;
      video.srcObject = stream;
      await video.play();
      if (cancelled) return;

      setAspect(video.videoWidth / video.videoHeight);
      setMessage(null);
      report({ status: "running", delegate: created.delegate, fps: 0, personDetected: false });

      const display = new LandmarkFilter(1.5, 6);
      let detectFailures = 0;
      let lastVideoTime = -1;
      let frames = 0;
      let windowStart = performance.now();
      let personDetected = false;
      let tracked: TrackedObject | null = null;
      const grip = new GripTracker();
      let frameNo = 0;
      let lastLabel: string | null = null;
      // Grip shown and reported; a different verdict waits in `pending` until it has held GRIP_STABLE_MS.
      let shownGrip: GripAssessment | null = null;
      let pendingGrip: GripAssessment | null = null;
      let pendingSince = 0;
      const showGrip = (g: GripAssessment | null) => {
        if (gripKey(g) === gripKey(shownGrip)) return;
        shownGrip = g;
        cb.current.onGripChange?.(g);
      };

      const loop = () => {
        if (cancelled || !landmarker) return;
        rafId = requestAnimationFrame(loop);
        if (replayActive.current) {
          // No video in a replay: clear the grip so a stale verdict doesn't stay on the alert banner.
          pendingGrip = null;
          showGrip(null);
          return;
        }
        if (video.currentTime === lastVideoTime) return;
        lastVideoTime = video.currentTime;
        if (canvas.width !== video.videoWidth) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }

        const now = performance.now();
        const result = landmarker.detectForVideo(video, now);
        const pose = result.landmarks[0];
        const world = result.worldLandmarks[0];
        personDetected = Boolean(pose && world);

        let shown: NormalizedLandmark[] | null = null;
        if (pose && world) {
          cb.current.onPose?.({ t: now, landmarks: pose, worldLandmarks: world, aspect: video.videoWidth / video.videoHeight });

          // Detect the held object on the full frame every OBJECT_EVERY_N_FRAMES frames.
          // On every frame the box moves with the hands' real motion (visibility-weighted
          // per-landmark displacement), so it never freezes or drifts while the worker turns.
          // While the arms hold a load (flexed elbows / hands together in front), the track
          // survives longer detector misses, e.g. motion blur while walking with a chair.
          const anchor = grip.update([pose[LM.L_WRIST], pose[LM.R_WRIST], pose[LM.L_INDEX], pose[LM.R_INDEX]]);
          const carrying = isCarryingLoad(pose, video.videoWidth / video.videoHeight);
          if (objectDetector && frameNo++ % OBJECT_EVERY_N_FRAMES === 0) {
            try {
              const vw = video.videoWidth;
              const vh = video.videoHeight;
              const found = objectDetector.detectForVideo(video, now).detections.flatMap((d) => {
                const b = d.boundingBox;
                // A chair overlapping the worker can rank below "person": prefer a class that can be held, else
                // any non-person class for pickHeldObject's hand-contact fallback. A person is never a load.
                const c =
                  d.categories.find((k) => Object.hasOwn(HELD_LABELS, k.categoryName)) ??
                  d.categories.find((k) => k.categoryName !== "person");
                if (!b || !c) return [];
                const box = { x: b.originX / vw, y: b.originY / vh, w: b.width / vw, h: b.height / vh };
                return [{ box, label: c.categoryName, score: c.score }];
              });
              // The current track is passed in so a detection continuing its trajectory wins even 1 frame behind the hands.
              const held = pickHeldObject(found, contactPoints(pose), visiblePoints(pose, GRIP_POINTS), tracked, anchor);
              tracked = updateTrack(tracked, held, now, anchor, carrying);
              detectFailures = 0;
            } catch (err) {
              // Skip this frame and keep trying; only a detector that keeps failing is shut down.
              console.warn("[object] detection failed", err);
              tracked = updateTrack(tracked, null, now, anchor, carrying);
              if (++detectFailures >= MAX_DETECT_FAILURES) {
                objectDetector.close();
                objectDetector = null;
              }
            }
          } else {
            tracked = updateTrack(tracked, null, now, anchor, carrying);
          }
          // Display-only smoothing; the lift detector filters its own copy for measurement.
          shown = display.filter(pose, now);
        } else {
          display.reset();
          grip.reset();
          tracked = null;
        }

        const overlay = shown ? cb.current.getOverlay?.() : undefined;
        const label = tracked?.label ?? null;
        if (label !== lastLabel) {
          lastLabel = label;
          cb.current.onObjectLabel?.(label);
          // A different object: its grip must earn its own verdict, not inherit the old badge.
          pendingGrip = null;
          showGrip(null);
        }
        // Grade the grip on the detected object only, and only while the detector keeps confirming it.
        // Losing the object clears the grip at once; while it is briefly missed (edge-on) the last
        // verdict stays up; a new verdict must hold steady with fresh detections first.
        if (!tracked || !pose) {
          pendingGrip = null;
          showGrip(null);
        } else if (now - tracked.lastSeen <= GRIP_FRESH_MS) {
          const fingers = FINGER_POINTS.map((i) => pose[i]);
          const verdict = assessGrip(tracked.box, tracked.label, pose[LM.L_WRIST], pose[LM.R_WRIST], fingers);
          if (gripKey(verdict) !== gripKey(pendingGrip)) {
            pendingGrip = verdict;
            pendingSince = now;
          }
          if (tracked.lastSeen - pendingSince >= GRIP_STABLE_MS) showGrip(verdict);
        } else {
          pendingGrip = null;
        }
        paint(canvas, cb.current.serverCanvasRef?.current, shown, overlay, tracked, shownGrip);

        frames++;
        if (now - windowStart >= 500) {
          report({
            status: "running",
            delegate: created.delegate,
            fps: Math.round((frames * 1000) / (now - windowStart)),
            personDetected,
          });
          frames = 0;
          windowStart = now;
        }
      };
      loop();
    }

    start().catch((err: unknown) => {
      if (cancelled) return;
      const text = describeError(err);
      setMessage({ text, button: "Try again" });
      report({ status: "error", message: text, fps: 0, personDetected: false });
      console.error("[camera]", err);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      stream?.getTracks().forEach((track) => track.stop());
      landmarker?.close();
      objectDetector?.close();
      // The restarted pipeline begins with no grip, so don't leave the old verdict on the alert banner.
      cb.current.onGripChange?.(null);
    };
  }, [attempt, quality]);

  // Replay: feed recorded landmarks through onPose in real time and draw them.
  // There is no video in a replay, so the load hitbox is always the hands box.
  useEffect(() => {
    if (!replay || replay.frames.length === 0) return;
    const canvas = canvasRef.current!;
    const frames = replay.frames;
    const t0 = frames[0].t;
    const end = frames[frames.length - 1].t - t0;
    const saved = { w: canvas.width, h: canvas.height };
    canvas.width = REPLAY_WIDTH;
    canvas.height = Math.round(REPLAY_WIDTH / frames[0].aspect);
    replayActive.current = true;

    const display = new LandmarkFilter(1.5, 6);
    const started = performance.now();
    let index = -1;
    let rafId = 0;
    let done = false;

    const tick = () => {
      if (done) return;
      const elapsed = performance.now() - started;
      // Feed every frame in order with its recorded timing, even if the browser
      // drops animation frames, so a replay always produces the same result.
      let shown: NormalizedLandmark[] | null = null;
      while (index + 1 < frames.length && frames[index + 1].t - t0 <= elapsed) {
        index++;
        const frame = { ...frames[index], t: started + (frames[index].t - t0) };
        cb.current.onPose?.(frame);
        shown = display.filter(frame.landmarks, frame.t);
      }
      if (shown) paint(canvas, cb.current.serverCanvasRef?.current, shown, cb.current.getOverlay?.(), null, null);
      if (elapsed > end + 600) {
        done = true;
        cb.current.onReplayEnd?.();
        return;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      done = true;
      cancelAnimationFrame(rafId);
      replayActive.current = false;
      // With the camera running, hand the canvas back. Without it, keep the last
      // replay frame on screen for discussion.
      if (videoRef.current?.srcObject) {
        canvas.width = saved.w;
        canvas.height = saved.h;
        paint(canvas, cb.current.serverCanvasRef?.current, null, undefined, null, null);
      }
    };
  }, [replay]);

  const onMessageButton = () => {
    if (startClickRef.current) {
      startClickRef.current();
      startClickRef.current = null;
    } else {
      setAttempt((n) => n + 1);
    }
  };

  // Keep the replay's shape after it ends too, so a frozen last frame isn't stretched.
  const lastReplayAspect = useRef<number | null>(null);
  if (replay) lastReplayAspect.current = replay.frames[0]?.aspect ?? null;
  const cameraLive = message === null;
  const shownAspect = replay || !cameraLive ? (lastReplayAspect.current ?? aspect) : aspect;

  return (
    <div className={`camera${replay ? " is-replay" : ""}`} style={{ aspectRatio: shownAspect }}>
      <video ref={videoRef} playsInline muted />
      <canvas ref={canvasRef} />
      {children}
      {message && !replay && (
        <div className={`camera-message${lastReplayAspect.current ? " compact" : ""}`}>
          <div>
            <p>{message.text}</p>
            {message.button && (
              <button className="btn primary" onClick={onMessageButton}>
                {message.button}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function describeError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") return "Camera permission denied. Allow camera access in the address bar and reload.";
    if (err.name === "NotFoundError") return "No camera found. Plug in a webcam and reload, or use Replay below.";
    if (err.name === "NotReadableError") return "Camera is in use by another app (Zoom, Teams, Camera app?). Close it and reload.";
  }
  return `Could not start: ${err instanceof Error ? err.message : String(err)}`;
}
