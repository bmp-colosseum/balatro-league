import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { loadAdminDivisionsIndex } from "@/lib/loaders/admin";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ConfirmButton";
import { SubmitButton } from "@/components/SubmitButton";
import { resyncSchedules, regenerateSchedules, regenerateDivisionSchedule, setDivisionOpponents, setDivisionPromoteRelegate } from "@/app/admin/seasons/actions";
import { Input } from "@/components/ui/input";
import { Callout } from "@/components/Callout";
import { ReplacePlayerSection } from "@/components/ReplacePlayerSection";
import { loadActiveSeasonRoster } from "@/lib/loaders/active-roster";

export const dynamic = "force-dynamic";

export default async function AdminDivisionsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string; replace?: string; replaceerr?: string }>;
}) {
  await requireAdmin();
  const { ok, err, replace, replaceerr } = await searchParams;
  const { season, tiers } = await loadAdminDivisionsIndex();
  const roster = season ? await loadActiveSeasonRoster() : [];

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

        {/* Promote/relegate counts only drive END-OF-SEASON movement (and the
            up/down zones on standings) - they never affect who plays whom, so
            there's nothing to regenerate. */}
        {ok === "rules-saved" && (
          <Callout type="success" style={{ marginBottom: 12 }}>
            ✓ Saved — promotion/relegation counts apply immediately.
          </Callout>
        )}
        {/* Opponents-per-player DOES change the schedule shape, so this is the
            one that needs a regenerate to take effect. */}
        {ok === "format-saved" && (
          <Callout type="success" style={{ marginBottom: 12 }}>
            ✓ Saved. Regenerate the division&apos;s schedule to apply the new opponent count.
          </Callout>
        )}
        {ok?.startsWith("regenerated-") && (
          <Callout type="success" style={{ marginBottom: 12 }}>
            ♻️ Schedule regenerated — {ok.slice("regenerated-".length)} matches created.
          </Callout>
        )}
        {err === "games-already-played" && (
          <Callout type="danger" style={{ marginBottom: 12 }}>
            Can&apos;t regenerate — a game has already been played or reported. Regenerate only works before kickoff.
          </Callout>
        )}

        {replace && (
          <Callout type="success" style={{ marginBottom: 12 }}>✓ Replaced: {replace}</Callout>
        )}
        {replaceerr && (
          <Callout type="danger" style={{ marginBottom: 12 }}>{replaceerr}</Callout>
        )}

        {season && (
          <div className="card card-admin" style={{ marginBottom: 16 }}>
            <ReplacePlayerSection players={roster} returnTo="/admin/divisions" />
          </div>
        )}

        {!season ? (
          <div className="card muted">
            No active season — <Link href="/admin/seasons">create one</Link> first.
          </div>
        ) : tiers.filter((t) => t.divisions.length > 0).length === 0 ? (
          <div className="card muted">No divisions in this season.</div>
        ) : (
          <>
            {tiers
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
                    <div className="grid grid-2">
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
                              <form action={setDivisionOpponents} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                                <input type="hidden" name="divisionId" value={d.id} />
                                <span className="muted" style={{ fontSize: 11 }} title="Opponents scheduled per player. Blank = season default; a number at or above (players - 1) plays a full round-robin.">
                                  opponents/player
                                </span>
                                <Input
                                  type="number"
                                  name="opponentsPerPlayer"
                                  min={1}
                                  max={30}
                                  placeholder="default"
                                  defaultValue={d.opponentsPerPlayer ?? ""}
                                  style={{ width: 64, fontSize: 11, padding: "1px 4px" }}
                                />
                                <Button type="submit" variant="secondary" size="sm">Set</Button>
                              </form>
                            )}
                            {season.scheduleLocked && (
                              <form action={setDivisionPromoteRelegate} style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                                <input type="hidden" name="divisionId" value={d.id} />
                                <span className="muted" style={{ fontSize: 11 }} title="How many of this division's TOP finishers promote up a division at season end.">
                                  <span style={{ color: "var(--info)" }}>↑</span>&nbsp;promote
                                </span>
                                <Input type="number" name="promote" min={0} max={20} defaultValue={d.promoteCount} style={{ width: 42, fontSize: 11, padding: "1px 4px" }} />
                                <span className="muted" style={{ fontSize: 11 }} title="How many of this division's BOTTOM finishers relegate down a division at season end.">
                                  <span style={{ color: "var(--admin)" }}>↓</span>&nbsp;relegate
                                </span>
                                <Input type="number" name="relegate" min={0} max={20} defaultValue={d.relegateCount} style={{ width: 42, fontSize: 11, padding: "1px 4px" }} />
                                <Button type="submit" variant="secondary" size="sm">Set</Button>
                              </form>
                            )}
                            {season.scheduleLocked && (
                              <form action={regenerateDivisionSchedule}>
                                <input type="hidden" name="divisionId" value={d.id} />
                                <ConfirmButton
                                  message={`Regenerate only ${d.name}'s schedule from its format and roster? Every other division is left untouched. Only works before any games are played in this division.`}
                                  variant="secondary"
                                  size="sm"
                                  className="w-full"
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
              })}

            {/* Whole-season schedule surgery — collapsed so nobody runs it by accident.
                Both are blocked the moment any game in the season has a result. */}
            {season.scheduleLocked && (
              <details className="card card-danger" style={{ marginTop: 28 }}>
                <summary style={{ cursor: "pointer", color: "var(--danger)" }}>
                  <strong>⚠️ Advanced schedule tools</strong>
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                    whole-season surgery — rarely needed, pre-kickoff only
                  </span>
                </summary>
                <div style={{ display: "grid", gap: 14, marginTop: 12 }}>
                  <div>
                    <strong style={{ fontSize: 13 }}>Re-sync schedules</strong>
                    <p className="muted" style={{ fontSize: 12, margin: "2px 0 6px" }}>
                      Rebuild every division&apos;s schedule to match the current roster — drops matches left
                      by players who left, and gives every active player their assigned opponents. Roster
                      edits do this automatically; use only if a schedule looks out of sync.
                    </p>
                    <form action={resyncSchedules}>
                      <input type="hidden" name="seasonId" value={season.id} />
                      <SubmitButton variant="secondary" size="sm">🗓️ Re-sync schedules</SubmitButton>
                    </form>
                  </div>
                  <div>
                    <strong style={{ fontSize: 13 }}>Regenerate whole-season schedule</strong>
                    <p className="muted" style={{ fontSize: 12, margin: "2px 0 6px" }}>
                      Wipe every division&apos;s schedule and rebuild from scratch with the current rules and
                      roster. Blocked the moment any game has a result — pre-kickoff only.
                    </p>
                    <form action={regenerateSchedules}>
                      <input type="hidden" name="seasonId" value={season.id} />
                      <ConfirmButton
                        message="Wipe the whole season's schedule and rebuild from scratch? Only works before any games are played — it stops if a single match has a result."
                        variant="destructive"
                        size="sm"
                      >
                        ♻️ Regenerate whole season
                      </ConfirmButton>
                    </form>
                  </div>
                </div>
              </details>
            )}
          </>
        )}
      </main>
    </>
  );
}
