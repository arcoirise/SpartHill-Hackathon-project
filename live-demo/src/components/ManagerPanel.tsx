import type { ZoneStats } from "../api";
import { MULTIPLIER_INFO, riskLevel, type MultiplierKey } from "../niosh/niosh";
import { RISK_COLOR, ZONES } from "../ui";

interface Props {
  zones: ZoneStats[] | null;
  error: string | null;
  k: number;
  onK: (k: number) => void;
  onRefresh: () => void;
  onReset: () => void;
}

/** What a manager sees: per-zone aggregates only, hidden until k lifts have contributed. */
export default function ManagerPanel({ zones, error, k, onK, onRefresh, onReset }: Props) {
  return (
    <section className="panel manager">
      <header className="panel-head">
        <h2>Manager view</h2>
        <span className="tag">zone aggregates only · no people, no video, no single lifts</span>
      </header>
      <div className="k-row">
        <label>
          Privacy threshold <b>k = {k}</b>
          <input type="range" min={1} max={10} value={k} onChange={(e) => onK(Number(e.target.value))} />
        </label>
        <span className="muted small">A zone stays hidden until {k} lifts have been recorded there.</span>
        <span className="k-actions">
          <button className="link" onClick={onRefresh}>
            Refresh
          </button>
          <button className="link" onClick={onReset} title="Clear all zone data on the server (demo)">
            Reset demo data
          </button>
        </span>
      </div>
      {error && <p className="warn">Manager data unavailable ({error}). Is the backend running on port 8000?</p>}
      <div className="zones">
        {ZONES.map((zone) => {
          const stats = zones?.find((z) => z.zone_id === zone.id);
          return <ZoneCard key={zone.id} name={zone.name} stats={stats} k={k} />;
        })}
      </div>
    </section>
  );
}

function joinNeeds(needs: string[]): string {
  return needs.length <= 1 ? needs.join("") : `${needs.slice(0, -1).join(", ")} and ${needs[needs.length - 1]}`;
}

/** Room hazards and the facility recommendation. Not personal data, so shown even below k. */
function Facility({ name, stats }: { name: string; stats?: ZoneStats }) {
  const hazards = stats?.environment?.hazards ?? [];
  const needs = stats?.needs ?? [];
  return (
    <>
      {hazards.length > 0 && (
        <div className="env-chips">
          {hazards.map((h) => (
            <span key={h.id} className="env-chip">
              ⚠ {h.label} · {h.reading}
            </span>
          ))}
        </div>
      )}
      {needs.length > 0 && (
        <p className="facility">
          <b>Facility recommendation:</b> {name} requires {joinNeeds(needs)}.
        </p>
      )}
    </>
  );
}

function ZoneCard({ name, stats, k }: { name: string; stats?: ZoneStats; k: number }) {
  const count = stats?.lift_count ?? 0;
  if (!stats || stats.hidden || stats.avg_li == null) {
    return (
      <div className="zone hidden-zone">
        <div className="zone-name">{name}</div>
        <div className="lock" aria-hidden>
          🔒
        </div>
        <div className="muted">
          Lift data hidden to protect worker privacy ({count} / {k} lifts recorded)
        </div>
        <Facility name={name} stats={stats} />
      </div>
    );
  }

  const risk = riskLevel(stats.avg_li);
  const rc = stats.risk_counts ?? { green: 0, yellow: 0, red: 0 };
  const total = rc.green + rc.yellow + rc.red || 1;
  const mainIssue = Object.keys(stats.dominant_counts ?? {})[0] as MultiplierKey | undefined;

  return (
    <div className="zone">
      <div className="zone-head">
        <div className="zone-name">{name}</div>
        <div className="muted small">{count} lifts</div>
      </div>
      <div className="zone-li">
        <span style={{ color: RISK_COLOR[risk] }}>avg LI {stats.avg_li.toFixed(1)}</span>
        <span className="muted">max {stats.max_li?.toFixed(1)}</span>
      </div>
      <div className="risk-bar" title={`${rc.green} green · ${rc.yellow} amber · ${rc.red} red`}>
        {(["green", "yellow", "red"] as const).map((level) =>
          rc[level] ? <span key={level} style={{ flex: rc[level] / total, background: RISK_COLOR[level] }} /> : null,
        )}
      </div>
      {mainIssue && MULTIPLIER_INFO[mainIssue] && (
        <p className="zone-issue">
          <b>Main issue:</b> {MULTIPLIER_INFO[mainIssue].problem}
        </p>
      )}
      <Facility name={name} stats={stats} />
      {stats.top_fixes && stats.top_fixes.length > 0 && (
        <ol className="fixes">
          {stats.top_fixes.map((f) => (
            <li key={f.id}>
              <div className="fix-label">{f.label}</div>
              <div className="muted small">
                {f.kind === "environment"
                  ? `Environment · flagged ${f.times_recommended}× · ${f.effort} effort`
                  : `AI-ranked for ${f.times_recommended} lift${f.times_recommended === 1 ? "" : "s"} · predicted −${Math.round(f.avg_reduction_pct ?? 0)}% risk · ${f.effort} effort`}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
