import { describe, expect, it } from "vitest";
import { LM } from "./landmarks";
import {
  GripTracker,
  HELD_LABELS,
  HOLD_MS,
  HOLD_CARRY_MS,
  assessGrip,
  gripAnchor,
  handsBox,
  iou,
  isCarryingLoad,
  pickHeldObject,
  updateTrack,
  visibleHandsBox,
  type Candidate,
  type Wrist,
} from "./objectTracker";

const box = (x: number, y: number, w = 0.2, h = 0.2) => ({ x, y, w, h });
const cand = (label: string, b = box(0.4, 0.5), score = 0.5): Candidate => ({ box: b, label, score });

describe("pickHeldObject", () => {
  // Hand in the middle of the default candidate box (0.4–0.6, 0.5–0.7).
  const hand = [{ x: 0.5, y: 0.6 }];

  it("maps held COCO classes to display labels", () => {
    expect(pickHeldObject([cand("chair")], hand)?.label).toBe("chair");
    expect(pickHeldObject([cand("couch")], hand)?.label).toBe("chair");
    expect(pickHeldObject([cand("bench")], hand)?.label).toBe("chair");
    expect(pickHeldObject([cand("bed")], hand)?.label).toBe("chair");
    expect(pickHeldObject([cand("dining table")], hand)?.label).toBe("chair");
    expect(pickHeldObject([cand("tv")], hand)?.label).toBe("box");
    expect(pickHeldObject([cand("suitcase")], hand)?.label).toBe("box");
    expect(pickHeldObject([cand("cell phone", box(0.48, 0.56, 0.05, 0.08))], hand)?.label).toBe("phone");
    expect(pickHeldObject([cand("backpack")], hand)?.label).toBe("backpack");
    expect(pickHeldObject([cand("bottle")], hand)?.label).toBe("bottle");
    expect(pickHeldObject([cand("potted plant")], hand)?.label).toBe("load");
    expect(Object.keys(HELD_LABELS)).toContain("teddy bear");
  });

  it("always rejects a person even with the hand centred on it", () => {
    expect(pickHeldObject([cand("person")], hand)).toBeNull();
  });

  it("extends capped reach by 0.08 only along the hand-shifted trajectory", () => {
    const candidate = cand("chair", box(0.02, 0.2, 0.5, 0.4));
    const anchor = { x: 0.95, y: 0.4 }; // 0.43 from the box, beyond the 0.38 cap.
    const prev = updateTrack(null, cand("chair", box(0.6, 0.2, 0.5, 0.4)), 0, { x: 1.53, y: 0.4 })!;
    expect(pickHeldObject([candidate], [anchor])).toBeNull();
    expect(pickHeldObject([candidate], [anchor], [anchor], prev)).toBeNull();
    expect(pickHeldObject([candidate], [anchor], [anchor], prev, anchor)?.box).toEqual(candidate.box);
    const tooFar = { x: 0.99, y: 0.4 }; // 0.47 exceeds the expanded 0.46 reach.
    expect(pickHeldObject([candidate], [tooFar], [tooFar], prev, anchor)).toBeNull();
  });

  it("uses nearby centers for continuity even when the boxes do not overlap", () => {
    const candidate = cand("bottle", box(0.3, 0.5, 0.05, 0.1));
    const prev = updateTrack(null, cand("bottle", box(0.15, 0.5, 0.05, 0.1)), 0, hand[0])!;
    const anchor = { x: 0.5, y: 0.6 };
    expect(iou(prev.box, candidate.box)).toBe(0);
    expect(pickHeldObject([candidate], [anchor])).toBeNull();
    expect(pickHeldObject([candidate], [anchor], [anchor], prev, anchor)?.label).toBe("bottle");
    const distant = { ...prev, box: box(0.05, 0.5, 0.05, 0.1) };
    expect(pickHeldObject([candidate], [anchor], [anchor], distant, anchor)).toBeNull();
  });

  it("adds exactly 0.22 continuity priority over a higher-confidence competitor", () => {
    const tracked = cand("cup", box(0.1, 0.4), 0.4);
    const competitor = cand("bottle", box(0.7, 0.4), 0.61);
    const hands = [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }];
    const prev = updateTrack(null, cand("cup", box(0, 0.4), 0.4), 0, { x: 0.1, y: 0.5 })!;
    expect(pickHeldObject([tracked, competitor], hands)?.label).toBe("bottle");
    expect(pickHeldObject([competitor, tracked], hands, hands, prev, hands[0])?.label).toBe("cup");
    expect(pickHeldObject([tracked, { ...competitor, score: 0.63 }], hands, hands, prev, hands[0])?.label).toBe("bottle");
  });

  it("does not relax direct grip contact or person/area filters for continuity", () => {
    const candidate = cand("car", box(0.3, 0.4, 0.4, 0.3));
    const anchor = { x: 0.9, y: 0.55 };
    const prev = updateTrack(null, candidate, 0, anchor)!;
    expect(pickHeldObject([candidate], [anchor], [anchor], prev, anchor)).toBeNull();
    expect(pickHeldObject([candidate], [{ x: 0.5, y: 0.5 }], [], prev, anchor)).toBeNull();
    for (const rejected of [cand("person"), cand("chair", box(0, 0, 1, 0.93)), cand("car", box(0, 0, 1, 0.86))]) {
      const track = updateTrack(null, rejected, 0, hand[0])!;
      expect(pickHeldObject([rejected], hand, hand, track, hand[0])).toBeNull();
    }
  });

  it.each(["refrigerator", "car"])("accepts %s on direct hand contact", (label) => {
    expect(pickHeldObject([cand(label)], hand)?.label).toBe("load");
  });

  it("rejects an unmapped class within reach but not in direct contact", () => {
    const candidate = cand("car", box(0.3, 0.4, 0.4, 0.3));
    expect(pickHeldObject([candidate], [{ x: 0.9, y: 0.55 }])).toBeNull();
  });

  it.each([
    { shape: "large tall", bounds: box(0.3, 0.3, 0.3, 0.5), label: "chair" },
    { shape: "large wide at the area threshold", bounds: box(0.2, 0.5, 0.6, 0.2), label: "box" },
    { shape: "narrow at the height threshold", bounds: box(0.45, 0.45, 0.1, 0.28), label: "chair" },
    { shape: "large square", bounds: box(0.3, 0.4, 0.4, 0.4), label: "chair" },
    { shape: "small", bounds: box(0.4, 0.5), label: "load" },
    { shape: "below both thresholds", bounds: box(0.3, 0.4, 0.44, 0.27), label: "load" },
  ])("maps a $shape contact fallback to $label", ({ bounds, label }) => {
    expect(pickHeldObject([cand("refrigerator", bounds)], hand)?.label).toBe(label);
  });

  it("rejects contact fallbacks covering more than 85% of the frame", () => {
    expect(pickHeldObject([cand("refrigerator", box(0, 0, 1, 0.851))], hand)).toBeNull();
    expect(pickHeldObject([cand("refrigerator", box(0, 0, 1, 0.85))], hand)?.label).toBe("box");
  });

  it("requires contact within 0.14 even when an unmapped object has more reach", () => {
    const candidate = cand("refrigerator", box(0.1, 0.2, 0.5, 0.4));
    expect(pickHeldObject([candidate], [{ x: 0.739, y: 0.4 }])?.label).toBe("box");
    expect(pickHeldObject([candidate], [{ x: 0.741, y: 0.4 }])).toBeNull();
  });

  it("requires a grip point, not just an elbow, in contact with an unmapped class", () => {
    const tie = cand("tie", box(0.4, 0.2, 0.2, 0.3), 0.04);
    const elbows = [{ x: 0.45, y: 0.3 }, { x: 0.55, y: 0.3 }];
    const wrists = [{ x: 0.15, y: 0.7 }, { x: 0.85, y: 0.7 }];
    expect(pickHeldObject([tie], [...elbows, ...wrists], wrists)).toBeNull();
    expect(pickHeldObject([tie], elbows, [])).toBeNull();
    // A recognised class may still be reached by an elbow.
    expect(pickHeldObject([cand("chair", tie.box)], [...elbows, ...wrists], wrists)?.label).toBe("chair");
  });

  it("still limits contact fallbacks to the reach of a tiny box", () => {
    const candidate = cand("car", box(0.55, 0.5, 0.05, 0.1));
    expect(pickHeldObject([candidate], [{ x: 0.68, y: 0.55 }])?.label).toBe("load");
    expect(pickHeldObject([candidate], [{ x: 0.69, y: 0.55 }])).toBeNull();
  });

  it("returns nothing with no candidates or no hand points", () => {
    expect(pickHeldObject([], hand)).toBeNull();
    expect(pickHeldObject([cand("chair")], [])).toBeNull();
  });

  it("caps hand reach at 0.38 of the frame for big objects", () => {
    // 0.5-wide box: 0.85 × 0.5 = 0.425, so the 0.38 cap decides. Right edge at 0.6.
    const big = cand("chair", box(0.1, 0.2, 0.5, 0.4));
    expect(pickHeldObject([big], [{ x: 0.97, y: 0.4 }])?.label).toBe("chair");
    expect(pickHeldObject([big], [{ x: 0.99, y: 0.4 }])).toBeNull();
  });

  it("limits reach to 0.85 × the longest side for small objects", () => {
    // 0.1-tall box: reach 0.085 (below the 0.38 cap). Right edge at 0.6.
    const phone = cand("cell phone", box(0.55, 0.5, 0.05, 0.1));
    expect(pickHeldObject([phone], [{ x: 0.68, y: 0.55 }])?.label).toBe("phone");
    expect(pickHeldObject([phone], [{ x: 0.69, y: 0.55 }])).toBeNull();
  });

  it("rejects objects covering more than 92% of the frame", () => {
    expect(pickHeldObject([cand("chair", box(0, 0, 1, 0.921))], hand)).toBeNull();
    expect(pickHeldObject([cand("chair", box(0, 0, 1, 0.919))], hand)?.label).toBe("chair");
  });

  it("gives mapped chairs a 0.18 bonus over nearby clutter", () => {
    const chair = cand("couch", box(0.4, 0.5), 0.4);
    expect(pickHeldObject([cand("cup", box(0.4, 0.5), 0.57), chair], hand)?.label).toBe("chair");
    expect(pickHeldObject([chair, cand("cup", box(0.4, 0.5), 0.59)], hand)?.label).toBe("cup");
  });

  it("gives the chair bonus only to recognised chairs regardless of candidate order", () => {
    const chair = cand("chair", box(0.3, 0.3, 0.3, 0.5));
    const fallback = cand("refrigerator", box(0.3, 0.3, 0.3, 0.5));
    expect(pickHeldObject([fallback], hand)?.label).toBe("chair");
    expect(pickHeldObject([fallback, chair], hand)?.box).toBe(chair.box);
    expect(pickHeldObject([chair, fallback], hand)?.box).toBe(chair.box);
    expect(pickHeldObject([fallback, cand("cup", { ...fallback.box }, 0.51)], hand)?.label).toBe("cup");
  });

  it("prefers two grip points over a higher-confidence object with one within 0.20", () => {
    const supported = cand("cup", box(0.1, 0.4), 0.4);
    const confident = cand("bottle", box(0.7, 0.4), 0.57);
    const hands = [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }];
    const candidates = [confident, supported];
    expect(pickHeldObject(candidates, hands, [...hands, { x: 0.499, y: 0.5 }])?.label).toBe("cup");
    expect(pickHeldObject(candidates, hands, [...hands, { x: 0.501, y: 0.5 }])?.label).toBe("bottle");
  });

  it("counts hand contact only within 0.15", () => {
    const touched = cand("cup", box(0.1, 0.4), 0.4);
    const confident = cand("bottle", box(0.7, 0.4), 0.45);
    const hands = [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }];
    const candidates = [confident, touched];
    expect(pickHeldObject(candidates, [...hands, { x: 0.449, y: 0.5 }], [])?.label).toBe("cup");
    expect(pickHeldObject(candidates, [...hands, { x: 0.451, y: 0.5 }], [])?.label).toBe("bottle");
  });

  it("adds 0.10 per contact point and caps the bonus at four points", () => {
    const touched = cand("cup", box(0.1, 0.4), 0.4);
    const confident = cand("bottle", box(0.7, 0.4), 0.65);
    const contacts = Array.from({ length: 5 }, () => ({ x: 0.2, y: 0.5 }));
    const hands = (count: number) => [...contacts.slice(0, count), { x: 0.8, y: 0.5 }];
    expect(pickHeldObject([confident, touched], hands(3), [])?.label).toBe("bottle");
    expect(pickHeldObject([confident, touched], hands(4), [])?.label).toBe("cup");
    const stronger = { ...confident, score: 0.75 };
    expect(pickHeldObject([stronger, touched], hands(4), [])?.label).toBe("bottle");
    expect(pickHeldObject([stronger, touched], hands(5), [])?.label).toBe("bottle");
  });

  it.each(["chair", "couch", "suitcase", "potted plant"])("extends %s up to the highest grip point without changing the candidate", (label) => {
    const candidate = cand(label, box(0.3, 0.5, 0.4, 0.3));
    const wrists = [{ x: 0.35, y: 0.25 }, { x: 0.65, y: 0.3 }];
    const picked = pickHeldObject([candidate], wrists, wrists)!;
    expect(picked.box.y).toBeCloseTo(0.21);
    expect(picked.box.h).toBeCloseTo(0.59);
    expect(picked.box.x).toBe(candidate.box.x);
    expect(picked.box.w).toBe(candidate.box.w);
    expect(candidate.box).toEqual(box(0.3, 0.5, 0.4, 0.3));
  });

  it("clamps the extended box top at zero and defaults grip points to hands", () => {
    const candidate = cand("chair", box(0.3, 0.2, 0.4, 0.3));
    const picked = pickHeldObject([candidate], [{ x: 0.5, y: 0.02 }])!;
    expect(picked.box.y).toBe(0);
    expect(picked.box.h).toBeCloseTo(0.5);
  });

  it("sets raised only when extending a chair", () => {
    const candidate = cand("chair", box(0.3, 0.5, 0.4, 0.3));
    const extended = pickHeldObject([candidate], [{ x: 0.5, y: 0.3 }])!;
    expect(extended.raised).toBeCloseTo(0.8);
    expect(pickHeldObject([candidate], [{ x: 0.5, y: 0.58 }])!.raised).toBeUndefined();
    expect(candidate.raised).toBeUndefined();
  });

  it("uses elbows for reach without extending the box", () => {
    const candidate = cand("chair", box(0.3, 0.5, 0.4, 0.3));
    const elbow = { x: 0.5, y: 0.25 };
    const wrists = [{ x: 0.05, y: 0.05 }];
    expect(pickHeldObject([candidate], wrists, wrists)).toBeNull();
    expect(pickHeldObject([candidate], [...wrists, elbow], wrists)?.box).toEqual(candidate.box);
    expect(pickHeldObject([candidate], [elbow], [])?.box).toEqual(candidate.box);
  });

  it("does not extend a phone toward grip points above it", () => {
    const candidate = cand("cell phone", box(0.4, 0.5));
    expect(pickHeldObject([candidate], [{ x: 0.5, y: 0.4 }])?.box).toEqual(candidate.box);
  });

  it("does not extend toward grip points outside the backrest bounds", () => {
    const candidate = cand("chair", box(0.3, 0.5, 0.4, 0.3));
    const outside = [{ x: 0.14, y: 0.4 }, { x: 0.86, y: 0.4 }, { x: 0.5, y: 0.13 }, { x: 0.5, y: 0.5 }];
    expect(pickHeldObject([candidate], hand, outside)?.box).toEqual(candidate.box);
  });

  it.each([{ x: 0.16, y: 0.4 }, { x: 0.84, y: 0.4 }, { x: 0.5, y: 0.15 }])("extends toward a grip point in the wider backrest window: %o", (grip) => {
    const candidate = cand("chair", box(0.3, 0.5, 0.4, 0.3));
    const picked = pickHeldObject([candidate], hand, [grip])!;
    expect(picked.box.y).toBeCloseTo(grip.y - 0.04);
    expect(picked.box.h).toBeCloseTo(0.8 - (grip.y - 0.04));
  });

  it.each([
    { label: "chair", bounds: box(0.4, 0.5, 0.2, 0.3) },
    { label: "box", bounds: box(0.2, 0.5, 0.6, 0.2) },
    { label: "load", bounds: box(0.4, 0.5) },
  ])("extends a fallback $label toward the backrest grip", ({ label, bounds }) => {
    const picked = pickHeldObject([cand("refrigerator", bounds)], hand, [{ x: 0.5, y: 0.4 }])!;
    expect(picked.label).toBe(label);
    expect(picked.box.y).toBeCloseTo(0.36);
    expect(picked.raised).toBeCloseTo(0.14 / bounds.h);
  });

  it("prefers the object the hand is in the middle of", () => {
    // Hand inside both boxes (nearest = 0); the cup is centred on it, the bowl is 0.042 off-centre.
    const centred = cand("cup", box(0.45, 0.55, 0.1, 0.1), 0.4);
    const offCentre = cand("bowl", box(0.48, 0.58, 0.1, 0.1), 0.42); // 0.42 − 0.5 × 0.042 < 0.4
    expect(pickHeldObject([offCentre, centred], hand)?.label).toBe("cup");
  });

  it("prefers the object the hand touches over one it only reaches toward", () => {
    const touched = cand("backpack", box(0.4, 0.5), 0.3);
    const near = cand("suitcase", box(0.62, 0.5), 0.5); // 0.12 from the hand: −0.24
    expect(pickHeldObject([near, touched], hand)?.label).toBe("backpack");
  });
});

