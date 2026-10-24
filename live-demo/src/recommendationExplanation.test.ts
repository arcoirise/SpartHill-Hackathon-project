import { describe, expect, it } from "vitest";
import { assessGrip } from "./pose/objectTracker";
import { explainRecommendation, hasGripEvidence } from "./recommendationExplanation";
import type { GripIssue } from "./api";

const box = { x: 0.3, y: 0.2, w: 0.4, h: 0.5 };
const wrist = (x: number, y: number, visibility = 0.9) => ({ x, y, visibility });
const issue = (status: GripIssue["status"]): GripIssue => ({ object_label: "chair", status, detail: null });

describe("recommendation evidence", () => {
  it("explains the upper-grip threshold from the classifier's measurements", () => {
    const grip = assessGrip(box, "chair", wrist(0.35, 0.25), wrist(0.65, 0.25), [], true);
    expect(grip.status).toBe("wrong_top");
    expect(grip.evidence?.relativeGripHeight).toBeCloseTo(0.1);
    const explanation = explainRecommendation(grip, issue(grip.status), "llm");
    expect(explanation.signals.join(" ")).toContain("0.10");
    expect(explanation.signals.join(" ")).toContain("below 0.38");
    expect(explanation.source).toContain("model-generated");
    expect(explanation.limitation).toContain("cannot confirm contact");
  });

  it("explains unequal hand heights without asserting measured load imbalance", () => {
    const grip = assessGrip(box, "chair", wrist(0.35, 0.4), wrist(0.65, 0.65), [], true);
    expect(grip.status).toBe("wrong_uneven");
    const explanation = explainRecommendation(grip, issue(grip.status), "fallback");
    expect(explanation.signals.join(" ")).toContain("0.50");
    expect(explanation.signals.join(" ")).not.toContain("Only");
    expect(explanation.source).toContain("built-in template");
  });

  it("distinguishes a missing nearby wrist from unequal hand heights", () => {
    const grip = assessGrip(box, "chair", wrist(0.35, 0.6), wrist(0.98, 0.6), [], true);
    const explanation = explainRecommendation(grip, issue(grip.status));
    expect(grip.status).toBe("wrong_uneven");
    expect(explanation.signals.join(" ")).toContain("Only 1 of 2");
    expect(explanation.signals.join(" ")).not.toContain("height difference");
  });

  it("requires both visible wrists even when the old heuristic reports a grip", () => {
    const grip = assessGrip(box, "chair", wrist(0.35, 0.25), wrist(0.65, 0.25, 0.1), [], true);
    expect(grip.status).toBe("wrong_top");
    expect(hasGripEvidence(grip)).toBe(false);
    expect(explainRecommendation(grip, issue(grip.status)).summary).toContain("insufficient");
  });

  it("does not invent evidence for missing landmarks or legacy verdicts", () => {
    const grip = assessGrip(box, "chair", undefined, undefined, [], true);
    expect(grip.evidence?.relativeGripHeight).toBeNull();
    expect(hasGripEvidence(grip)).toBe(false);
    expect(hasGripEvidence({ status: "wrong_top", badge: "chair", message: null })).toBe(false);
    expect(explainRecommendation(null, null).summary).toBe("No current recommendation to explain.");
  });

  it("does not treat a passing grip rule as a safety guarantee", () => {
    const grip = assessGrip(box, "chair", wrist(0.35, 0.6), wrist(0.65, 0.6), [], true);
    expect(grip.status).toBe("proper");
    expect(explainRecommendation(grip, null).signals[0]).toContain("does not establish safety");
  });

  it("never reuses a different grip verdict to justify a recommendation", () => {
    const grip = assessGrip(box, "chair", wrist(0.35, 0.6), wrist(0.65, 0.6), [], true);
    expect(explainRecommendation(grip, issue("wrong_top")).summary).toContain("no matching");
  });

  it("explains retained posture alerts from their original code-written signal", () => {
    const posture: GripIssue = { ...issue("posture"), detail: "Low pickup point: this load starts below knee height" };
    const explanation = explainRecommendation(null, posture, "fallback");
    expect(explanation.signals[0]).toBe(posture.detail);
    expect(explanation.signals[1]).toContain("three seconds");
    expect(explanation.signals.join(" ")).not.toContain("grip height");
  });

  it("uses a stoop-specific summary when lift_posture is stoop", () => {
    const posture: GripIssue = { object_label: "box", status: "posture", detail: "Stoop lift detected", lift_posture: "stoop" };
    const explanation = explainRecommendation(null, posture, "fallback");
    expect(explanation.summary).toContain("stoop-lift rule");
    expect(explanation.summary).toContain("knees nearly straight");
  });

  it("uses a low-pickup-point summary when detail starts with Low pickup", () => {
    const posture: GripIssue = { object_label: "box", status: "posture", detail: "Low pickup point: load at floor level" };
    const explanation = explainRecommendation(null, posture, "fallback");
    expect(explanation.summary).toContain("low-pickup-point rule");
    expect(explanation.summary).toContain("below knee height");
  });

  it("uses a generic deep-bend summary for other posture triggers", () => {
    const posture: GripIssue = { object_label: "box", status: "posture", detail: "Deep forward bend (42°)" };
    const explanation = explainRecommendation(null, posture, "fallback");
    expect(explanation.summary).toContain("deep-forward-bend rule");
  });

  it("adds depth/rotation uncertainty to posture limitation text", () => {
    const posture: GripIssue = { object_label: "box", status: "posture", detail: "Deep forward bend (42°)" };
    const explanation = explainRecommendation(null, posture);
    expect(explanation.limitation).toContain("depth and rotation errors");
    expect(explanation.limitation).toContain("model-estimated 3D landmarks");
    expect(explanation.limitation).not.toContain("measured from a 2D side view");
    expect(explanation.limitation).toContain("screening signal");
  });

  it("uses the actual alert over a different concurrent lift posture", () => {
    const posture: GripIssue = { object_label: "box", status: "posture", detail: "Low pickup point: this load starts below knee height", lift_posture: "stoop" };
    expect(explainRecommendation(null, posture).summary).toContain("low-pickup-point rule");
  });

  it("does not invent a deep bend when trigger details are missing", () => {
    expect(explainRecommendation(null, issue("posture")).summary).toContain("specific trigger is unavailable");
  });
});
