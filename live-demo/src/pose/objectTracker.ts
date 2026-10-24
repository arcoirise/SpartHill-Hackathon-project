import { LM } from "./landmarks";

/** Axis-aligned box in normalized image coordinates (0–1, unmirrored). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Candidate {
  box: Box;
  label: string;
  score: number;
  /** Share of the detector's box height added on top for a gripped backrest (set by pickHeldObject). */
  raised?: number;
}

export interface TrackedObject extends Candidate {
  /** performance.now() of the last frame a detection supported this box. */
  lastSeen: number;
  /** Grip anchor on the last update, so the box moves with the hands. */
  hand?: Point;
  /** Smoothed grip displacement per frame, used to coast without an anchor. */
  vx?: number;
  vy?: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Landmark with MediaPipe visibility. */
export interface Wrist extends Point {
  visibility?: number;
}

export type GripStatus = "proper" | "wrong_top" | "wrong_uneven";
export interface GripAssessment {
  status: GripStatus;
  /** Short badge shown on the 3D hitbox, e.g. "chair · WRONG GRIP (backrest)" or "chair · PROPER GRIP ✓" */
  badge: string;
  /** Coaching message for the alert banner & future LLM prompt context */
  message: string | null;
}

/**
 * COCO classes that can be a held load, and how they are shown. Chosen for a
 * live demo where turning around with a chair, phone, box, backpack or bottle
 * must keep working; the trade-off (accepted) is that background furniture can
 * occasionally be picked when the hands touch it. Any other non-person class
 * is still accepted on direct hand contact.
 */
export const HELD_LABELS: Record<string, string> = {
  chair: "chair",
  couch: "chair", // Padded chairs close to the webcam can look like couches.
  bench: "chair",
  bed: "chair",
  "dining table": "chair",
  "cell phone": "phone",
  remote: "phone",
  backpack: "backpack",
  handbag: "bag",
  umbrella: "bag",
  suitcase: "box",
  book: "box",
  microwave: "box",
  oven: "box",
  toaster: "box",
  tv: "box",
  bottle: "bottle",
  cup: "cup",
  "wine glass": "cup",
  bowl: "container",
  vase: "container",
  laptop: "laptop",
  keyboard: "equipment",
  mouse: "equipment",
  scissors: "tool",
  "potted plant": "load",
  "sports ball": "item",
  "teddy bear": "item",
};
/** Reach is 0.85 times the longest box side, from any angle. */
const HAND_REACH_MARGIN = 0.85;
/** Allow wrists above a chair's seat/legs-only box, up to 38% of the frame. */
const MAX_REACH = 0.38;
/** A held object may cover up to 92% of the frame when close to the webcam. */
const MAX_FRAME_FRACTION = 0.92;
/** Unmapped classes require a hand grip point within 14% of the frame; elbows alone don't count. */
const CONTACT_DISTANCE = 0.14;
/** Unmapped classes may cover at most 85% of the frame. */
const MAX_CONTACT_AREA = 0.85;
/** Contacted objects covering at least 12% of the frame are chair- or box-sized. */
const LARGE_CONTACT_AREA = 0.12;
/** Contacted objects at least 28% of the frame tall are chair- or box-sized. */
const TALL_CONTACT_H = 0.28;
/** Hand and elbow points within 15% of the frame count toward contact. */
const HAND_CONTACT_DISTANCE = 0.15;
/** Grip points within 20% of the frame count toward two-handed support. */
const GRIP_CONTACT_DISTANCE = 0.20;
/** Score added for each nearby hand or elbow point. */
const CONTACT_BONUS = 0.10;
/** Cap the contact bonus at four points. */
const MAX_CONTACT_POINTS = 4;
/** Score added when at least two grip points support the object. */
const TWO_HAND_BONUS = 0.18;
/** Two nearby grip points establish two-handed support. */
const MIN_GRIP_POINTS = 2;
/** How strongly a new detection pulls the box: high, so it keeps up with a turning worker. */
const SMOOTHING = 0.72;
/** Keep the box alive with the hands for 2600 ms while the object is edge-on and missed. */
export const HOLD_MS = 2600;
/** Keep following a visible grip for up to 8 seconds during a carry. */
export const HOLD_CARRY_MS = 8000;
/** Overlap with the predicted box that supports trajectory continuity. */
const CONTINUITY_IOU = 0.12;
/** Nearby box centers also support continuity when overlap is weak. */
const CONTINUITY_DISTANCE = 0.22;
/** Extra reach for a continuous track, added after the normal reach cap. */
const CONTINUITY_REACH = 0.08;
/** Score added to detections that follow the tracked trajectory. */
const CONTINUITY_BONUS = 0.22;
/** A detection overlapping the hand-shifted box at least this much is the same object. */
const SAME_OBJECT_IOU = 0.05;
/** Direct overlap of at least 25% anchors the box during a re-grip. */
const REGRIP_IOU = 0.25;
/** Direct overlap must beat predicted overlap by this much to indicate a re-grip. */
const REGRIP_ADVANTAGE = 0.08;
/** Retain this fraction of velocity while coasting without a prior anchor. */
const VELOCITY_DECAY = 0.85;
/** Minimum landmark visibility for the carry posture heuristic. */
const CARRY_VISIBLE = 0.35;
/** A smaller interior elbow angle indicates a flexed carrying arm. */
const CARRY_ELBOW_ANGLE = 155;
/** Wrists below this image height cannot establish a carry. */
const CARRY_WRIST_Y = 0.85;
/** Maximum distance between two hands held together above the hips. */
const CARRY_HAND_DISTANCE = 0.48;
/** Generic detections below this confidence retain an existing chair label. */
const STICKY_LABEL_MAX_SCORE = 0.35;
/** Generic labels that can briefly replace a tilted chair's class. */
const GENERIC_LABELS = new Set(["load", "box", "item"]);

const area = (b: Box) => b.w * b.h;

const centerDistance = (a: Box, b: Box) => Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2);