describe("isCarryingLoad", () => {
  const pose = (): Wrist[] => Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 }));
  const point = (x: number, y: number, visibility = 0.9): Wrist => ({ x, y, visibility });
  const together = () => {
    const p = pose();
    p[LM.L_WRIST] = point(0.4, 0.55);
    p[LM.R_WRIST] = point(0.6, 0.55);
    p[LM.L_HIP] = point(0.4, 0.65);
    p[LM.R_HIP] = point(0.6, 0.75);
    return p;
  };

  it.each([
    [LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST],
    [LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST],
  ])("accepts one flexed arm using shoulder %s, elbow %s and wrist %s", (s, e, w) => {
    const p = pose();
    p[s] = point(0.4, 0.3, 0.35);
    p[e] = point(0.4, 0.5, 0.35);
    p[w] = point(0.6, 0.5, 0.35);
    expect(isCarryingLoad(p)).toBe(true);
    for (const index of [s, e, w]) {
      expect(isCarryingLoad(p.map((v, i) => i === index ? { ...v, visibility: 0.34 } : v))).toBe(false);
    }
    p[w].y = 0.85;
    expect(isCarryingLoad(p)).toBe(false);
    p[w].y = 0.9;
    expect(isCarryingLoad(p)).toBe(false);
  });

  it("accepts two hands together above the hip midpoint with at least one visible hip", () => {
    const p = together();
    expect(isCarryingLoad(p)).toBe(true);
    p[LM.L_WRIST].y = 0.68; // Below one hip, but above their midpoint at 0.7.
    p[LM.R_WRIST].y = 0.68;
    expect(isCarryingLoad(p)).toBe(true);
    p[LM.L_HIP].visibility = 0;
    expect(isCarryingLoad(p)).toBe(true);
    p[LM.R_HIP].visibility = 0;
    expect(isCarryingLoad(p)).toBe(false);
  });

  it.each(["front", "side"])("rejects straight hanging arms below the hips in the %s view", (view) => {
    const p = pose();
    const leftX = view === "front" ? 0.2 : 0.5;
    const rightX = view === "front" ? 0.8 : 0.5;
    for (const [s, e, w, x] of [
      [LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST, leftX],
      [LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST, rightX],
    ]) {
      p[s] = point(x, 0.3);
      p[e] = point(x, 0.5);
      p[w] = point(x, 0.7);
    }
    p[LM.L_HIP] = point(0.4, 0.6);
    p[LM.R_HIP] = point(0.6, 0.6);
    expect(isCarryingLoad(p)).toBe(false);
  });

  it("requires both wrists above the hips, above 0.85 and within 0.48", () => {
    for (const y of [0.7, 0.85, 0.9]) {
      const p = together();
      if (y >= 0.85) p[LM.L_HIP].y = p[LM.R_HIP].y = 0.95;
      p[LM.L_WRIST].y = y;
      expect(isCarryingLoad(p)).toBe(false);
    }
    const p = together();
    p[LM.L_WRIST].x = 0;
    p[LM.R_WRIST].x = 0.48;
    expect(isCarryingLoad(p)).toBe(false);
    p[LM.R_WRIST].x = 0.479;
    expect(isCarryingLoad(p, 2)).toBe(true); // This distance remains in normalized coordinates.
  });

  it("rejects hidden wrists and missing or low-visibility poses", () => {
    for (const index of [LM.L_WRIST, LM.R_WRIST]) {
      const p = together();
      p[index].visibility = 0.34;
      expect(isCarryingLoad(p)).toBe(false);
      p[index].visibility = undefined;
      expect(isCarryingLoad(p)).toBe(false);
    }
    expect(isCarryingLoad(together().map((p) => ({ ...p, visibility: 0.1 })))).toBe(false);
    expect(isCarryingLoad([])).toBe(false);
  });

  it("computes the elbow angle in pixel proportions", () => {
    const p = pose();
    p[LM.L_SHOULDER] = point(0.5, 0.2);
    p[LM.L_ELBOW] = point(0.5, 0.4);
    p[LM.L_WRIST] = point(0.58, 0.6);
    expect(isCarryingLoad(p)).toBe(false); // About 158 degrees.
    expect(isCarryingLoad(p, 2)).toBe(true); // About 141 degrees.
  });

  it("skips either zero-length elbow vector", () => {
    const p = pose();
    p[LM.L_ELBOW] = point(0.4, 0.4);
    p[LM.L_SHOULDER] = point(0.4, 0.4);
    p[LM.L_WRIST] = point(0.6, 0.4);
    expect(isCarryingLoad(p)).toBe(false);
    p[LM.L_SHOULDER] = point(0.4, 0.2);
    p[LM.L_WRIST] = point(0.4, 0.4);
    expect(isCarryingLoad(p)).toBe(false);
  });
});

