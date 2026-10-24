import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import { HIP_TO_KNEE_PER_TORSO } from "../lift/measure";
import { LM } from "../pose/landmarks";

/** Stick colour by posture. */
export const POSTURE_COLORS = {
  /** Upright / safe. */
  safe: "#22d3ee",
  /** Reaching or bending moderately. */
  moderate: "#fbbf24",
  /** Deep bend: pickup below the knees or trunk bent past 35°. */
  deep: "#f87171",
} as const;

/** What the camera overlay needs per frame. */
export interface Overlay {
  /** Stickman colour for the current posture. */
  color: string;
  /** The hands are holding (or lifting) a load: wrap them in a load box even if no object is detected. */
  holdingLoad: boolean;
}

/** Normalized, unmirrored box (0–1 image units). */
export interface HitboxBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const HITBOX = { edge: "#ffffff", loop: "#ef4444", vector: "#3b82f6", target: "#22c55e" };

/** Same values as GripStatus in pose/objectTracker. */
export type HitboxGrip = "proper" | "wrong_top" | "wrong_uneven";

/** Loop and label colours by grip assessment; no assessment keeps the plain red loop and white label. */
function gripColors(grip?: HitboxGrip): { loop: string; text: string } {
  if (grip === "proper") return { loop: "#22c55e", text: "#4ade80" };
  if (grip) return { loop: "#f43f5e", text: "#fb7185" };
  return { loop: HITBOX.loop, text: HITBOX.edge };
}

/** Target grip zone on the front face, as fractions of its height from the top (seat base / centre of gravity). */
const GRIP_ZONE = { top: 0.55, bottom: 0.75 };

/**
 * Draws the lifted object as a transparent 3D wireframe cuboid: front face,
 * a back face offset up and to the side, the four connecting edges, a loop
 * around it 38% down from the top (coloured by `grip`), and a short blue
 * vector from its centre pointing in the lift direction. With a grip
 * assessment, green brackets on both sides mark where the hands should go.
 * No joints, no fill.
 */
export function drawHitbox(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  mirror: boolean,
  box: HitboxBox,
  label?: string,
  grip?: HitboxGrip,
) {
  const colors = gripColors(grip);
  const s = Math.max(1, w / 1280);
  const fx = (mirror ? 1 - box.x - box.w : box.x) * w;
  const fy = box.y * h;
  const bw = box.w * w;
  const bh = box.h * h;
  const bx = fx + bw * 0.14;
  const by = fy - bh * 0.12;

  const line = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Cuboid: back face, front face, and the edges joining their corners.
  ctx.strokeStyle = HITBOX.edge;
  ctx.lineWidth = 2 * s;
  ctx.strokeRect(bx, by, bw, bh);
  ctx.strokeRect(fx, fy, bw, bh);
  line(fx, fy, bx, by);
  line(fx + bw, fy, bx + bw, by);
  line(fx, fy + bh, bx, by + bh);
  line(fx + bw, fy + bh, bx + bw, by + bh);

  // Loop around the cuboid, 38% down from the top face: the top-grip line.
  const yf = fy + bh * 0.38;
  const yb = by + bh * 0.38;
  ctx.strokeStyle = colors.loop;
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.moveTo(fx, yf);
  ctx.lineTo(fx + bw, yf);
  ctx.lineTo(bx + bw, yb);
  ctx.lineTo(bx, yb);
  ctx.closePath();
  ctx.stroke();

  // Green "[ ]" brackets on the front face's side edges: the target hand zone.
  if (grip) {
    const top = fy + bh * GRIP_ZONE.top;
    const bottom = fy + bh * GRIP_ZONE.bottom;
    const tick = Math.min(8 * s, bw * 0.15);
    ctx.strokeStyle = HITBOX.target;
    ctx.lineWidth = 3 * s;
    for (const [x, dir] of [
      [fx, 1],
      [fx + bw, -1],
    ]) {
      ctx.beginPath();
      ctx.moveTo(x + dir * tick, top);
      ctx.lineTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.lineTo(x + dir * tick, bottom);
      ctx.stroke();
    }
  }

  // Blue vector from the centre, pointing up (the lift direction).
  const cx = (fx + bx + bw) / 2;
  const cy = (fy + by + bh) / 2;
  const tipY = cy - bh * 0.45;
  ctx.strokeStyle = HITBOX.vector;
  ctx.fillStyle = HITBOX.vector;
  ctx.lineWidth = 2.5 * s;
  line(cx, cy, cx, tipY);
  ctx.beginPath();
  ctx.moveTo(cx, tipY - 6 * s);
  ctx.lineTo(cx - 5 * s, tipY + 3 * s);
  ctx.lineTo(cx + 5 * s, tipY + 3 * s);
  ctx.closePath();
  ctx.fill();

  if (label) {
    ctx.font = `600 ${Math.round(14 * s)}px "Segoe UI", system-ui, sans-serif`;
    ctx.fillStyle = colors.text;
    ctx.textBaseline = "bottom";
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowBlur = 4 * s;
    ctx.fillText(label, Math.min(fx, bx), Math.min(fy, by) - 6 * s);
  }
  ctx.restore();
}