/** Flexed arms or two nearby hands above the hips suggest a carried load. */
export function isCarryingLoad(landmarks: ReadonlyArray<Wrist>, aspect = 1): boolean {
  const visible = (p?: Wrist): p is Wrist => !!p && (p.visibility ?? 0) >= CARRY_VISIBLE;
  for (const [s, e, w] of [[LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST], [LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST]]) {
    const shoulder = landmarks[s];
    const elbow = landmarks[e];
    const wrist = landmarks[w];
    if (!visible(shoulder) || !visible(elbow) || !visible(wrist) || wrist.y >= CARRY_WRIST_Y) continue;
    const ax = (shoulder.x - elbow.x) * aspect;
    const ay = shoulder.y - elbow.y;
    const bx = (wrist.x - elbow.x) * aspect;
    const by = wrist.y - elbow.y;
    const length = Math.hypot(ax, ay) * Math.hypot(bx, by);
    if (length === 0) continue;
    const angle = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / length))) * 180 / Math.PI;
    if (angle < CARRY_ELBOW_ANGLE) return true;
  }
  const left = landmarks[LM.L_WRIST];
  const right = landmarks[LM.R_WRIST];
  const hips = [landmarks[LM.L_HIP], landmarks[LM.R_HIP]].filter(visible);
  if (!visible(left) || !visible(right) || hips.length === 0) return false;
  const hipY = hips.reduce((sum, p) => sum + p.y, 0) / hips.length;
  return left.y < CARRY_WRIST_Y && right.y < CARRY_WRIST_Y &&
    left.y < hipY && right.y < hipY && Math.hypot(left.x - right.x, left.y - right.y) < CARRY_HAND_DISTANCE;
}

function distanceToBox(p: Point, b: Box): number {
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
  return Math.hypot(dx, dy);
}

export function intersectionArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return Math.max(0, w) * Math.max(0, h);
}

/**
 * The detection the hands are holding, if any. `hands` = visible hand and
 * elbow points. Prefers boxes the hands touch and are near the middle of,
 * nudged by detector confidence, known chairs and multiple contact points.
 * Two nearby grip points add a bonus; other non-person classes need a grip
 * point in direct contact and map by size. Only grip points extend a box for
 * a missed backrest. A continuous trajectory adds reach and selection priority.
 */
