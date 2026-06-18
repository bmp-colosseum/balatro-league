"use client";

// Renders the "based on the current season" placement: each current division
// with its returning members + slotted-in rookies. Same schedule toggle as the
// fresh-sort sandbox so Owen sees opponents + SoS on the continuity layout too.

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

  const withSchedules = useMemo(() => {
    return divisions.map((d) => {
      let schedule: {
        opponents: Map<string, string[]>;
        sos: Map<string, number>;
        summary: ReturnType<typeof summariseSchedule>;
      } | null = null;
      if (showSchedules && d.members.length >= 2) {
        const sp = d.members.map((m) => ({ id: m.discordId, mmr: m.mmr }));
        const r = generateSchedule(sp, { degree: 4, seed: 1 });
        schedule = { opponents: r.opponents, sos: r.sos, summary: summariseSchedule(r, sp, 4) };
      }
      const nameOf = new Map(d.members.map((m) => [m.discordId, m.displayName]));
      return { ...d, schedule, nameOf };
    });
  }, [divisions, showSchedules]);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <strong>Based on {basedOnSeason}</strong>
          <span className="muted" style={{ fontSize: 12 }}>
            {returnerCount} returning (in their current division) · {rookieCount} new (slotted by MMR)
          </span>
          <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 5, marginLeft: "auto" }}>
            <input type="checkbox" checked={showSchedules} onChange={(e) => setShowSchedules(e.target.checked)} />
            Show schedules (4 opponents each)
          </label>
        </div>
        <p className="muted" style={{ fontSize: 11, margin: "6px 0 0" }}>
          Returners hold their current division; newcomers drop into the division whose average MMR is
          just below theirs. Promotion/relegation isn&apos;t applied (the season isn&apos;t over) —
          this is &ldquo;where everyone sits now + where new signups land.&rdquo; Nothing is saved.
        </p>
      </div>

      {withSchedules.map((d) => (
        <div key={d.name} className="card" style={{ margin: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
            {d.name}{" "}
            <span className="muted" style={{ fontWeight: 400 }}>
              — {d.members.length} players · {Math.max(0, Math.min(4, d.members.length - 1))} games each
            </span>
            {d.schedule && (
              <span className="muted" style={{ fontWeight: 400, marginLeft: 8, color: "#2ecc71" }}>
                · SoS {d.schedule.summary.minSos}–{d.schedule.summary.maxSos} (spread {d.schedule.summary.spread})
              </span>
            )}
          </div>

          {d.schedule ? (
            <div>
              {d.members
                .slice()
                .sort((a, b) => b.mmr - a.mmr)
                .map((m, idx) => (
                  <div
                    key={m.discordId}
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 8,
                      padding: "4px",
                      fontSize: 13,
                      borderTop: idx === 0 ? undefined : "1px solid rgba(255,255,255,0.06)",
                    }}
                  >
                    <span style={{ minWidth: 160, fontWeight: 500 }}>
                      {m.displayName}{" "}
                      <span className="muted" style={{ fontSize: 11 }}>{m.mmr}{m.isRookie ? " · new" : ""}</span>
                    </span>
                    <span className="muted" style={{ fontSize: 12, flex: 1 }}>
                      vs {(d.schedule!.opponents.get(m.discordId) ?? []).map((o) => d.nameOf.get(o) ?? o).join(", ")}
                    </span>
                    <span className="muted" style={{ fontSize: 11, fontVariantNumeric: "tabular-nums" }} title="Strength of schedule">
                      SoS {d.schedule!.sos.get(m.discordId)}
                    </span>
                  </div>
                ))}
            </div>
          ) : (
            <div>
              {d.members
                .slice()
                .sort((a, b) => b.mmr - a.mmr)
                .map((m, idx) => (
                  <div
                    key={m.discordId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      padding: "3px 4px",
                      fontSize: 13,
                      borderTop: idx === 0 ? undefined : "1px solid rgba(255,255,255,0.06)",
                    }}
                  >
                    <span style={{ flex: 1 }}>
                      {m.displayName}
                      {m.isRookie && <span style={{ color: "#76c7ff", fontSize: 11, marginLeft: 6 }}>new</span>}
                    </span>
                    <span className="muted" style={{ fontSize: 11, fontVariantNumeric: "tabular-nums" }}>{m.mmr}</span>
                  </div>
                ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
