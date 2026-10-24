import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SolutionBar } from "../App";
import { assessGrip } from "../pose/objectTracker";

vi.mock("./CameraView", () => ({ default: () => null }));

const issue = { object_label: "chair", status: "wrong_top" as const, detail: "Upper-grip rule" };
const current = { issue, key: "top-chair" };
const advice = {
  ...current,
  advice: { source: "fallback" as const, issue: "Upper grip", summary: "Support the seat base", picks: [], latency_ms: 0 },
};
const defaults = { grip: null, posture: null, label: "chair", current: null, gripAdvice: null, liftAdvice: null, status: "idle" as const };

describe("recommendation panel states", () => {
  it("starts collapsed and explains missing observations without a recommendation", () => {
    const html = renderToStaticMarkup(<SolutionBar {...defaults} />);
    expect(html).toContain("Why this recommendation?");
    expect(html).toContain("No current recommendation to explain.");
    expect(html).not.toContain("<details open");
  });

  it("removes past advice after the current issue disappears", () => {
    const html = renderToStaticMarkup(<SolutionBar {...defaults} gripAdvice={advice} />);
    expect(html).not.toContain("Support the seat base");
    expect(html).not.toContain("Built-in template");
  });

  it("renders measured evidence with the matching recommendation", () => {
    const grip = assessGrip({ x: 0.3, y: 0.2, w: 0.4, h: 0.5 }, "chair",
      { x: 0.35, y: 0.25, visibility: 0.9 }, { x: 0.65, y: 0.25, visibility: 0.9 }, [], true);
    const html = renderToStaticMarkup(<SolutionBar {...defaults} grip={grip} current={current} gripAdvice={advice} />);
    expect(html).toContain("Support the seat base");
    expect(html).toContain("Estimated grip height: 0.10");
    expect(html).toContain("Built-in template");
  });

  it("renders the attribution line inside the explanation panel", () => {
    const html = renderToStaticMarkup(<SolutionBar {...defaults} />);
    expect(html).toContain("Recommendation explanation feature developed and tested with IBM Bob.");
  });
});