export function pickHeldObject(
  candidates: Candidate[], hands: Point[], gripPoints: Point[] = hands,
  prevTrack: TrackedObject | null = null, hand?: Point,
): Candidate | null {
  if (hands.length === 0) return null;
  const expectedBox = prevTrack ? shiftWithHand(prevTrack, hand) : null;
  let best: Candidate | null = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    if (c.label === "person") continue;
    const mappedLabel = HELD_LABELS[c.label];
    const boxArea = area(c.box);
    if (boxArea > MAX_FRAME_FRACTION) continue;
    const continuity = expectedBox !== null &&
      (iou(expectedBox, c.box) >= CONTINUITY_IOU || centerDistance(expectedBox, c.box) < CONTINUITY_DISTANCE);
    const reach = Math.min(HAND_REACH_MARGIN * Math.max(c.box.w, c.box.h), MAX_REACH)
      + (continuity ? CONTINUITY_REACH : 0);
    const nearest = Math.min(...hands.map((h) => distanceToBox(h, c.box)));
    if (nearest > reach) continue;
    let label = mappedLabel;
    if (!label) {
      const gripNearest = Math.min(...gripPoints.map((h) => distanceToBox(h, c.box)));
      if (gripNearest > Math.min(CONTACT_DISTANCE, reach) || boxArea > MAX_CONTACT_AREA) continue;
      label = boxArea >= LARGE_CONTACT_AREA || c.box.h >= TALL_CONTACT_H
        ? (c.box.h >= c.box.w ? "chair" : "box") : "load";
    }
    const centerDist = Math.min(...hands.map((h) => Math.hypot(h.x - (c.box.x + c.box.w / 2), h.y - (c.box.y + c.box.h / 2))));
    const contactCount = hands.filter((h) => distanceToBox(h, c.box) <= HAND_CONTACT_DISTANCE).length;
    const gripCount = gripPoints.filter((h) => distanceToBox(h, c.box) <= GRIP_CONTACT_DISTANCE).length;
    // Only known chair-like classes get the chair bonus, not fallback shapes.
    const score = c.score - 2.0 * nearest - 0.5 * centerDist + (mappedLabel === "chair" ? 0.18 : 0)
      + CONTACT_BONUS * Math.min(contactCount, MAX_CONTACT_POINTS) + (gripCount >= MIN_GRIP_POINTS ? TWO_HAND_BONUS : 0)
      + (continuity ? CONTINUITY_BONUS : 0);
    if (score > bestScore) {
      best = { ...c, label };
      bestScore = score;
    }
  }
  if (best && (best.label === "chair" || best.label === "box" || best.label === "load")) {
    let box = best.box;
    const handsAbove = gripPoints.filter((h) =>
      h.x >= box.x - 0.15 && h.x <= box.x + box.w + 0.15 &&
      h.y >= box.y - 0.36 && h.y < box.y,
    );
    if (handsAbove.length > 0) {
      const newY = Math.max(0, Math.min(...handsAbove.map((h) => h.y)) - 0.04);
      const raised = (box.y - newY) / box.h;
      box = { ...box, y: newY, h: box.y + box.h - newY };
      return { ...best, box, raised };
    }
  }
  return best;
}

/** Fingertips count 60% and wrists 40% toward the grip height: the fingers are what touch a backrest or seat base. */
const FINGER_GRIP_WEIGHT = 0.6;

/**
 * Screening heuristic from the 2D wrist and (optional) fingertip positions
 * relative to the box. Only fingertips that are seen and touch the box count.
 */
export function assessGrip(
  box: Box, label: string, leftWrist?: Wrist, rightWrist?: Wrist, fingerPoints: Wrist[] = [],
): GripAssessment {
  const visible = (w?: Wrist) => (w?.visibility ?? 0) > 0.25;
  const wrists = [leftWrist, rightWrist].filter((w): w is Wrist => !!w);
  let gripping = wrists.filter((w) => visible(w) && distanceToBox(w, box) <= 0.25);
  if (gripping.length === 0) {
    const moreVisible = (leftWrist?.visibility ?? 0) >= (rightWrist?.visibility ?? 0) ? leftWrist : rightWrist;
    if (moreVisible && visible(moreVisible)) gripping = [moreVisible];
  }
  const fingers = fingerPoints.filter((p) => visible(p) && distanceToBox(p, box) <= 0.25);
  const height = Math.max(box.h, 0.05);
  const relY = (points: Wrist[]) => points.reduce((sum, p) => sum + (p.y - box.y) / height, 0) / points.length;
  let averageRelY = gripping.length > 0 ? relY(gripping) : relY(fingers);
  if (gripping.length > 0 && fingers.length > 0) {
    averageRelY = FINGER_GRIP_WEIGHT * relY(fingers) + (1 - FINGER_GRIP_WEIGHT) * relY(gripping);
  }
  if (gripping.length + fingers.length > 0 && averageRelY < 0.38) {
    if (label === "chair") {
      return {
        status: "wrong_top",
        badge: "chair · WRONG GRIP (backrest)",
        message: "Improper chair grip: hands are holding the upper backrest — grip both sides of the seat base to control the center of gravity",
      };
    }
    return {
      status: "wrong_top",
      badge: `${label} · WRONG GRIP (top edge)`,
      message: `Improper ${label} grip: hands are holding the top edge — support the lower sides/base near the center of gravity`,
    };
  }
  const bulky = ["chair", "box", "backpack", "load"].includes(label) || area(box) > 0.14;
  // Occluded far wrists still count by position, but cannot establish a tilt.
  const onLoad = wrists.filter((w) => distanceToBox(w, box) <= 0.20).length;
  const tilted = leftWrist && rightWrist && visible(leftWrist) && visible(rightWrist) &&
    Math.abs(leftWrist.y - rightWrist.y) / height > 0.38;
  if (bulky && (onLoad < 2 || tilted)) {
    return {
      status: "wrong_uneven",
      badge: `${label} · UNEVEN GRIP`,
      message: `Unbalanced grip on ${label}: use both hands evenly on opposite sides of the load`,
    };
  }
  return { status: "proper", badge: `${label} · PROPER GRIP ✓`, message: null };
}

