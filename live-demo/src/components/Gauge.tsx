const MAX_LI = 3;
const CX = 100;
const CY = 100;

const angleOf = (li: number) => Math.PI * (1 - Math.min(Math.max(li, 0), MAX_LI) / MAX_LI);
const point = (r: number, a: number) => [CX + r * Math.cos(a), CY - r * Math.sin(a)] as const;

function arc(r: number, from: number, to: number) {
  const [x0, y0] = point(r, angleOf(from));
  const [x1, y1] = point(r, angleOf(to));
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const ZONES = [
  { from: 0, to: 0.97, color: "#34d399" },
  { from: 1.03, to: 1.97, color: "#fbbf24" },
  { from: 2.03, to: 3, color: "#f87171" },
];

/** Semicircular Lifting Index gauge: green ≤ 1, amber 1–2, red > 2 (capped at 3). */
export default function Gauge({ li, low, high }: { li?: number; low?: number; high?: number }) {
  const has = li !== undefined;
  const [nx, ny] = point(68, angleOf(has ? li : 0));
  return (
    <svg className="gauge" viewBox="-14 -14 228 124" role="img" aria-label={has ? `Lifting Index ${li.toFixed(1)}` : "No lift yet"}>
      {ZONES.map((z) => (
        <path key={z.from} d={arc(80, z.from, z.to)} stroke={z.color} strokeOpacity={has ? 0.9 : 0.25} strokeWidth="14" fill="none" strokeLinecap="butt" />
      ))}
      {has && low !== undefined && high !== undefined && (
        <path d={arc(95, low, Math.max(high, low + 0.02))} stroke="var(--text)" strokeOpacity="0.55" strokeWidth="3" fill="none" strokeLinecap="round" />
      )}
      {[0, 1, 2, 3].map((v) => {
        const [x, y] = point(102, angleOf(v));
        return (
          <text key={v} x={x} y={y + 3} className="gauge-tick" textAnchor="middle">
            {v === 3 ? "3+" : v}
          </text>
        );
      })}
      {has && (
        <>
          <line x1={CX} y1={CY} x2={nx} y2={ny} stroke="var(--text)" strokeWidth="4" strokeLinecap="round" />
          <circle cx={CX} cy={CY} r="7" fill="var(--text)" />
        </>
      )}
    </svg>
  );
}
