"use client";

// The "send to Owen" view: next season built from the current one, with all the
// signal visible — each player's movement (↑ promoted / ↓ relegated / held /
// NEW), where they came from, their last-season standing, and MMR; per-division
// summaries (size, returners vs new, average MMR); and an optional schedule view
// (4 opponents + SoS spread). Returners are locked to their finish; only rookies
// fill gaps. Pure projection.

import { useMemo, useState } from "react";
import { generateSchedule, summariseSchedule } from "@/lib/schedule";
import type { ContinuityDivision } from "@/lib/loaders/continuity";

export function ContinuityPreview({
  divisions,
  returnerCount,
  rookieCount,
  basedOnSeason,
}: {
  divisions: ContinuityDivision[];
  returnerCount: number;
  rookieCount: number;
  basedOnSeason: string;
}) {
  const [showSchedules, setShowSchedules] = useState(false);
  const names = useMemo(() => divisions.map((d) => d.name), [divisions]);

  const view = useMemo(() => {
    return divisions.map((d, divIdx) => {
      const members = d.members.slice().sort((a, b) => {
        if (a.isRookie !== b.isRookie) return a.isRookie ? 1 : -1; // returners first
        return b.mmr - a.mmr;
      });
      const backCount = members.filter((m) => !m.isRookie).length;
      const newCount = members.length - backCount;
      const avgMmr = members.length ? Math.round(members.reduce((s, m) => s + m.mmr, 0) / members.length) : 0;
      let schedule: {
        opponents: Map<string, string[]>;
        sos: Map<string, number>;
        summary: ReturnType<typeof summariseSchedule>;
      } | null = null;
      if (showSchedules && members.length >= 2) {
        const sp = members.map((m) => ({ id: m.discordId, mmr: m.mmr }));
        // Legendary (top division) is a full round-robin — everyone plays everyone.
        // Every other division is the balanced 4-opponent graph.
        const degree = divIdx === 0 ? members.length - 1 : 4;
        const r = generateSchedule(sp, { degree, seed: 1 });
        schedule = { opponents: r.opponents, sos: r.sos, summary: summariseSchedule(r, sp, degree) };
      }
      const nameOf = new Map(members.map((m) => [m.discordId, m.displayName]));
      return { name: d.name, divIdx, members, backCount, newCount, avgMmr, schedule, nameOf };
    });
  }, [divisions, showSchedules]);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* Summary */}
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <strong>Season built from {basedOnSeason}</strong>
          <span className="muted" style={{ fontSize: 12 }}>
            {returnerCount + rookieCount} players · {returnerCount} returning · {rookieCount} new · {divisions.length} divisions
          </span>
          <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 5, marginLeft: "auto" }}>
            <input type="checkbox" checked={showSchedules} onChange={(e) => setShowSchedules(e.target.checked)} />
            Show schedules (4 opponents each)
          </label>
        </div>
        <p className="muted" style={{ fontSize: 11, margin: "6px 0 0" }}>
          Returners hold their finish division (with promotion ↑ / relegation ↓); only newcomers fill gaps,
          by MMR. <strong>Finishers are never shuffled by size-balancing.</strong> Each row shows movement,
          last-season standing, <strong>BMP</strong> (balatromp ranked) and our <strong>internal MMR</strong>
          (right). Internal MMR comes from season results once you recompute on /admin/mmr. Nothing is saved.
        </p>
      </div>

      {/* Divisions */}
      {view.map((d) => (
        <div key={d.name} className="card" style={{ margin: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>
            {d.name}{" "}
            <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
              — {d.members.length} players ({d.backCount} back · {d.newCount} new) · avg MMR {d.avgMmr}
              {d.divIdx === 0 ? " · round-robin" : ""}
              {d.schedule ? ` · SoS ${d.schedule.summary.minSos}–${d.schedule.summary.maxSos} (spread ${d.schedule.summary.spread})` : ""}
            </span>
            {d.divIdx !== 0 && d.members.length < 5 && (
              <span style={{ fontWeight: 400, marginLeft: 8, color: "#f1c40f", fontSize: 12 }}>
                ⚠ thin (&lt;5)
              </span>
            )}
          </div>
          <div>
            {d.members.map((m, idx) => {
              const promoted = m.fromIndex != null && d.divIdx < m.fromIndex;
              const relegated = m.fromIndex != null && d.divIdx > m.fromIndex;
              const fromName = (promoted || relegated) && m.fromIndex != null ? names[m.fromIndex] : null;
              return (
                <div
                  key={m.discordId}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    padding: "3px 4px",
                    fontSize: 13,
                    borderTop: idx === 0 ? undefined : "1px solid rgba(255,255,255,0.05)",
                  }}
                >
                  {/* movement */}
                  <span style={{ width: 14, textAlign: "center", color: promoted ? "#2ecc71" : relegated ? "#e74c3c" : "#666" }}>
                    {m.isRookie ? "" : promoted ? "↑" : relegated ? "↓" : "="}
                  </span>
                  <span style={{ flex: "1 1 160px", fontWeight: 500 }}>
                    {m.displayName}
                    {m.isRookie && <span style={{ color: "#76c7ff", fontSize: 11, marginLeft: 6 }}>NEW</span>}
                    {fromName && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>← {fromName}</span>}
                  </span>
                  <span className="muted" style={{ fontSize: 11, minWidth: 78, textAlign: "right" }} title="Last-season standing">
                    {m.standing ? `#${m.standing.rank} · ${m.standing.record}` : m.isRookie ? "—" : "no games"}
                  </span>
                  {d.schedule ? (
                    <>
                      <span className="muted" style={{ fontSize: 12, flex: "2 1 220px" }}>
                        vs {(d.schedule.opponents.get(m.discordId) ?? []).map((o) => d.nameOf.get(o) ?? o).join(", ")}
                      </span>
                      <span className="muted" style={{ fontSize: 11, minWidth: 64, textAlign: "right" }}>SoS {d.schedule.sos.get(m.discordId)}</span>
                    </>
                  ) : null}
                  <span className="muted" style={{ fontSize: 11, fontVariantNumeric: "tabular-nums", minWidth: 64, textAlign: "right" }} title="BMP ranked MMR">
                    {m.bmp != null ? `BMP ${m.bmp}` : "BMP —"}
                  </span>
                  <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums", minWidth: 48, textAlign: "right", fontWeight: 600 }} title="Internal (secret) MMR">
                    {m.mmr}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