function lerpBox(a: Box, b: Box, t: number): Box {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    w: a.w + (b.w - a.w) * t,
    h: a.h + (b.h - a.h) * t,
  };
}

/** Move with the grip or coast on damped velocity, preserving box size at frame edges. */
function shiftWithHand(prev: TrackedObject, hand?: Point): Box {
  let dx: number;
  let dy: number;
  if (hand && prev.hand) {
    dx = hand.x - prev.hand.x;
    dy = hand.y - prev.hand.y;
  } else if (!hand && (prev.vx || prev.vy)) {
    dx = (prev.vx ?? 0) * VELOCITY_DECAY;
    dy = (prev.vy ?? 0) * VELOCITY_DECAY;
  } else {
    return prev.box;
  }
  return {
    ...prev.box,
    x: Math.max(0, Math.min(1 - prev.box.w, prev.box.x + dx)),
    y: Math.max(0, Math.min(1 - prev.box.h, prev.box.y + dy)),
  };
}

/**
 * Anchors the box on direct detection overlap during re-grips, otherwise
 * follows the hands before smoothing toward the same object's detection.
 * Keeps a chair label through weak generic detections and follows the hands
 * 1:1 through missed detections for HOLD_MS, or HOLD_CARRY_MS while carrying.
 */
export function updateTrack(
  prev: TrackedObject | null,
  detection: Candidate | null,
  now: number,
  hand?: Point,
  carrying = false,
): TrackedObject | null {
  const holdLimit = carrying && hand ? HOLD_CARRY_MS : HOLD_MS;
  const alive = prev && now - prev.lastSeen <= holdLimit ? prev : null;
  const hasMotion = hand && alive?.hand;
  const vx = hasMotion ? 0.5 * (alive.vx ?? 0) + 0.5 * (hand.x - alive.hand!.x) : 0;
  const vy = hasMotion ? 0.5 * (alive.vy ?? 0) + 0.5 * (hand.y - alive.hand!.y) : 0;
  if (!detection) {
    if (!alive) return null;
    // Clear a missing anchor so its return establishes a fresh baseline.
    return {
      ...alive, box: shiftWithHand(alive, hand), hand,
      vx: hasMotion ? vx : (alive.vx ?? 0) * VELOCITY_DECAY,
      vy: hasMotion ? vy : (alive.vy ?? 0) * VELOCITY_DECAY,
      score: carrying && hand ? Math.max(alive.score * 0.985, Math.min(alive.score, 0.15)) : alive.score * 0.92,
    };
  }
  const shifted = alive ? shiftWithHand(alive, hand) : null;
  const shiftedIou = shifted ? iou(shifted, detection.box) : 0;
  const directIou = alive ? iou(alive.box, detection.box) : 0;
  const useDirect = directIou >= REGRIP_IOU && directIou > shiftedIou + REGRIP_ADVANTAGE;
  if (!alive || !shifted || (!useDirect && shiftedIou < SAME_OBJECT_IOU && directIou < REGRIP_IOU)) {
    return { ...detection, lastSeen: now, hand, vx: 0, vy: 0 };
  }
  const effectiveLabel = alive.label === "chair" && GENERIC_LABELS.has(detection.label) && detection.score < STICKY_LABEL_MAX_SCORE
    ? "chair" : detection.label;
  let raw = detection.box;
  if (detection.raised !== undefined) {
    const rawH = detection.box.h / (1 + detection.raised);
    raw = { ...detection.box, y: detection.box.y + detection.box.h - rawH, h: rawH };
  }
  // The backrest only grows for the same object; drop its memory on full detection,
  // a label change, or track replacement.
  const keep = alive.raised !== undefined && alive.label === effectiveLabel &&
    raw.h < 1.3 * alive.box.h / (1 + alive.raised);
  const raised = keep ? Math.max(alive.raised!, detection.raised ?? 0) : detection.raised;
  let box = detection.box;
  if (raised !== undefined) {
    const y = Math.max(0, raw.y - raised * raw.h);
    box = { ...raw, y, h: raw.y + raw.h - y };
  }
  // A seat-only detection can fit inside both boxes after clamping; the remembered
  // full backrest distinguishes a stationary re-grip from real object movement.
  const backrestRegrip = keep && directIou >= REGRIP_IOU &&
    iou(alive.box, box) > iou(shifted, box) + REGRIP_ADVANTAGE;
  const base = useDirect || backrestRegrip ? alive.box : shifted;
  return {
    box: lerpBox(base, box, SMOOTHING),
    label: effectiveLabel,
    score: detection.score,
    raised,
    lastSeen: now,
    hand,
    vx,
    vy,
  };
}

