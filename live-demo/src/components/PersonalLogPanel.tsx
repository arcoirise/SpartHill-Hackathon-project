import { useState } from "react";
import { MULTIPLIER_INFO } from "../niosh/niosh";
import type { LogEntry, Verification } from "../session/personalLog";
import { RISK_COLOR, ZONES, fmtLi } from "../ui";

interface Props {
  active: boolean;
  log: LogEntry[];
  storageOk: boolean;
  verification: Verification | null;
  onStart: () => void;
  onEnd: () => void;
  onVerify: () => void;
  onExport: () => void;
  onTamper: () => void;
  onDelete: () => void;
}

const zoneName = (id: string) => ZONES.find((z) => z.id === id)?.name ?? id;

/** The worker's own record: opt-in, stored only on this device, tamper-evident, exportable only by them. */
export default function PersonalLogPanel(p: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <section className="panel personal">
      <header className="panel-head">
        <h2>My lift record</h2>
        <span className="tag">worker-only · stored on this device, never sent</span>
      </header>

      {!p.active ? (
        <div className="session-off">
          <p>
            Lifts are anonymous by default and only feed zone averages. Start a session to also keep <b>your own</b> record of
            your exposure, for example to support a future injury claim.
          </p>
          <button className="btn primary" onClick={p.onStart}>
            Start my session
          </button>
          <p className="muted small">In a real deployment the worker scans a QR code at the station with their own phone.</p>
        </div>
      ) : (
        <div className="session-bar">
          <span className="session-live">
            <span className="pulse" /> Session active
          </span>
          <button className="link" onClick={p.onEnd}>
            End session
          </button>
        </div>
      )}

      {p.log.length > 0 && (
        <>
          <ul className="log">
            {[...p.log]
              .reverse()
              .slice(0, 6)
              .map((e) => (
                <li key={e.index}>
                  <span className="muted mono">#{e.index + 1}</span>
                  <span className="muted">{new Date(e.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  <span>{zoneName(e.zoneId)}</span>
                  <span className="chip" style={{ borderColor: RISK_COLOR[e.risk], color: RISK_COLOR[e.risk] }}>
                    LI {fmtLi(e.li)}
                  </span>
                  <span className="muted small">{e.risk === "green" ? "within limit" : MULTIPLIER_INFO[e.dominant]?.name}</span>
                  <span className="hash mono" title={`SHA-256 ${e.hash}`}>
                    {e.hash.slice(0, 8)}…
                  </span>
                </li>
              ))}
          </ul>
          <div className="log-actions">
            <button className="btn" onClick={p.onVerify}>
              Verify integrity
            </button>
            <button className="btn" onClick={p.onExport}>
              Export my record (JSON)
            </button>
            <button className="btn ghost" onClick={p.onTamper} title="Changes one stored value without re-hashing, to show that verification catches it">
              Simulate tampering
            </button>
            <button
              className="link danger-link"
              onClick={() => {
                if (confirmDelete) {
                  setConfirmDelete(false);
                  p.onDelete();
                } else {
                  setConfirmDelete(true);
                }
              }}
              onBlur={() => setConfirmDelete(false)}
            >
              {confirmDelete ? "Click again to delete" : "Delete my record"}
            </button>
          </div>
          {p.verification &&
            (p.verification.ok ? (
              <p className="verified">✓ Hash chain verified · {p.verification.count} entries, untouched since they were recorded</p>
            ) : (
              <p className="broken">
                ✗ Chain broken at entry #{p.verification.brokenAt + 1}: {p.verification.reason}
              </p>
            ))}
        </>
      )}
      {p.active && p.log.length === 0 && <p className="empty">Your lifts will appear here.</p>}
      <p className="muted small">
        Stored only on your device{p.storageOk ? "" : " (browser storage unavailable: kept in memory for this tab only)"}. Only you can export
        this.
      </p>
    </section>
  );
}
