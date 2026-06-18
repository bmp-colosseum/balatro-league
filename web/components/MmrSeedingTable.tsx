"use client";

// Hidden-MMR seeding preview for a signup round, on Owen's league scale
// (top seed = 2200, −10 per seed by default). Returners are ordered by their
// league rank; rookies slot in by their BMP MMR once ratings are filled. The
// top/step knobs are live so Owen can twist them and see the result. Pure
// preview — nothing is saved; this just shows what the initial hidden MMRs
// would look like so he can sanity-check before we persist + run Elowen.

import { useMemo, useState } from "react";

export interface SeedPlayer {
  discordId: string;
  displayName: string;
  rating: number | null; // league rank (1 = best); null = not ranked yet
  mmr: number | null;     // BMP ranked MMR (the rookie proxy)
}

export function MmrSeedingTable({ players }: { players: SeedPlayer[] }) {
  const [top, setTop] = useState(2200);
  const [step, setStep] = useState(10);

  const seeded = useMemo(() => {
    const ordered = [...players].sort((a, b) => {
      const ra = a.rating ?? Number.POSITIVE_INFINITY;
      const rb = b.rating ?? Number.POSITIVE_INFINITY;
      if (ra !== rb) return ra - rb;
      return a.displayName.localeCompare(b.displayName);
    });
    return ordered.map((p, i) => ({
      ...p,
      pos: i + 1,
      seedMmr: Math.max(0, top - i * step),
      unranked: p.rating == null,
    }));
  }, [players, top, step]);

  const unrankedCount = seeded.filter((s) => s.unranked).length;

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <strong>Hidden MMR seeding</strong>
        <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}>
          Top
          <input
            type="number"
            value={top}
            onChange={(e) => setTop(Math.max(0, Number(e.target.value) || 0))}
            style={{ width: 72, padding: "2px 4px" }}
          />
        </label>
        <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}>
          Step
          <input
            type="number"
            value={step}
            onChange={(e) => setStep(Math.max(0, Number(e.target.value) || 0))}
            style={{ width: 56, padding: "2px 4px" }}
          />
        </label>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
        Owen&apos;s scale: top seed = {top}, −{step} per seed. Returners ordered by league rank; rookies
        slot in by BMP MMR. <strong>Preview only — nothing saved.</strong>
        {unrankedCount > 0 && (
          <span style={{ color: "#f1c40f" }}>
            {" "}⚠ {unrankedCount} player{unrankedCount === 1 ? "" : "s"} not ranked yet — run
            &ldquo;Fill ratings from BMP&rdquo; on the setup page so they seed correctly.
          </span>
        )}
      </p>

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 10, fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
            <th style={{ padding: "4px 8px", width: 40 }}>#</th>
            <th style={{ padding: "4px 8px" }}>Player</th>
            <th style={{ padding: "4px 8px", textAlign: "right" }}>Seed MMR</th>
            <th style={{ padding: "4px 8px", textAlign: "right" }} className="muted">BMP MMR</th>
          </tr>
        </thead>
        <tbody>
          {seeded.map((s) => (
            <tr key={s.discordId} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
              <td style={{ padding: "3px 8px" }} className="muted">{s.pos}</td>
              <td style={{ padding: "3px 8px" }}>
                {s.displayName}
                {s.unranked && (
                  <span style={{ color: "#f1c40f", fontSize: 11, marginLeft: 6 }}>unranked</span>
                )}
              </td>
              <td style={{ padding: "3px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                {s.seedMmr}
              </td>
              <td style={{ padding: "3px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }} className="muted">
                {s.mmr ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