type Joint = { x: number; y: number; visibility: number; estimated?: boolean };

/** A landmark is drawn only when MediaPipe actually sees it (hidden joints are guesses and flail). */
const isVisible = (p: Joint) => p.visibility > 0.5;

function mid(a: NormalizedLandmark, b: NormalizedLandmark): Joint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, visibility: Math.max(a.visibility ?? 0, b.visibility ?? 0) };
}

/** Hand and finger colour: green on a proper grip, rose on a wrong one, else the stickman colour. */
function handColor(grip: HitboxGrip | undefined, color: string): string {
  if (grip === "proper") return "#4ade80";
  if (grip) return "#fb7185";
  return color;
}

/** Hands are drawn from a less certain wrist than the body, fingers from less certain knuckles. */
const HAND_VISIBLE = 0.35;
const FINGER_VISIBLE = 0.2;
/**
 * The pose model's INDEX/PINKY/THUMB points are knuckles at the base of the fingers, not
 * fingertips. Finger joints (MCP knuckle, PIP, DIP, tip) as multiples of the wrist→knuckle palm vector.
 */
const FINGER_JOINTS = [1, 1.52, 1.95, 2.38];
const FINGER_TIP = FINGER_JOINTS[FINGER_JOINTS.length - 1];
/** Length of the index, middle, ring and pinky fingers relative to the ring finger. */
const FINGER_LENGTH = [0.96, 1.08, 1, 0.82];
/** Where the index, middle, ring and pinky knuckles sit on the knuckle line, from pinky (0) to index (1). */
const FINGER_SHARE = [1, 2 / 3, 1 / 3, 0];
/** Thumb joints (MCP, IP, tip) along the wrist→thumb ray. */
const THUMB_JOINTS = [0.85, 1.35, 1.85];
/** The pose knuckles sit inside the hand's outline: widen the index–pinky span to the full palm. */
const PALM_WIDEN = 1.28;
/** Fingertips spread this much wider than the knuckles. */
const FINGER_FAN = 1.18;
/** The thumb opens to the side of the palm by this share of the palm width. */
const THUMB_OPEN = 0.28;
/** A palm turned toward the camera looks too short: it is stretched to at least this share of the forearm. */
const MIN_PALM_PER_FOREARM = 0.28;
/** Most the palm is stretched, so a near-zero palm vector can't fling the fingers in a random direction. */
const MAX_PALM_STRETCH = 3;
/** [wrist, thumb, index, pinky, elbow] per hand. */
const HANDS = [
  [LM.L_WRIST, LM.L_THUMB, LM.L_INDEX, LM.L_PINKY, LM.L_ELBOW],
  [LM.R_WRIST, LM.R_THUMB, LM.R_INDEX, LM.R_PINKY, LM.R_ELBOW],
] as const;

type Point = { x: number; y: number };

/**
 * Finger joints of one hand in canvas pixels, thumb first, then index to pinky (null = not
 * drawn). The four fingers run along the palm axis (wrist → knuckle midpoint) past their
 * knuckles, fanning out slightly; the middle and ring fingers are placed on the knuckle
 * line between index and pinky, only when both are seen.
 */