/**
 * Where the hands grip, as a visibility²-weighted blend of both wrists and
 * index fingers: the midpoint of the hands when both are visible, sliding
 * smoothly to the visible hand when the worker turns side-on and the far
 * hand is hidden. Never undefined while a pose is present.
 */
export function gripAnchor(left: Wrist, right: Wrist, leftIndex?: Wrist, rightIndex?: Wrist): Point {
  const pts = [left, right, leftIndex, rightIndex].filter((p): p is Wrist => !!p);
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (const p of pts) {
    const w = Math.max(p.visibility ?? 0, 0.05) ** 2;
    sx += p.x * w;
    sy += p.y * w;
    sw += w;
  }
  return { x: sx / sw, y: sy / sw };
}

/**
 * Motion-consistent grip anchor for moving the tracked box. gripAnchor's
 * weighted mean shifts when only the visibilities change (the far hand fading
 * out as the worker turns), which would drag the box with no real movement.
 * This anchor instead moves by each landmark's own frame-to-frame
 * displacement, weighted by how visible that landmark was in both frames, so
 * it follows real hand motion and ignores visibility changes.
 */
export class GripTracker {
  private prev: Wrist[] | null = null;
  private anchor: Point | null = null;

  reset() {
    this.prev = null;
    this.anchor = null;
  }

  update(points: Wrist[]): Point {
    if (!this.prev || !this.anchor || this.prev.length !== points.length) {
      this.prev = points.map((p) => ({ ...p }));
      this.anchor = gripAnchor(points[0], points[1], points[2], points[3]);
      return this.anchor;
    }
    let dx = 0;
    let dy = 0;
    let sw = 0;
    points.forEach((p, i) => {
      const q = this.prev![i];
      const w = Math.max(Math.min(p.visibility ?? 0, q.visibility ?? 0), 0.05) ** 2;
      dx += (p.x - q.x) * w;
      dy += (p.y - q.y) * w;
      sw += w;
    });
    this.anchor = { x: this.anchor.x + dx / sw, y: this.anchor.y + dy / sw };
    this.prev = points.map((p) => ({ ...p }));
    return this.anchor;
  }
}

const WRIST_VISIBLE = 0.3;

/** handsBox from visible wrists only; null when neither wrist is visible. */
export function visibleHandsBox(left: Wrist, right: Wrist, aspect: number): Box | null {
  const l = (left.visibility ?? 0) > WRIST_VISIBLE;
  const r = (right.visibility ?? 0) > WRIST_VISIBLE;
  if (!l && !r) return null;
  return handsBox(l ? left : right, r ? right : left, aspect);
}

/**
 * Fallback load box during an active lift when no object is recognised: a
 * square (in pixels) between the wrists, big enough for a box or chair and
 * hanging a little below the hands, where a carried load sits.
 */
export function handsBox(left: Point, right: Point, aspect: number): Box {
  const minSide = 0.22; // image-height units
  const pad = 0.08;
  const side = Math.max(Math.abs(left.x - right.x) * aspect + pad, Math.abs(left.y - right.y) + pad, minSide);
  const cx = (left.x + right.x) / 2;
  const cy = (left.y + right.y) / 2 + side * 0.15;
  return { x: cx - side / aspect / 2, y: cy - side / 2, w: side / aspect, h: side };
}

export function iou(a: Box, b: Box): number {
  const inter = intersectionArea(a, b);
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}
