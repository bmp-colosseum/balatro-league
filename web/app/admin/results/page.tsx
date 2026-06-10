// Central admin surface for fixing match results. One place to Record /
// Override / Forfeit-DQ / Showdown / Undo, instead of the same ops scattered
// across the division, players, and disputes pages. Backed by lib/match-admin.
//
// Entry: pick a division, OR search a player to jump to their division.

import { Suspense } from "react";
import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { FlashToast } from "@/components/FlashToast";
import { PlayerSearch } from "@/components/PlayerSearch";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { loadResultsPage, type ResultsMember } from "@/lib/loaders/admin-results";
import { recordResultAction, overrideResultAction, forfeitAction, showdownAction, undoAction } from "./actions";

export const dynamic = "force-dynamic";

const OK_MSG: Record<string, string> = {
  recorded: "Result recorded.",
  overridden: "Result overridden.",
  forfeit: "Forfeit / DQ recorded.",
  showdown: "Showdown recorded.",
  undone: "Match removed.",
};

export default async function ResultsPage({
  searchParams,
}: {
  searchParams: Promise<{ division?: string; player?: string; ok?: string }>;
}) {
  await requireAdmin();
  const { division: divisionId, player: playerId } = await searchParams;
  const data = await loadResultsPage({ divisionId, playerId });
  const sel = data.selection;

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/results" />
      <main>
        <h2>Results</h2>
        <p className="muted">
          Record, override, forfeit/DQ, settle a showdown, or undo any match — all in one place.
        </p>

        <Suspense fallback={null}><FlashToast messages={OK_MSG} /></Suspense>

        {/* ---- Entry: division picker + player search ---- */}
        <div className="card" style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
          <form method="get" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <label className="muted" style={{ fontSize: 12 }}>Division</label>
            <select name="division" defaultValue={sel?.division.id ?? ""} style={{ minWidth: 220 }}>
              <option value="">— pick a division —</option>
              {data.divisions.map((d) => (
                <option key={d.id} value={d.id}>{d.tierName} — {d.name}</option>
              ))}
            </select>
            <Button type="submit">Go</Button>
          </form>
          {data.hasActiveSeason && (
            <form method="get" style={{ display: "flex", gap: 6, alignItems: "center", flex: "1 1 260px" }}>
              <label className="muted" style={{ fontSize: 12 }}>or player</label>
              <PlayerSearch players={data.allPlayers.map((p) => ({ id: p.playerId, displayName: p.displayName }))} name="player" placeholder="…jump to a player's division" />
              <Button type="submit" variant="secondary">Find</Button>
            </form>
          )}
        </div>

        {!data.hasActiveSeason && <div className="card muted">No active season right now.</div>}

        {data.resolvedFromPlayer && sel && (
          <p className="muted" style={{ fontSize: 12 }}>
            Showing <strong>{sel.division.tierName} — {sel.division.name}</strong> (where {data.resolvedFromPlayer.displayName} plays).
          </p>
        )}

        {sel && (
          <>
            <h3 style={{ marginTop: 20 }}>{sel.division.tierName} — {sel.division.name}</h3>

            {/* ---- Record a result ---- */}
            <section className="card">
              <strong>Record a result</strong>
              <p className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                Sets (or overwrites) the best-of-2 between two players. &ldquo;A 2-0&rdquo; means the first player won both.
              </p>
              <form action={recordResultAction} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <input type="hidden" name="divisionId" value={sel.division.id} />
                <MemberSelect name="playerAId" members={sel.members} label="A…" />
                <span className="muted">vs</span>
                <MemberSelect name="playerBId" members={sel.members} label="B…" />
                <select name="result" required defaultValue="2-0">
                  <option value="2-0">A wins 2-0</option>
                  <option value="1-1">1-1 draw</option>
                  <option value="0-2">B wins 2-0</option>
                </select>
                <Button type="submit">Record</Button>
              </form>
            </section>

            {/* ---- Forfeit / DQ ---- */}
            <section className="card">
              <strong>Forfeit / DQ</strong>
              <p className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                Awards a 2-0 win by default. Reason is <em>admin-only</em> (players just see &ldquo;by DQ&rdquo;).
              </p>
              <form action={forfeitAction} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <input type="hidden" name="divisionId" value={sel.division.id} />
                <span className="muted" style={{ fontSize: 12 }}>winner</span>
                <MemberSelect name="winnerId" members={sel.members} label="winner…" />
                <span className="muted" style={{ fontSize: 12 }}>loser</span>
                <MemberSelect name="loserId" members={sel.members} label="forfeited…" />
                <Input name="reason" required placeholder="Reason (admin-only)" className="flex-1 min-w-[200px]" />
                <Button type="submit">Record DQ</Button>
              </form>
            </section>

            {/* ---- Showdown ---- */}
            <section className="card">
              <strong>⚔ Showdown</strong>
              <p className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                1-game tiebreaker for two players tied on a promotion/relegation spot.
              </p>
              <form action={showdownAction} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <input type="hidden" name="divisionId" value={sel.division.id} />
                <MemberSelect name="p1Id" members={sel.members} label="p1…" />
                <span className="muted">vs</span>
                <MemberSelect name="p2Id" members={sel.members} label="p2…" />
                <span className="muted" style={{ fontSize: 12 }}>winner</span>
                <MemberSelect name="winnerId" members={sel.members} label="winner…" />
                <Button type="submit">Record showdown</Button>
              </form>
            </section>

            {/* ---- Existing matches: override / undo ---- */}
            <section className="card">
              <strong>Recorded matches ({sel.matches.length})</strong>
              {sel.matches.length === 0 ? (
                <p className="muted" style={{ fontSize: 12 }}>Nothing recorded in this division yet.</p>
              ) : (
                <table style={{ marginTop: 8 }}>
                  <thead>
                    <tr><th>Match</th><th>Score</th><th>Type</th><th>Override</th><th></th></tr>
                  </thead>
                  <tbody>
                    {sel.matches.map((m) => (
                      <tr key={m.id}>
                        <td>{m.aName} <span className="muted">vs</span> {m.bName}</td>
                        <td><strong>{m.gamesWonA}-{m.gamesWonB}</strong></td>
                        <td style={{ fontSize: 11 }} className="muted">
                          {m.format === "SHOOTOUT_BO1" ? "⚔ showdown" : m.forfeit ? "by DQ" : "league"}
                          {m.status !== "CONFIRMED" ? ` · ${m.status.toLowerCase()}` : ""}
                        </td>
                        <td>
                          {m.format === "LEAGUE_BO2" ? (
                            <form action={overrideResultAction} style={{ display: "flex", gap: 4 }}>
                              <input type="hidden" name="divisionId" value={sel.division.id} />
                              <input type="hidden" name="matchId" value={m.id} />
                              <select name="result" defaultValue={`${m.gamesWonA}-${m.gamesWonB}`} style={{ fontSize: 11 }}>
                                <option value="2-0">{m.aName} 2-0</option>
                                <option value="1-1">1-1</option>
                                <option value="0-2">{m.bName} 2-0</option>
                              </select>
                              <Button type="submit" variant="secondary" size="sm">Set</Button>
                            </form>
                          ) : (
                            <span className="muted" style={{ fontSize: 11 }}>—</span>
                          )}
                        </td>
                        <td>
                          <form action={undoAction}>
                            <input type="hidden" name="divisionId" value={sel.division.id} />
                            <input type="hidden" name="matchId" value={m.id} />
                            <ConfirmButton
                              message={`Remove the ${m.aName} vs ${m.bName} result? Standings fall back to the next tiebreaker.`}
                              className="secondary"
                              style={{ fontSize: 11, color: "#e74c3c" }}
                            >
                              Undo
                            </ConfirmButton>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}

function MemberSelect({ name, members, label }: { name: string; members: ResultsMember[]; label: string }) {
  return (
    <select name={name} required defaultValue="" style={{ minWidth: 140 }}>
      <option value="" disabled>{label}</option>
      {members.map((m) => (
        <option key={`${name}-${m.playerId}`} value={m.playerId}>{m.displayName}</option>
      ))}
    </select>
  );
}