describe("assessGrip", () => {
  const load = box(0.3, 0.2, 0.4, 0.5);
  const left = { x: 0.3, y: 0.5, visibility: 0.9 };
  const right = { x: 0.7, y: 0.55, visibility: 0.9 };

  it("flags a chair backrest grip before an uneven grip", () => {
    expect(assessGrip(load, "chair", { ...left, y: 0.25 })).toEqual({
      status: "wrong_top",
      badge: "chair · WRONG GRIP (backrest)",
      message: "Improper chair grip: hands are holding the upper backrest — grip both sides of the seat base to control the center of gravity",
    });
  });

  it("uses top-edge wording for a box held at the top", () => {
    expect(assessGrip(load, "box", { ...left, y: 0.25 }, { ...right, y: 0.3 })).toEqual({
      status: "wrong_top",
      badge: "box · WRONG GRIP (top edge)",
      message: "Improper box grip: hands are holding the top edge — support the lower sides/base near the center of gravity",
    });
  });

  it.each(["chair", "box", "backpack", "load", "container"])("flags a one-handed bulky %s carry", (label) => {
    expect(assessGrip(load, label, left)).toEqual({
      status: "wrong_uneven",
      badge: `${label} · UNEVEN GRIP`,
      message: `Unbalanced grip on ${label}: use both hands evenly on opposite sides of the load`,
    });
  });

  it("flags tilted visible wrists even when both are on the load", () => {
    expect(assessGrip(load, "chair", { ...left, y: 0.4 }, { ...right, y: 0.65 }).status).toBe("wrong_uneven");
  });

  it("accepts both hands in the lower-middle with no coaching message", () => {
    expect(assessGrip(load, "chair", left, right)).toEqual({
      status: "proper", badge: "chair · PROPER GRIP ✓", message: null,
    });
  });

  it("counts the hidden far wrist on the load without inferring tilt in a side-on lift", () => {
    expect(assessGrip(load, "chair", left, { ...right, y: 0.25, visibility: 0.1 }).status).toBe("proper");
  });

  it("accepts a small non-bulky item held one-handed in the middle", () => {
    expect(assessGrip(box(0.4, 0.5, 0.1, 0.1), "phone", { x: 0.45, y: 0.55, visibility: 0.9 })).toEqual({
      status: "proper", badge: "phone · PROPER GRIP ✓", message: null,
    });
  });

  it("falls back to the more-visible wrist when neither is close to the box", () => {
    const high = { x: 0, y: 0.1, visibility: 0.9 };
    const low = { x: 1, y: 0.6, visibility: 0.5 };
    expect(assessGrip(load, "chair", high, low).status).toBe("wrong_top");
    expect(assessGrip(load, "chair", low, high).status).toBe("wrong_top");
  });

  it("requires visibility above 0.25 for top-grip assessment", () => {
    expect(assessGrip(load, "chair", { ...left, y: 0.25, visibility: 0.25 }, { ...right, visibility: undefined }).status).toBe("proper");
    expect(assessGrip(load, "chair", { ...left, y: 0.25, visibility: 0.26 }, { ...right, visibility: undefined }).status).toBe("wrong_top");
    expect(assessGrip(load, "chair", undefined, { ...right, y: 0.25, visibility: 0.26 }).status).toBe("wrong_top");
  });

  it("counts only wrists within 0.20 of the load for two-handed support", () => {
    expect(assessGrip(load, "chair", left, { ...right, x: 0.89 }).status).toBe("proper");
    expect(assessGrip(load, "chair", left, { ...right, x: 0.91 }).status).toBe("wrong_uneven");
  });

  it("handles missing wrists without treating an empty grip as a top grip", () => {
    expect(assessGrip(load, "chair").status).toBe("wrong_uneven");
    expect(assessGrip(box(0.4, 0.5, 0.1, 0.1), "phone").status).toBe("proper");
  });

  // Six fingertips (index, pinky, thumb per hand) at height y, on the left and right sides of the load.
  const fingersAt = (y: number, visibility = 0.9) =>
    [0.3, 0.7, 0.32, 0.68, 0.31, 0.69].map((x) => ({ x, y, visibility }));
  const midWrists = [{ ...left, y: 0.42 }, { ...right, y: 0.42 }] as const;

  it("flags fingertips hooked over a backrest even when the wrists sit lower", () => {
    expect(assessGrip(load, "chair", ...midWrists).status).toBe("proper");
    // Fingers 60% (top edge) + wrists 40% (mid-height) average out above the 38% line.
    expect(assessGrip(load, "chair", ...midWrists, fingersAt(0.21))).toEqual({
      status: "wrong_top",
      badge: "chair · WRONG GRIP (backrest)",
      message: "Improper chair grip: hands are holding the upper backrest — grip both sides of the seat base to control the center of gravity",
    });
  });

  it("grades fingertips alone when no wrist is seen", () => {
    expect(assessGrip(load, "chair", undefined, undefined, fingersAt(0.21)).status).toBe("wrong_top");
  });

  it("accepts level wrists and fingers at the seat base as a proper grip", () => {
    const base = [{ ...left, y: 0.5 }, { ...right, y: 0.5 }] as const;
    expect(assessGrip(load, "chair", ...base, fingersAt(0.54))).toEqual({
      status: "proper",
      badge: "chair · PROPER GRIP ✓",
      message: null,
    });
  });

  it("ignores fingertips that are barely visible or away from the load", () => {
    expect(assessGrip(load, "chair", ...midWrists, fingersAt(0.21, 0.1)).status).toBe("proper");
    const far = [{ x: 0.0, y: 0.21, visibility: 0.9 }, { x: 0.99, y: 0.21, visibility: 0.9 }];
    expect(assessGrip(load, "chair", ...midWrists, far).status).toBe("proper");
  });
});

