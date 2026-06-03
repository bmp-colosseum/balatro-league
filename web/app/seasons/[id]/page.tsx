import Link from "next/link";
import { notFound } from "next/navigation";
import { hasTier } from "@/lib/admin";
import { loadSeasonDetail } from "@/lib/loaders/seasons";
import { SiteNav } from "@/components/SiteNav";
import { setFinalGlobalRank } from "./actions";

export const dynamic = "force-dynamic";

export default async function SeasonDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const { id } = await params;
  const { ok, err } = await searchParams;
  const season = await loadSeasonDetail(id);
  if (!season) notFound();
  const isAdmin = await hasTier("ADMIN");
  const isEnded = !season.isActive && season.endedAt != null;

  const period = season.endedAt
    ? `${season.startedAt.toISOString().slice(0, 10)} → ${season.endedAt.toISOString().slice(0, 10)}`
    : `Started ${season.startedAt.toISOString().slice(0, 10)}`;

  return (
    <>
      <SiteNav activePath="/seasons" />
      <main>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{season.name}</h2>
          {season.isActive ? (
            <span className="pill" style={{ background: "rgba(46,204,113,0.2)", color: "#2ecc71" }}>ACTIVE</span>
          ) : (
            <span className="pill" style={{ background: "rgba(149,165,166,0.2)", color: "#c0c8cb" }}>FINISHED</span>
          )}
          <span className="muted">· {period}</span>
          <Link href="/seasons" style={{ marginLeft: "auto" }}>← all seasons</Link>
        </div>

        {ok && (
          <div className="card" style={{ borderColor: "#2ecc71", color: "#2ecc71" }}>✓ Final rank updated.</div>
        )}
        {err && (
          <div className="card" style={{ borderColor: "#e74c3c", color: "#e74c3c" }}>{err}</div>
        )}
        {isEnded && isAdmin && (
          <p className="muted" style={{ fontSize: 12 }}>
            Admin: you can edit any player&apos;s final rank inline. If this is the most-recent ended
            season, the change also flows into the player&apos;s current rating used by the next
            season build.
          </p>
        )}

        {season.tiers.filter((t) => t.divisions.length > 0).map((tier) => (
          <section key={tier.id} style={{ marginTop: 24 }}>
            <h3>{tier.name}</h3>
            <div className="grid grid-2">
              {tier.divisions.map((div) => (
                <div key={div.id} className="card">
                  <strong>
                    <Link href={`/divisions/${div.id}`} style={{ textDecoration: "none" }}>{div.name}</Link>
                  </strong>
                  <div className="table-scroll" style={{ marginTop: 8 }}>
                  <table className="table-dense">
                    <thead>
                      <tr>
                        <th></th>
                        <th>Player</th>
                        {isEnded && (
                          <th title="Player&apos;s final league-wide rank at end of season (1 = best). Set by the end-season recompute.">Final rank</th>
                        )}
                        <th>Pts</th>
                        <th>W-D-L</th>
                        <th>Games</th>
                      </tr>
                    </thead>
                    <tbody>
                      {div.rows.length === 0 ? (
                        <tr><td colSpan={isEnded ? 6 : 5} className="muted">No matches played.</td></tr>
                      ) : (
                        div.rows.map((r, i) => {
                          const medal = i < 3 ? ["🥇", "🥈", "🥉"][i] : `${i + 1}.`;
                          const link = (
                            <Link href={`/profile/${r.player.id}`} style={{ color: "var(--text)" }}>
                              {r.player.displayName}
                            </Link>
                          );
                          return (
                            <tr key={r.player.id}>
                              <td>{medal}</td>
                              <td>{r.dropped ? <s>{link}</s> : link}</td>
                              {isEnded && (
                                <td>
                                  {isAdmin ? (
                                    <form action={setFinalGlobalRank} style={{ display: "flex", gap: 4 }}>
                                      <input type="hidden" name="seasonId" value={season.id} />
                                      <input type="hidden" name="playerId" value={r.player.id} />
                                      <input
                                        type="number"
                                        name="rank"
                                        defaultValue={r.finalGlobalRank ?? ""}
                                        min={1}
                                        placeholder="—"
                                        style={{ width: 60, fontSize: 12, padding: "1px 4px" }}
                                      />
                                      <button type="submit" className="secondary" style={{ fontSize: 11, padding: "1px 6px" }}>Save</button>
                                    </form>
                                  ) : (
                                    <span className="muted">{r.finalGlobalRank != null ? `#${r.finalGlobalRank}` : "—"}</span>
                                  )}
                                </td>
                              )}
                              <td><strong>{r.points}</strong></td>
                              <td>{r.wins}-{r.draws}-{r.losses}</td>
                              <td>{r.gamesWon}-{r.gamesLost}</td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </main>
    </>
  );
}
