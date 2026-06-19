"use client";

// Dry-run placement sandbox. Runs the CURRENT signups through the real build
// math (planByRating) and the real schedule generator (generateSchedule)
// entirely in the browser — twist the tier shape, optionally show each player's
// assigned 4-opponent schedule + the strength-of-schedule spread, all without
// writing a single row. Both functions are pure, so this is exactly what a real
// setup would produce. The artifact to show Owen.

import { useMemo, useState } from "react";
import { planByRating, type TierConfig } from "@/lib/season-plan";
import { generateSchedule, summariseSchedule } from "@/lib/schedule";

export interface SandboxPlayer {
  discordId: string;
  displayName: string;
  rating: number | null; // legacy league rank (1 = strongest); null = unrated
  mmr: number | null;     // BMP ranked MMR
  hiddenMmr: number | null; // the secret league MMR (BMP ×1.5 scale); null = unset
}

export function PlacementSandbox({
  players,
  initialTiers,
  initialTargetGroupSize = 5,
}: {
  players: SandboxPlayer[];
  initialTiers: TierConfig[];
  initialTargetGroupSize?: number;
}) {
  const [tiers, setTiers] = useState<TierConfig[]>(
    initialTiers.length ? initialTiers : [{ name: "Common", divisionCount: 1 }],
  );
  const [targetGroupSize, setTargetGroupSize] = useState(initialTargetGroupSize);
  const [showSchedules, setShowSchedules] = useState(false);

  const lookup = useMemo(() => new Map(players.map((p) => [p.discordId, p])), [players]);

  // Place by the stored secret MMR: rank players by hiddenMmr desc (highest =
  // top division), unset → last. planByRating sorts by this rank ascending.
  const ranked = useMemo(() => {
    const ordered = [...players].sort((a, b) => (b.hiddenMmr ?? -Infinity) - (a.hiddenMmr ?? -Infinity));
    const rankBy = new Map<string, number | null>();
    ordered.forEach((p, i) => rankBy.set(p.discordId, p.hiddenMmr == null ? null : i + 1));
    return players.map((p) => ({
      id: p.discordId,
      discordId: p.discordId,
      displayName: p.displayName,
      rating: rankBy.get(p.discordId) ?? null,
    }));
  }, [players]);

  // The schedule generator uses the real secret MMR directly.
  const seedMmr = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of players) m.set(p.discordId, p.hiddenMmr ?? 0);
    return m;
  }, [players]);

  const unsetMmr = players.filter((p) => p.hiddenMmr == null).length;

  const projection = useMemo(() => {
    const plan = planByRating(ranked, tiers, targetGroupSize);
    let totalDivs = 0;
    let placed = 0;
    const tiersOut = plan.map((pt) => {
      const divisions = pt.divisions.map((divIds, gi) => {
        totalDivs++;
        placed += divIds.length;
        let schedule: {
          opponents: Map<string, string[]>;
          sos: Map<string, number>;
          summary: ReturnType<typeof summariseSchedule>;
        } | null = null;
        if (showSchedules && divIds.length >= 2) {
          const sp = divIds.map((id) => ({ id, mmr: seedMmr.get(id) ?? 0 }));
          const r = generateSchedule(sp, { degree: 4, seed: 1 });
          schedule = { opponents: r.opponents, sos: r.sos, summary: summariseSchedule(r, sp, 4) };
        }
        return { name: `${pt.tier.name} ${gi + 1}`, size: divIds.length, members: divIds, schedule };
      });
      return { name: pt.tier.name, position: pt.position, size: divisions.reduce((s, d) => s + d.size, 0), divisions };
    });
    return { tiersOut, totalDivs, placed };
  }, [ranked, tiers, targetGroupSize, showSchedules, seedMmr]);

  const updateTier = (i: number, patch: Partial<TierConfig>) =>
    setTiers(tiers.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  const addTier = () => setTiers([...tiers, { name: "New tier", divisionCount: 1 }]);
  const removeTier = (i: number) => setTiers(tiers.filter((_, idx) => idx !== i));

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* Controls */}
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <strong>Structure</strong>
          <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}>
            Division size
            <input
              type="number"
              min={2}
              max={20}
              value={targetGroupSize}
              onChange={(e) => setTargetGroupSize(Math.max(2, Math.min(20, Number(e.target.value) || 5)))}
              style={{ width: 56, padding: "2px 4px" }}
            />
          </label>
          <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 5, marginLeft: "auto" }}>
            <input type="checkbox" checked={showSchedules} onChange={(e) => setShowSchedules(e.target.checked)} />
            Show schedules (4 opponents each)
          </label>
        </div>

        <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
          {tiers.map((t, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span className="muted" style={{ fontSize: 11, width: 16 }}>{i + 1}</span>
              <input
                type="text"
                value={t.name}
                onChange={(e) => updateTier(i, { name: e.target.value })}
                style={{ flex: "1 1 160px", padding: "2px 6px", fontSize: 13 }}
              />
              <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }} className="muted">
                divisions
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={t.divisionCount}
                  onChange={(e) => updateTier(i, { divisionCount: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })}
                  style={{ width: 48, padding: "2px 4px", fontSize: 13 }}
                />
              </label>
              <button
                type="button"
                onClick={() => removeTier(i)}
                disabled={tiers.length <= 1}
                style={{ background: "none", border: "none", color: tiers.length <= 1 ? "#555" : "#e74c3c", cursor: tiers.length <= 1 ? "default" : "pointer", fontSize: 12 }}
              >
                remove
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addTier}
            style={{ background: "none", border: "none", color: "#76c7ff", cursor: "pointer", fontSize: 12, justifySelf: "start", padding: 0 }}
          >
            + Add tier
          </button>
        </div>

        <div className="muted" style={{ fontSize: 12, marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          {projection.placed} players · {projection.totalDivs} divisions
          {unsetMmr > 0 && (
            <span style={{ color: "#f1c40f" }}>
              {" "}· ⚠ {unsetMmr} with no secret MMR — set them on <a href="/admin/mmr">/admin/mmr</a> for an accurate preview
            </span>
          )}
        </div>
        <p className="muted" style={{ fontSize: 11, margin: "6px 0 0" }}>
          Dry-run only — nothing here is saved. With schedules on, each player gets a balanced set of 4
          opponents; &ldquo;SoS&rdquo; = sum of their opponents&apos; MMR, kept tight so everyone&apos;s
          slate is comparable.
        </p>
      </div>

      {/* Projection */}
      {projection.tiersOut.map((tier) => (
        <div key={tier.position}>
          <h3 style={{ margin: "4px 0 8px", display: "flex", alignItems: "baseline", gap: 10 }}>
            {tier.name}
            <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
              {tier.size} player{tier.size === 1 ? "" : "s"} · {tier.divisions.length} division{tier.divisions.length === 1 ? "" : "s"}
            </span>
          </h3>
          <div style={{ display: "grid", gap: 10 }}>
            {tier.divisions.map((div) => (
              <div key={div.name} className="card" style={{ margin: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
                  {div.name}{" "}
                  <span className="muted" style={{ fontWeight: 400 }}>
                    — {div.size} players · {Math.max(0, Math.min(4, div.size - 1))} games each
                  </span>
                  {div.schedule && (
                    <span className="muted" style={{ fontWeight: 400, marginLeft: 8, color: "#2ecc71" }}>
                      · SoS {div.schedule.summary.minSos}–{div.schedule.summary.maxSos} (spread {div.schedule.summary.spread})
                    </span>
                  )}
                </div>

                {div.schedule ? (
                  // Schedule view: each player → their assigned opponents + SoS.
                  <div>
                    {div.members
                      .slice()
                      .sort((a, b) => (seedMmr.get(b) ?? 0) - (seedMmr.get(a) ?? 0))
                      .map((id, idx) => {
                        const p = lookup.get(id);
                        const opps = div.schedule!.opponents.get(id) ?? [];
                        return (
                          <div
                            key={id}
                            style={{
                              display: "flex",
                              alignItems: "baseline",
                              gap: 8,
                              padding: "4px",
                              fontSize: 13,
                              borderTop: idx === 0 ? undefined : "1px solid rgba(255,255,255,0.06)",
                            }}
                          >
                            <span style={{ minWidth: 150, fontWeight: 500 }}>
                              {p?.displayName ?? id}{" "}
                              <span className="muted" style={{ fontSize: 11 }}>{seedMmr.get(id)}</span>
                            </span>
                            <span className="muted" style={{ fontSize: 12, flex: 1 }}>
                              vs {opps.map((o) => lookup.get(o)?.displayName ?? o).join(", ")}
                            </span>
                            <span className="muted" style={{ fontSize: 11, fontVariantNumeric: "tabular-nums" }} title="Strength of schedule (sum of opponent MMR)">
                              SoS {div.schedule!.sos.get(id)}
                            </span>
                          </div>
                        );
                      })}
                  </div>
                ) : (
                  // Roster view (schedules off).
                  <div>
                    {div.members.map((id, idx) => {
                      const p = lookup.get(id);
                      return (
                        <div
                          key={id}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 5,
                            padding: "3px 4px",
                            fontSize: 13,
                            borderTop: idx === 0 ? undefined : "1px solid rgba(255,255,255,0.06)",
                          }}
                        >
                          <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {p?.displayName ?? id}
                          </span>
                          <span
                            className="muted"
                            style={{ fontSize: 11, fontVariantNumeric: "tabular-nums", color: p?.hiddenMmr == null ? "#f1c40f" : undefined }}
                            title="Secret MMR"
                          >
                            {p?.hiddenMmr == null ? "no MMR" : p.hiddenMmr}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