describe("updateTrack", () => {
  const start = () => updateTrack(null, cand("chair", box(0.4, 0.5)), 0, { x: 0.5, y: 0.6 })!;

  it.each([0, 1])("keeps up with 0.07 steps when chair detections lag by %s frames", (lag) => {
    const initialX = 0.1 - lag * 0.07;
    let t = updateTrack(null, cand("chair", box(initialX, 0.3, 0.35, 0.45)), 0, { x: 0.3, y: 0.5 })!;
    for (let frame = 1; frame <= 7; frame++) {
      const detection = cand("chair", box(initialX + frame * 0.07, 0.3, 0.35, 0.45));
      const hand = { x: 0.3 + frame * 0.07, y: 0.5 };
      const shifted = { ...t.box, x: t.box.x + 0.07 };
      const directIou = iou(t.box, detection.box);
      expect(directIou).toBeGreaterThanOrEqual(0.25);
      expect(iou(shifted, detection.box)).toBeGreaterThan(directIou);
      const prevX = t.box.x;
      t = updateTrack(t, detection, frame * 33, hand)!;
      expect(t.box.x - prevX).toBeCloseTo(0.07, 10);
      expect(t.box.x).toBeCloseTo(detection.box.x, 10);
      expect(0.1 + frame * 0.07 - t.box.x).toBeCloseTo(lag * 0.07, 10);
    }
  });

  it("keeps up with a walking chair when detections arrive every second frame", () => {
    let t = updateTrack(null, cand("chair", box(0.1, 0.3, 0.35, 0.45)), 0, { x: 0.3, y: 0.5 })!;
    for (let frame = 1; frame <= 7; frame++) {
      const x = 0.1 + frame * 0.07;
      t = updateTrack(t, frame % 2 === 0 ? cand("chair", box(x, 0.3, 0.35, 0.45)) : null,
        frame * 33, { x: 0.3 + frame * 0.07, y: 0.5 })!;
      expect(t.box.x).toBeCloseTo(x, 10);
    }
  });

  it("keeps up with a walking chair's remembered backrest through weak seat-only detections", () => {
    const initial = { ...cand("chair", box(0.1, 0.2, 0.35, 0.45)), raised: 0.8 };
    let t = updateTrack(null, initial, 0, { x: 0.3, y: 0.4 })!;
    for (let frame = 1; frame <= 7; frame++) {
      const x = 0.1 + frame * 0.07;
      const detection = cand("box", box(x, 0.4, 0.35, 0.25), 0.2);
      const shifted = { ...t.box, x: t.box.x + 0.07 };
      expect(iou(t.box, detection.box)).toBeGreaterThanOrEqual(0.25);
      expect(iou(shifted, detection.box)).toBeGreaterThan(iou(t.box, detection.box));
      t = updateTrack(t, detection, frame * 33, { x: 0.3 + frame * 0.07, y: 0.4 })!;
      expect(t.box.x).toBeCloseTo(x, 10);
      expect(t.box.y).toBeCloseTo(0.2);
      expect(t.box.h).toBeCloseTo(0.45);
      expect(t.label).toBe("chair");
      expect(t.raised).toBeCloseTo(0.8);
    }
  });

  it("uses the shifted base when direct overlap is better by less than 0.08", () => {
    const prev = updateTrack(null, cand("chair", box(0.1, 0.3, 0.35, 0.45)), 0, { x: 0.3, y: 0.5 })!;
    const detection = cand("chair", box(0.13, 0.3, 0.35, 0.45));
    const shifted = box(0.17, 0.3, 0.35, 0.45);
    const advantage = iou(prev.box, detection.box) - iou(shifted, detection.box);
    expect(advantage).toBeGreaterThan(0);
    expect(advantage).toBeLessThan(0.08);
    expect(updateTrack(prev, detection, 33, { x: 0.37, y: 0.5 })!.box.x).toBeCloseTo(0.17 + (0.13 - 0.17) * 0.72);
  });

  it("follows the hands through 6000 ms of misses during a carry and expires after 8000 ms", () => {
    expect(HOLD_CARRY_MS).toBe(8000);
    let t = start();
    for (let frame = 1; frame <= 60; frame++) {
      const hand = { x: 0.5 + frame * 0.004, y: 0.6 - frame * 0.002 };
      t = updateTrack(t, null, frame * 100, hand, true)!;
      expect(t).not.toBeNull();
      expect(t.box.x).toBeCloseTo(0.4 + frame * 0.004);
      expect(t.box.y).toBeCloseTo(0.5 - frame * 0.002);
      expect(t.lastSeen).toBe(0);
    }
    expect(updateTrack(t, null, HOLD_CARRY_MS, t.hand, true)).not.toBeNull();
    expect(updateTrack(t, null, HOLD_CARRY_MS + 1, t.hand, true)).toBeNull();
    expect(updateTrack(t, null, 6000, t.hand, false)).toBeNull();
  });

  it("uses the normal hold limit while carrying without an anchor", () => {
    const t = start();
    expect(updateTrack(t, null, HOLD_MS, undefined, true)).not.toBeNull();
    expect(updateTrack(t, null, HOLD_MS + 1, undefined, true)).toBeNull();
  });

  it("decays missed scores gently during a carry with a floor that never raises confidence", () => {
    let t = start();
    expect(updateTrack(t, null, 1, t.hand, true)!.score).toBeCloseTo(0.5 * 0.985);
    expect(updateTrack(t, null, 1, t.hand)!.score).toBeCloseTo(0.5 * 0.92);
    expect(updateTrack(t, null, 1, undefined, true)!.score).toBeCloseTo(0.5 * 0.92);
    for (let frame = 1; frame <= 200; frame++) t = updateTrack(t, null, frame * 33, t.hand, true)!;
    expect(t.score).toBe(0.15);
    expect(updateTrack({ ...t, score: 0.1 }, null, 7000, t.hand, true)!.score).toBe(0.1);
  });

  it("coasts with damped velocity without an anchor and re-baselines on its return", () => {
    let t = start();
    expect(t.vx).toBe(0);
    expect(t.vy).toBe(0);
    t = updateTrack(t, cand("chair", box(0.46, 0.46)), 33, { x: 0.56, y: 0.56 })!;
    expect(t.vx).toBeCloseTo(0.03);
    expect(t.vy).toBeCloseTo(-0.02);
    t = updateTrack(t, null, 66, { x: 0.62, y: 0.52 })!;
    expect(t.vx).toBeCloseTo(0.045);
    expect(t.vy).toBeCloseTo(-0.03);
    for (let frame = 3; frame <= 4; frame++) {
      const prev = t;
      t = updateTrack(t, null, frame * 33)!;
      expect(t.box.x).toBeCloseTo(prev.box.x + prev.vx! * 0.85);
      expect(t.box.y).toBeCloseTo(prev.box.y + prev.vy! * 0.85);
      expect(t.vx).toBeCloseTo(prev.vx! * 0.85);
      expect(t.vy).toBeCloseTo(prev.vy! * 0.85);
      expect(t.hand).toBeUndefined();
    }
    const coasted = t;
    t = updateTrack(t, null, 165, { x: 0.2, y: 0.2 })!;
    expect(t.box).toEqual(coasted.box);
    expect(t.vx).toBeCloseTo(coasted.vx! * 0.85);
    expect(t.vy).toBeCloseTo(coasted.vy! * 0.85);
    t = updateTrack(t, null, 198, { x: 0.22, y: 0.21 })!;
    expect(t.box.x).toBeCloseTo(coasted.box.x + 0.02);
    expect(t.box.y).toBeCloseTo(coasted.box.y + 0.01);
    expect(updateTrack(t, cand("chair", t.box), 231)!.vx).toBe(0);
    expect(updateTrack(t, cand("chair", t.box), 231)!.vy).toBe(0);
  });

  it("resets velocity when replacing a track or detecting after a missing anchor", () => {
    const prev = { ...start(), vx: 0.04, vy: -0.02 };
    const replaced = updateTrack(prev, cand("cup", box(0, 0, 0.1, 0.1)), 33, prev.hand)!;
    expect(replaced.vx).toBe(0);
    expect(replaced.vy).toBe(0);
    const detected = updateTrack({ ...prev, hand: undefined }, cand("chair", prev.box), 33, { x: 0.8, y: 0.8 })!;
    expect(detected.vx).toBe(0);
    expect(detected.vy).toBe(0);
  });

  it("blends previous velocity with hand displacement on successive detection frames", () => {
    let t = start();
    t = updateTrack(t, cand("chair", box(0.44, 0.48)), 33, { x: 0.54, y: 0.58 })!;
    t = updateTrack(t, cand("chair", box(0.50, 0.44)), 66, { x: 0.60, y: 0.54 })!;
    expect(t.vx).toBeCloseTo(0.5 * 0.02 + 0.5 * 0.06);
    expect(t.vy).toBeCloseTo(0.5 * -0.01 + 0.5 * -0.04);
  });

  it("coasts vertically when only vy is present", () => {
    const prev = { ...start(), vx: undefined, vy: -0.04 };
    const t = updateTrack(prev, null, 33)!;
    expect(t.box.x).toBe(prev.box.x);
    expect(t.box.y).toBeCloseTo(prev.box.y - 0.04 * 0.85);
    expect(t.vx).toBe(0);
    expect(t.vy).toBeCloseTo(-0.04 * 0.85);
  });

  it.each([true, false])("clamps positions at all frame edges while preserving size (anchor: %s)", (withHand) => {
    const prev = start();
    const high = withHand
      ? updateTrack(prev, null, 33, { x: 1.5, y: 1.6 })!
      : updateTrack({ ...prev, vx: 1, vy: 1 }, null, 33)!;
    expect(high.box).toEqual(box(0.8, 0.8));
    const low = withHand
      ? updateTrack(prev, null, 33, { x: -0.5, y: -0.4 })!
      : updateTrack({ ...prev, vx: -1, vy: -1 }, null, 33)!;
    expect(low.box).toEqual(box(0, 0));
    const oversized = { ...prev, box: box(0, 0, 1.2, 1.1), vx: 1, vy: 1 };
    expect(updateTrack(oversized, null, 33, withHand ? { x: 0.6, y: 0.7 } : undefined)!.box).toEqual(box(0, 0, 1.2, 1.1));
  });

  it.each(["box", "load", "item"])("keeps the chair label through a weak %s detection", (label) => {
    const detection = cand(label, box(0.4, 0.5), 0.2);
    const updated = updateTrack(start(), detection, 33)!;
    expect(updated.label).toBe("chair");
    expect(updated.score).toBe(0.2);
    expect(updated.raised).toBeUndefined();
    expect(detection.label).toBe(label);
  });

  it.each(["box", "load", "item"])("keeps the remembered backrest through a weak %s detection", (label) => {
    const extended = pickHeldObject([cand("chair", box(0.3, 0.5, 0.4, 0.3))], [{ x: 0.5, y: 0.3 }])!;
    const t = updateTrack(null, extended, 0, { x: 0.5, y: 0.3 })!;
    const updated = updateTrack(t, cand(label, box(0.3, 0.5, 0.4, 0.3), 0.2), 33, { x: 0.5, y: 0.58 })!;
    expect(updated.label).toBe("chair");
    expect(updated.raised).toBeCloseTo(0.8);
    expect(updated.box.y).toBeCloseTo(0.26);
    expect(updated.box.h).toBeCloseTo(0.54);
  });

  it.each([0.35, 0.4])("changes a chair to a box at confidence %s and clears the backrest", (score) => {
    const extended = pickHeldObject([cand("chair", box(0.3, 0.5, 0.4, 0.3))], [{ x: 0.5, y: 0.3 }])!;
    const t = updateTrack(null, extended, 0)!;
    const updated = updateTrack(t, cand("box", box(0.3, 0.5, 0.4, 0.3), score), 33)!;
    expect(updated.label).toBe("box");
    expect(updated.raised).toBeUndefined();
  });

  it("changes a chair to a weak non-generic label and clears the backrest", () => {
    const extended = pickHeldObject([cand("chair", box(0.3, 0.5, 0.4, 0.3))], [{ x: 0.5, y: 0.3 }])!;
    const t = updateTrack(null, extended, 0)!;
    const updated = updateTrack(t, cand("phone", box(0.3, 0.5, 0.4, 0.3), 0.2), 33)!;
    expect(updated.label).toBe("phone");
    expect(updated.raised).toBeUndefined();
  });

  it("does not lock a non-chair label through a weak generic detection", () => {
    const t = updateTrack(null, cand("phone"), 0)!;
    expect(updateTrack(t, cand("box", box(0.4, 0.5), 0.2), 33)?.label).toBe("box");
  });

  it("does not lock the chair label when the track expires or the object is replaced", () => {
    const t = start();
    expect(updateTrack(t, cand("box", box(0.4, 0.5), 0.2), HOLD_MS + 1)?.label).toBe("box");
    expect(updateTrack(t, cand("load", box(0.05, 0.05, 0.1, 0.1), 0.2), 33)?.label).toBe("load");
  });

  it("remembers the backrest when the hands lower from it to the seat", () => {
    const raw = cand("chair", box(0.3, 0.5, 0.4, 0.3));
    const wrists = [{ x: 0.3, y: 0.3, visibility: 0.9 }, { x: 0.7, y: 0.3, visibility: 0.9 }];
    let t = updateTrack(null, pickHeldObject([raw], wrists), 0, gripAnchor(wrists[0], wrists[1]))!;
    expect(t.box.y).toBeCloseTo(0.26);
    expect(assessGrip(t.box, t.label, wrists[0], wrists[1]).status).toBe("wrong_top");

    const lowered = wrists.map((w) => ({ ...w, y: 0.58 }));
    for (let frame = 1; frame <= 8; frame++) {
      const detection = pickHeldObject([raw], lowered)!;
      expect(detection.raised).toBeUndefined();
      t = updateTrack(t, detection, frame * 33, gripAnchor(lowered[0], lowered[1]))!;
    }
    expect(Math.abs(t.box.y - 0.26)).toBeLessThan(0.02);
    expect(t.raised).toBeCloseTo(0.8);
    expect(assessGrip(t.box, t.label, lowered[0], lowered[1]).status).toBe("proper");
    expect(raw.box).toEqual(box(0.3, 0.5, 0.4, 0.3));
  });

  it("keeps the largest backrest extension as the hands gradually lower to the seat", () => {
    const raw = cand("chair", box(0.3, 0.5, 0.4, 0.3));
    let wrists = [{ x: 0.3, y: 0.3, visibility: 0.9 }, { x: 0.7, y: 0.3, visibility: 0.9 }];
    let t = updateTrack(null, pickHeldObject([raw], wrists), 0, gripAnchor(wrists[0], wrists[1]))!;
    for (let frame = 1; frame <= 56; frame++) {
      wrists = wrists.map((w) => ({ ...w, y: (300 + frame * 5) / 1000 }));
      const detection = pickHeldObject([raw], wrists)!;
      t = updateTrack(t, detection, frame * 33, gripAnchor(wrists[0], wrists[1]))!;
      expect(t.raised).toBeCloseTo(0.8);
    }
    expect(wrists[0].y).toBe(0.58);
    expect(Math.abs(t.box.y - 0.26)).toBeLessThan(0.02);
    expect(assessGrip(t.box, t.label, wrists[0], wrists[1]).status).toBe("proper");
  });

  it("does not extend an overlapping phone with the chair's remembered backrest", () => {
    const extended = pickHeldObject([cand("chair", box(0.3, 0.5, 0.4, 0.3))], [{ x: 0.5, y: 0.3 }])!;
    let t = updateTrack(null, extended, 0)!;
    const phone = pickHeldObject([cand("cell phone", box(0.4, 0.5, 0.15, 0.15))], [{ x: 0.5, y: 0.58 }])!;
    expect(phone.label).toBe("phone");
    expect(iou(t.box, phone.box)).toBeGreaterThan(0.05);
    t = updateTrack(t, phone, 33)!;
    expect(t.raised).toBeUndefined();
    expect(t.box.y).toBeCloseTo(extended.box.y + (phone.box.y - extended.box.y) * 0.72);
    expect(t.box.h).toBeCloseTo(extended.box.h + (phone.box.h - extended.box.h) * 0.72);
    for (let frame = 2; frame <= 8; frame++) {
      t = updateTrack(t, phone, frame * 33)!;
    }
    expect(t.box.y).toBeCloseTo(0.5);
    expect(t.box.h).toBeCloseTo(0.15);
    expect(phone.box).toEqual(box(0.4, 0.5, 0.15, 0.15));
  });

  it("recovers the raw box from an extension clamped at zero", () => {
    const raw = cand("chair", box(0.3, 0.2, 0.4, 0.3));
    const clamped = pickHeldObject([raw], [{ x: 0.5, y: 0.02 }])!;
    const t = updateTrack(null, clamped, 0)!;
    const updated = updateTrack(t, clamped, 33)!;
    expect(updated.box.y).toBeCloseTo(0);
    expect(updated.box.h).toBeCloseTo(0.5);
    expect(updated.raised).toBeCloseTo(0.2 / 0.3);
    expect(clamped.box).toEqual(box(0.3, 0, 0.4, 0.5));
  });

  it("drops the remembered extension when the detector boxes the full height", () => {
    const raw = cand("chair", box(0.3, 0.5, 0.4, 0.3));
    const extended = pickHeldObject([raw], [{ x: 0.5, y: 0.3 }])!;
    let t = updateTrack(null, extended, 0)!;
    const full = cand("chair", box(0.3, 0.3, 0.4, 0.5));
    for (let frame = 1; frame <= 8; frame++) {
      const detection = pickHeldObject([full], [{ x: 0.5, y: 0.58 }])!;
      t = updateTrack(t, detection, frame * 33)!;
      expect(t.raised).toBeUndefined();
    }
    expect(t.box.y).toBeCloseTo(full.box.y);
    expect(t.box.h).toBeCloseTo(full.box.h);
  });

  it("does not inherit a backrest extension when replacing a non-overlapping object", () => {
    const extended = pickHeldObject([cand("chair", box(0.3, 0.5, 0.4, 0.3))], [{ x: 0.5, y: 0.3 }])!;
    const t = updateTrack(null, extended, 0)!;
    const replacement = cand("bag", box(0.05, 0.05, 0.1, 0.1));
    const replaced = updateTrack(t, replacement, 33)!;
    expect(replaced.raised).toBeUndefined();
    expect(replaced.box).toEqual(replacement.box);
    expect(replaced.label).toBe("bag");
  });

  it("increases the remembered extension when a fresh grip is higher", () => {
    const raw = cand("chair", box(0.3, 0.5, 0.4, 0.3));
    const extended = pickHeldObject([raw], [{ x: 0.5, y: 0.3 }])!;
    const t = updateTrack(null, extended, 0)!;
    const fresh = pickHeldObject([raw], [{ x: 0.5, y: 0.25 }])!;
    const updated = updateTrack(t, fresh, 33)!;
    expect(updated.raised).toBeCloseTo(0.29 / 0.3);
    expect(updated.raised).toBeGreaterThan(t.raised!);
    expect(updated.box.y).toBeCloseTo(0.26 + (0.21 - 0.26) * 0.72);
    expect(fresh.box.y).toBeCloseTo(0.21);
  });

  it("keeps a missed object alive for 2600 ms, then drops it", () => {
    expect(HOLD_MS).toBe(2600);
    const t = start();
    expect(updateTrack(t, null, HOLD_MS - 1, { x: 0.5, y: 0.6 })).not.toBeNull();
    expect(updateTrack(t, null, HOLD_MS, { x: 0.5, y: 0.6 })).not.toBeNull();
    expect(updateTrack(t, null, HOLD_MS + 1, { x: 0.5, y: 0.6 })).toBeNull();
  });

  it("moves the box 1:1 with the hands on missed frames", () => {
    const moved = updateTrack(start(), null, 100, { x: 0.52, y: 0.4 })!;
    expect(moved.box.x).toBeCloseTo(0.42);
    expect(moved.box.y).toBeCloseTo(0.3);
    expect(moved.label).toBe("chair");
  });

  it("anchors a stationary re-grip to the unshifted box before snapping 72% toward the detection", () => {
    const prev = start();
    const detection = cand("chair", box(0.47, 0.5));
    const hand = { x: 0.65, y: 0.75 };
    expect(iou(prev.box, detection.box)).toBeGreaterThanOrEqual(0.25);
    const t = updateTrack(prev, detection, 66, hand)!;
    expect(t.box.x).toBeCloseTo(0.4 + 0.07 * 0.72); // 0.4504
    expect(t.box.y).toBeCloseTo(0.5);
    expect(t.lastSeen).toBe(66);
    expect(t.hand).toEqual(hand);
    const missed = updateTrack(t, null, 99, { x: 0.67, y: 0.77 })!;
    expect(missed.box.x).toBeCloseTo(0.4704);
    expect(missed.box.y).toBeCloseTo(0.52);
  });

  it("uses the hand-shifted base for fast movement with little direct overlap", () => {
    const prev = start();
    const detection = cand("chair", box(0.68, 0.5));
    const hand = { x: 0.75, y: 0.6 };
    expect(iou(prev.box, detection.box)).toBeLessThan(0.25);
    expect(iou(box(0.65, 0.5), detection.box)).toBeGreaterThanOrEqual(0.05);
    const t = updateTrack(prev, detection, 66, hand)!;
    expect(t.box.x).toBeCloseTo(0.65 + 0.03 * 0.72);
    expect(t.box.y).toBeCloseTo(0.5);
    expect(t.hand).toEqual(hand);
    expect(t.lastSeen).toBe(66);
  });

  it("keeps the chair and backrest when a re-grip shifts the box completely off the detection", () => {
    const extended = pickHeldObject([cand("chair", box(0.3, 0.5, 0.4, 0.3))], [{ x: 0.5, y: 0.3 }])!;
    const prev = updateTrack(null, extended, 0, { x: 0.5, y: 0.3 })!;
    const detection = cand("box", box(0.3, 0.5, 0.4, 0.3), 0.2);
    const hand = { x: 0.95, y: 0.9 };
    const shifted = { ...prev.box, x: prev.box.x + 0.45, y: prev.box.y + 0.6 };
    expect(iou(prev.box, detection.box)).toBeGreaterThanOrEqual(0.25);
    expect(iou(shifted, detection.box)).toBe(0);
    const t = updateTrack(prev, detection, 66, hand)!;
    expect(t.label).toBe("chair");
    expect(t.raised).toBeCloseTo(0.8);
    expect(t.box.x).toBeCloseTo(prev.box.x);
    expect(t.box.y).toBeCloseTo(prev.box.y);
    expect(t.box.h).toBeCloseTo(prev.box.h);
    expect(t.hand).toEqual(hand);
    expect(t.lastSeen).toBe(66);
  });

  it("replaces the box when a detection doesn't overlap it", () => {
    const t = updateTrack(start(), cand("bag", box(0.05, 0.05, 0.1, 0.1)), 66, { x: 0.5, y: 0.6 })!;
    expect(t.box.x).toBe(0.05);
    expect(t.label).toBe("bag");
  });

  it("keeps the box still without an anchor, then re-baselines without a jump", () => {
    let t = updateTrack(start(), null, 100, undefined)!;
    expect(t.box.x).toBeCloseTo(0.4);
    t = updateTrack(t, null, 200, { x: 0.8, y: 0.6 })!; // anchor back somewhere else: new baseline
    expect(t.box.x).toBeCloseTo(0.4);
    t = updateTrack(t, null, 300, { x: 0.82, y: 0.6 })!; // then follows the hands again
    expect(t.box.x).toBeCloseTo(0.42);
  });
});