function handJoints(
  pose: NormalizedLandmark[],
  [wristId, thumbId, indexId, pinkyId, elbowId]: (typeof HANDS)[number],
  px: (p: NormalizedLandmark) => Point,
): (Point[] | null)[] {
  const wrist = px(pose[wristId]);
  // Vectors from the wrist, so the palm can be widened and stretched about it.
  const from = (i: number): Point | null => {
    if ((pose[i].visibility ?? 0) <= FINGER_VISIBLE) return null;
    const p = px(pose[i]);
    return { x: p.x - wrist.x, y: p.y - wrist.y };
  };
  const thumb = from(thumbId);
  let index = from(indexId);
  let pinky = from(pinkyId);
  if (index && pinky) {
    const mx = (index.x + pinky.x) / 2;
    const my = (index.y + pinky.y) / 2;
    index = { x: mx + (index.x - mx) * PALM_WIDEN, y: my + (index.y - my) * PALM_WIDEN };
    pinky = { x: mx + (pinky.x - mx) * PALM_WIDEN, y: my + (pinky.y - my) * PALM_WIDEN };
  }
  // Palm axis: wrist → middle of the knuckle line (or the one knuckle that is seen).
  const axis = index && pinky ? { x: (index.x + pinky.x) / 2, y: (index.y + pinky.y) / 2 } : (index ?? pinky);

  let stretch = 1;
  const elbow = pose[elbowId];
  const palm = axis ? Math.hypot(axis.x, axis.y) : 0;
  if (palm > 0 && (elbow.visibility ?? 0) > HAND_VISIBLE) {
    const e = px(elbow);
    const minPalm = MIN_PALM_PER_FOREARM * Math.hypot(wrist.x - e.x, wrist.y - e.y);
    if (palm < minPalm) stretch = Math.min(minPalm / palm, MAX_PALM_STRETCH);
  }

  const fingers: (Point[] | null)[] = [];
  if (thumb) {
    // Push the thumb ray toward the index side so the thumb opens beside the palm.
    const ray = index && pinky ? { x: thumb.x + (index.x - pinky.x) * THUMB_OPEN, y: thumb.y + (index.y - pinky.y) * THUMB_OPEN } : thumb;
    fingers.push(THUMB_JOINTS.map((t) => ({ x: wrist.x + ray.x * t * stretch, y: wrist.y + ray.y * t * stretch })));
  } else {
    fingers.push(null);
  }
  for (let f = 0; f < FINGER_SHARE.length; f++) {
    // Middle and ring need both index and pinky; a lone index or pinky is drawn on its own.
    const knuckle =
      index && pinky
        ? { x: pinky.x + (index.x - pinky.x) * FINGER_SHARE[f], y: pinky.y + (index.y - pinky.y) * FINGER_SHARE[f] }
        : f === 0 ? index : f === 3 ? pinky : null;
    if (!axis || !knuckle) {
      fingers.push(null);
      continue;
    }
    // Each finger runs along the palm axis, offset sideways from its midline by its knuckle, fanning toward the tip.
    const side = { x: knuckle.x - axis.x, y: knuckle.y - axis.y };
    fingers.push(
      FINGER_JOINTS.map((t) => {
        const along = t * FINGER_LENGTH[f];
        const fan = 1 + ((FINGER_FAN - 1) * (t - 1)) / (FINGER_TIP - 1);
        return {
          x: wrist.x + (axis.x * along + side.x * fan) * stretch,
          y: wrist.y + (axis.y * along + side.y * fan) * stretch,
        };
      }),
    );
  }
  return fingers;
}

/**
 * Draws a single-spine stickman with joint dots: shoulders and hips joined
 * through their midpoints, one spine between them, arms and legs as plain
 * sticks. Each visible hand gets a palm-sized hand with five fingers (wrist →
 * MCP knuckle → PIP → DIP → tip; thumb MCP → IP → tip) and a dot on every
 * finger joint, coloured by `grip` so a viewer can see where the fingers hold
 * the load. No face points (landmarks 0–10) or feet
 * are ever drawn. When a desk or the frame edge hides a knee, the thigh is
 * drawn dashed to a knee estimated from body proportions, so the figure never
 * looks broken.
 *
 * The video element is mirrored with CSS, so with `mirror` set every x is
 * flipped here too. With `background` set the canvas is filled first (used
 * for the video-free server view).
 */
