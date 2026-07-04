// Shared scoreboard widget for the OBS match overlays (/overlay/matchup, /overlay/series).
// Opaque dark panel (legibility over video without text-shadow), theme CSS vars, tabular-nums
// scores, inline-block so OBS can crop it tight. Pure presentational - no data access.
import type { CSSProperties } from "react";

const panel: CSSProperties = {
  background: "rgba(15, 17, 21, 0.92)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "12px 18px",
  color: "var(--text)",
  display: "inline-block",
  minWidth: 320,
};

function TeamRow({ name, seed, score, winner }: { name: string; seed?: number | null; score: number; winner: boolean }) {
  const color = winner ? "var(--accent)" : "var(--text)";
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20, padding: "3px 0" }}>
      <span style={{ fontWeight: 700, fontSize: 22, color }}>
        {seed != null && <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 15, marginRight: 6 }}>#{seed}</span>}
        {name}
      </span>
      <span style={{ fontWeight: 800, fontSize: 26, fontVariantNumeric: "tabular-nums", color }}>{score}</span>
    </div>
  );
}

export function Scoreboard({
  label,
  aName,
  bName,
  aScore,
  bScore,
  aSeed,
  bSeed,
  winner,
  sub,
}: {
  label?: string | null;
  aName: string;
  bName: string;
  aScore: number;
  bScore: number;
  aSeed?: number | null;
  bSeed?: number | null;
  winner?: "A" | "B" | null;
  sub?: string | null;
}) {
  return (
    <div style={panel}>
      {label && (
        <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--accent)", marginBottom: 6 }}>{label}</div>
      )}
      <TeamRow name={aName} seed={aSeed} score={aScore} winner={winner === "A"} />
      <div style={{ height: 1, background: "var(--border)", margin: "2px 0" }} />
      <TeamRow name={bName} seed={bSeed} score={bScore} winner={winner === "B"} />
      {sub && <div style={{ marginTop: 6, fontSize: 12, color: "var(--muted)" }}>{sub}</div>}
    </div>
  );
}