describe("gripAnchor", () => {
  const L = { x: 0.3, y: 0.6, visibility: 0.9 };
  const R = { x: 0.7, y: 0.6, visibility: 0.9 };
  const LI = { x: 0.32, y: 0.58, visibility: 0.9 };
  const RI = { x: 0.68, y: 0.58, visibility: 0.9 };

  it("sits between the hands when both are visible", () => {
    const a = gripAnchor(L, R, LI, RI);
    expect(a.x).toBeCloseTo(0.5);
    expect(a.y).toBeCloseTo(0.59);
  });

  it("slides to the visible hand when the far hand is hidden (side-on)", () => {
    const a = gripAnchor(L, { ...R, visibility: 0.1 }, LI, { ...RI, visibility: 0.1 });
    expect(Math.abs(a.x - 0.31)).toBeLessThan(0.015); // midpoint of the visible wrist and index
  });

  it("is always defined while a pose is present, even with zero visibility", () => {
    const a = gripAnchor({ ...L, visibility: 0 }, { ...R, visibility: 0 });
    expect(a.x).toBeCloseTo(0.5);
    expect(Number.isFinite(a.y)).toBe(true);
  });
});

describe("GripTracker (anchor used to move the tracked box)", () => {
  const pts = (rightVis: number, dx = 0) => [
    { x: 0.3 + dx, y: 0.6, visibility: 0.9 },
    { x: 0.7 + dx, y: 0.6, visibility: rightVis },
    { x: 0.32 + dx, y: 0.58, visibility: 0.9 },
    { x: 0.68 + dx, y: 0.58, visibility: rightVis },
  ];

  it("does not move when only visibility changes (far hand fading out as the worker turns)", () => {
    const grip = new GripTracker();
    const a0 = grip.update(pts(0.9));
    const a1 = grip.update(pts(0.1)); // same positions, far hand now barely visible
    expect(a1.x).toBeCloseTo(a0.x);
    expect(a1.y).toBeCloseTo(a0.y);
    // gripAnchor alone would have jumped ~0.19 toward the visible hand.
    expect(Math.abs(gripAnchor(...(pts(0.1) as [Wrist, Wrist, Wrist, Wrist])).x - a0.x)).toBeGreaterThan(0.15);
  });

  it("follows real hand movement, mostly from the visible hand", () => {
    const grip = new GripTracker();
    const a0 = grip.update(pts(0.1));
    const a1 = grip.update(pts(0.1, 0.05));
    expect(a1.x - a0.x).toBeCloseTo(0.05);
  });

  it("keeps a held box still through a visibility change, then moves it with the hands", () => {
    const grip = new GripTracker();
    let t = updateTrack(null, cand("chair", box(0.4, 0.5)), 0, grip.update(pts(0.9)))!;
    t = updateTrack(t, null, 33, grip.update(pts(0.1)))!; // turning: far hand hidden, detection missed
    expect(t.box.x).toBeCloseTo(0.4);
    t = updateTrack(t, null, 66, grip.update(pts(0.1, 0.03)))!;
    expect(t.box.x).toBeCloseTo(0.43);
  });
});