export function drawStickman(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  mirror: boolean,
  pose: NormalizedLandmark[] | null,
  color: string,
  background?: string,
  grip?: HitboxGrip,
) {
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
  } else {
    ctx.clearRect(0, 0, w, h);
  }
  if (!pose) return;

  const s = Math.max(1, w / 1280);
  const at = (i: number): Joint => ({ x: pose[i].x, y: pose[i].y, visibility: pose[i].visibility ?? 0 });
  const shoulderMid = mid(pose[LM.L_SHOULDER], pose[LM.R_SHOULDER]);
  const hipMid = mid(pose[LM.L_HIP], pose[LM.R_HIP]);

  // Torso length in image-height units, for estimating hidden knees.
  const torso = Math.hypot((shoulderMid.x - hipMid.x) * (w / h), hipMid.y - shoulderMid.y);
  const kneeOf = (hip: number, knee: number): Joint => {
    const k = at(knee);
    if (isVisible(k) && k.y <= 1) return k;
    const hp = at(hip);
    return { x: hp.x, y: hp.y + HIP_TO_KNEE_PER_TORSO * torso, visibility: hp.visibility, estimated: true };
  };
  const lKnee = kneeOf(LM.L_HIP, LM.L_KNEE);
  const rKnee = kneeOf(LM.R_HIP, LM.R_KNEE);

  const chains: Joint[][] = [
    [shoulderMid, hipMid], // spine
    [at(LM.L_SHOULDER), shoulderMid, at(LM.R_SHOULDER)], // collarbone
    [at(LM.L_HIP), hipMid, at(LM.R_HIP)], // pelvis
    [at(LM.L_SHOULDER), at(LM.L_ELBOW), at(LM.L_WRIST)],
    [at(LM.R_SHOULDER), at(LM.R_ELBOW), at(LM.R_WRIST)],
    // Shins only from a real knee; an estimated knee ends the leg.
    lKnee.estimated ? [at(LM.L_HIP), lKnee] : [at(LM.L_HIP), lKnee, at(LM.L_ANKLE)],
    rKnee.estimated ? [at(LM.R_HIP), rKnee] : [at(LM.R_HIP), rKnee, at(LM.R_ANKLE)],
  ];
  const dots: Joint[] = [
    shoulderMid,
    hipMid,
    ...[
      LM.L_SHOULDER,
      LM.R_SHOULDER,
      LM.L_ELBOW,
      LM.R_ELBOW,
      LM.L_WRIST,
      LM.R_WRIST,
      LM.L_HIP,
      LM.R_HIP,
      LM.L_ANKLE,
      LM.R_ANKLE,
    ].map(at),
    lKnee,
    rKnee,
  ];

  const X = (x: number) => (mirror ? 1 - x : x) * w;
  const Y = (y: number) => y * h;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.lineWidth = 6 * s;
  ctx.shadowColor = color;
  ctx.shadowBlur = 10 * s;
  for (const chain of chains) {
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1];
      const b = chain[i];
      if (!isVisible(a) || !isVisible(b)) continue;
      ctx.globalAlpha = b.estimated ? 0.55 : 1;
      ctx.setLineDash(b.estimated ? [10 * s, 8 * s] : []);
      ctx.beginPath();
      ctx.moveTo(X(a.x), Y(a.y));
      ctx.lineTo(X(b.x), Y(b.y));
      ctx.stroke();
    }
  }

  ctx.shadowBlur = 0;
  ctx.setLineDash([]);
  for (const d of dots) {
    if (!isVisible(d)) continue;
    ctx.globalAlpha = d.estimated ? 0.55 : 1;
    ctx.beginPath();
    ctx.arc(X(d.x), Y(d.y), 6 * s, 0, Math.PI * 2);
    // Estimated joints are hollow.
    ctx.fillStyle = d.estimated ? "rgba(6,10,19,0.6)" : "#f8fafc";
    ctx.fill();
    ctx.lineWidth = 3 * s;
    ctx.stroke();
  }

  // Hands: phalanges and a dot on every finger joint, crisp (no glow), in the grip colour.
  ctx.globalAlpha = 1;
  ctx.strokeStyle = handColor(grip, color);
  ctx.fillStyle = "#f8fafc";
  const px = (p: NormalizedLandmark): Point => ({ x: X(p.x), y: Y(p.y) });
  for (const hand of HANDS) {
    const wrist = pose[hand[0]];
    if ((wrist.visibility ?? 0) <= HAND_VISIBLE) continue;
    const fingers = handJoints(pose, hand, px);
    ctx.lineWidth = 3.4 * s;
    for (const joints of fingers) {
      if (!joints) continue;
      ctx.beginPath();
      ctx.moveTo(X(wrist.x), Y(wrist.y));
      for (const j of joints) ctx.lineTo(j.x, j.y);
      ctx.stroke();
    }
    // Knuckle arch across the top of the palm: index → middle → ring → pinky MCP.
    const knuckles = fingers.slice(1).flatMap((joints) => (joints ? [joints[0]] : []));
    if (knuckles.length > 1) {
      ctx.beginPath();
      knuckles.forEach((k, i) => (i ? ctx.lineTo(k.x, k.y) : ctx.moveTo(k.x, k.y)));
      ctx.stroke();
    }
    ctx.lineWidth = 2.6 * s;
    for (const joints of fingers) {
      joints?.forEach((j, i) => {
        ctx.beginPath();
        ctx.arc(j.x, j.y, (i === joints.length - 1 ? 5.2 : 4.5) * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });
    }
  }
  ctx.restore();
}
