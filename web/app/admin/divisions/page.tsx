import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { loadAdminDivisionsIndex } from "@/lib/loaders/admin";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ConfirmButton";
import { SubmitButton } from "@/components/SubmitButton";
import { relabelDivisions, resyncSchedules, regenerateSchedules, regenerateDivisionSchedule, setRoundRobinTopDivisions, setDivisionFormat } from "@/app/admin/seasons/actions";
import { getPlacementRules } from "@/lib/placement-rules";

export const dynamic = "force-dynamic";

export default async function AdminDivisionsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  await requireAdmin();
  const { ok, err } = await searchParams;
  const { season, tiers } = await loadAdminDivisionsIndex();
  const rules = await getPlacementRules();

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/divisions" />
      <main>
        <h2>
          Divisions{" "}
          <span className="muted" style={{ fontWeight: "normal", fontSize: 14 }}>
            · {season?.name ?? "no active season"}
          </span>
        </h2>

        {season && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <form action={relabelDivisions}>
              <input type="hidden" name="seasonId" value={season.id} />
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                title="Rename every division to the standard format: first group = 'Tier A (1)', then 'Tier 2', 'Tier 3'… A tier with one division keeps just the tier name. Doesn't move any players."
              >
                ↻ Relabel divisions to standard names
              </Button>
            </form>
            {season.scheduleLocked && (
              <form action={resyncSchedules}>
                <input type="hidden" name="seasonId" value={season.id} />
                <SubmitButton
                  variant="secondary"
                  size="sm"
                  title="Rebuild the schedule to match the current roster: remove matches left over from players who left, and give every active player their assigned opponents. Roster edits do this automatically — use this if a schedule looks out of sync."
                >
                  🗓️ Re-sync schedules
                </SubmitButton>
              </form>
            )}
            {season.scheduleLocked && (
              <form action={regenerateSchedules}>
                <input type="hidden" name="seasonId" value={season.id} />
                <ConfirmButton
                  message="Wipe the whole schedule and rebuild it from scratch with the current rules and roster? This only works before any games are played — it stops if a single match has a result. Use it after changing the round-robin or promotion rules, or adding players before kickoff."
                  style={{
                    fontSize: 13,
                    padding: "5px 12px",
                    border: "1px solid var(--border, rgba(255,255,255,0.12))",
                    borderRadius: 6,
                    background: "var(--surface-2, rgba(255,255,255,0.05))",
                    color: "var(--text)",
                    cursor: "pointer",
                  }}
                >
                  ♻️ Regenerate schedule
                </ConfirmButton>
              </form>
            )}
          </div>
        )}

        {season && (
          <form
            action={setRoundRobinTopDivisions}
            className="card"
            style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}
          >
            <span style={{ fontSize: 13 }}>
              Top divisions that play a full <strong>round-robin</strong>:
            </span>
            <input
              type="number"
              name="roundRobinTopDivisions"
              defaultValue={rules.roundRobinTopDivisions}
              min={0}
              max={9}
              style={{ width: 56, padding: "4px 6px", borderRadius: 6, border: "1px solid var(--border, rgba(255,255,255,0.12))", background: "var(--surface-2, rgba(255,255,255,0.05))", color: "var(--text)" }}
            />
            <Button type="submit" variant="secondary" size="sm">Save</Button>
            <span className="muted" style={{ fontSize: 11 }}>
              e.g. <strong>1</strong> = only Legendary plays a full round-robin; Rare 1 and below each play 4 opponents. Then click ♻️ Regenerate to apply.
            </span>
          </form>
        )}

        {ok === "rules-saved" && (
          <div className="card" style={{ borderColor: "#2ecc71", color: "#2ecc71", marginBottom: 12 }}>
            ✓ Saved. Click <strong>♻️ Regenerate schedule</strong> to rebuild with the new rule.
          </div>
        )}
        {ok?.startsWith("regenerated-") && (
          <div className="card" style={{ borderColor: "#2ecc71", color: "#2ecc71", marginBottom: 12 }}>
            ♻️ Schedule regenerated — {ok.slice("regenerated-".length)} matches created.
          </div>
        )}
        {err === "games-already-played" && (
          <div className="card" style={{ borderColor: "#e74c3c", color: "#e74c3c", marginBottom: 12 }}>
            Can&apos;t regenerate — a game has already been played or reported this season. Regenerate only works before kickoff.
          </div>
        )}

        {!season ? (
          <div className="card muted">
            No active season — <Link href="/admin/seasons">create one</Link> first.
          </div>
        ) : tiers.filter((t) => t.divisions.length > 0).length === 0 ? (
          <div className="card muted">No divisions in this season.</div>
        ) : (
          tiers
            .filter((t) => t.divisions.length > 0)
            .map((tier) => {
              const color = tierColors(tier.position);
              return (
                <section key={tier.id} style={{ marginTop: 24 }}>
                  <h3>
                    <span className="pill" style={{ background: color.bg, color: color.fg, marginRight: 8 }}>
                      {tier.name}
                    </span>
                    <span className="muted" style={{ fontSize: 14, fontWeight: "normal" }}>
                      ({tier.divisions.length})
                    </span>
                  </h3>
                  <div className="grid grid-3">
                    {tier.divisions.map((d) => {
                      const pct = d.expectedPairingCount === 0
                        ? 0
                        : Math.round((d.confirmedPairingCount / d.expectedPairingCount) * 100);
                      return (
                        <div key={d.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <Link
                            href={`/divisions/${d.id}`}
                            style={{
                              display: "block",
                              padding: 14,
                              background: "var(--surface)",
                              border: "1px solid var(--border)",
                              borderRadius: 8,
                              color: "var(--text)",
                              textDecoration: "none",
                            }}
                          >
                            <strong>{d.name}</strong>
                            <div className="muted" style={{ marginTop: 8 }}>
                              {d.memberCount} player{d.memberCount === 1 ? "" : "s"} · {d.confirmedPairingCount}/{d.expectedPairingCount} matches
                            </div>
                            <div style={{ background: "var(--surface-2)", borderRadius: 99, height: 6, overflow: "hidden", marginTop: 6 }}>
                              <div style={{ background: "var(--accent-2)", height: "100%", width: `${pct}%` }} />
                            </div>
                          </Link>
                          {season.scheduleLocked && (
                            <form action={setDivisionFormat} style={{ display: "flex", gap: 4 }}>
                              <input type="hidden" name="divisionId" value={d.id} />
                              <select
                                name="roundRobin"
                                defaultValue={d.roundRobin === true ? "rr" : d.roundRobin === false ? "graph" : ""}
                                style={{ flex: 1, fontSize: 11, padding: "4px 6px", borderRadius: 6, border: "1px solid var(--border, rgba(255,255,255,0.12))", background: "var(--surface-2, rgba(255,255,255,0.05))", color: "var(--text)" }}
                              >
                                <option value="">Format: default</option>
                                <option value="rr">🔁 Round robin (everyone)</option>
                                <option value="graph">🎯 4 opponents</option>
                              </select>
                              <Button type="submit" variant="secondary" size="sm">Set</Button>
                            </form>
                          )}
                          {season.scheduleLocked && (
                            <form action={regenerateDivisionSchedule}>
                              <input type="hidden" name="divisionId" value={d.id} />
                              <ConfirmButton
                                message={`Regenerate only ${d.name}'s schedule from its format and roster? Every other division is left untouched. Only works before any games are played in this division.`}
                                style={{ width: "100%", fontSize: 11, padding: "4px 8px", border: "1px solid var(--border, rgba(255,255,255,0.12))", borderRadius: 6, background: "var(--surface-2, rgba(255,255,255,0.05))", color: "var(--text)", cursor: "pointer" }}
                              >
                                ♻️ Regenerate just this division
                              </ConfirmButton>
                            </form>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })
        )}
      </main>
    </>
  );
}