describe("handsBox / visibleHandsBox (fallback load box during a lift)", () => {
  it("is a pixel-square between the wrists, hanging slightly below them", () => {
    const aspect = 16 / 9;
    const b = handsBox({ x: 0.4, y: 0.5 }, { x: 0.5, y: 0.52 }, aspect);
    expect(b.x + b.w / 2).toBeCloseTo(0.45);
    expect(b.y + b.h / 2).toBeGreaterThan(0.51);
    expect(b.w * aspect).toBeCloseTo(b.h);
    expect(b.h).toBeGreaterThanOrEqual(0.22);
  });

  it("never collapses when the wrists overlap (side view)", () => {
    expect(handsBox({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 16 / 9).h).toBeCloseTo(0.22);
  });

  it("has no box when both wrists are hidden, and uses the visible wrist otherwise", () => {
    const l = { x: 0.3, y: 0.6, visibility: 0.9 };
    const r = { x: 0.7, y: 0.6, visibility: 0.9 };
    const hidden = { visibility: 0.1 };
    expect(visibleHandsBox({ ...l, ...hidden }, { ...r, ...hidden }, 16 / 9)).toBeNull();
    const b = visibleHandsBox(l, { x: 0.95, y: 0.95, visibility: 0.1 }, 16 / 9)!;
    expect(b.x + b.w / 2).toBeCloseTo(0.3);
  });
});

describe("iou", () => {
  it("is 1 for identical boxes and 0 for disjoint ones", () => {
    expect(iou(box(0, 0), box(0, 0))).toBe(1);
    expect(iou(box(0, 0), box(0.5, 0.5))).toBe(0);
  });
});
