import type { Pick, Recommendation } from "../api";
import { riskLevel } from "../niosh/niosh";
import { RISK_COLOR, fmtLi } from "../ui";

export type Advice =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: Recommendation; elapsedMs: number };

const EFFORT_TEXT = { low: "Low effort", medium: "Medium effort", high: "High effort" } as const;

/** "AI proposes, code verifies": AI-written reasons, every number computed by the NIOSH code. */
export default function SuggestionCard({ advice, currentLi }: { advice?: Advice; currentLi?: number }) {
  return (
    <section className="panel suggestion">
      <header className="panel-head">
        <h2>
          <span className="spark" aria-hidden>
            ✦
          </span>{" "}
          AI workstation fix
        </h2>
        {advice?.status === "ready" && (
          <span className="tag">
            {advice.data.source === "llm" ? "AI-written · numbers verified by code" : "Built-in template"} · {advice.elapsedMs} ms
          </span>
        )}
      </header>
      {!advice && <p className="empty">After each lift, the fix with the biggest risk reduction for the effort appears here.</p>}
      {advice?.status === "loading" && (
        <div className="thinking">
          <div className="shimmer" />
          <div className="shimmer short" />
          <span className="muted">Comparing redesign options for this workstation…</span>
        </div>
      )}
      {advice?.status === "error" && (
        <p className="warn">Suggestions unavailable ({advice.message}). Is the backend running on port 8000?</p>
      )}
      {advice?.status === "ready" && (
        <>
          <p className="summary">{advice.data.summary}</p>
          {advice.data.picks.map((p) => (
            <PickRow key={p.id} pick={p} currentLi={currentLi} />
          ))}
          {advice.data.note && <p className="muted small">{advice.data.note}</p>}
        </>
      )}
    </section>
  );
}

function PickRow({ pick: p, currentLi }: { pick: Pick; currentLi?: number }) {
  if (p.kind === "environment" || p.li_after === null) {
    return (
      <div className="pick env-pick">
        <div className="pick-title">{p.label}</div>
        <div className="pick-delta">
          <span className="pill env">Environment</span>
          <span className="pill">{EFFORT_TEXT[p.effort]}</span>
        </div>
        <div className="pick-why">{p.why}</div>
      </div>
    );
  }
  const afterColor = RISK_COLOR[riskLevel(p.li_after)];
  const beforeColor = currentLi !== undefined ? RISK_COLOR[riskLevel(currentLi)] : undefined;
  return (
    <div className="pick">
      <div className="pick-title">{p.label}</div>
      <div className="pick-delta">
        {currentLi !== undefined && (
          <>
            <span style={{ color: beforeColor }}>LI {fmtLi(currentLi)}</span>
            <span className="arrow">→</span>
          </>
        )}
        <span style={{ color: afterColor }}>LI {fmtLi(p.li_after)}</span>
        {p.reduction_pct !== null && <span className="pill good">−{Math.round(p.reduction_pct)}% risk</span>}
        <span className="pill">{EFFORT_TEXT[p.effort]}</span>
      </div>
      <div className="pick-why">{p.why}</div>
    </div>
  );
}
