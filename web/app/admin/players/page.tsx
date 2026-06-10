import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import {
  loadAdminPlayersDivisionView,
  loadAdminPlayersListView,
  loadPlayersPageNav,
  type AdminPlayersListSort,
} from "@/lib/loaders/admin";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { ConfirmButton } from "@/components/ConfirmButton";
import { addFakePlayer, deletePlayer, dropPlayer, recordSetForPlayer, refreshActiveSeasonMmrs, reinstatePlayer, setPlayerDiscordId } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminPlayersPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string; division?: string; sort?: AdminPlayersListSort }>;
}) {
  await requireAdmin();
  const { season: seasonId, division: divisionId, sort = "name" } = await searchParams;
  const nav = await loadPlayersPageNav({ seasonId, divisionId });

  // Mode A — division scoped
  if (nav.selectedDivision) {
    const view = await loadAdminPlayersDivisionView(nav.selectedDivision.id);
    if (!view) return null;
    return (
      <>
        <SiteNav activePath="/admin" />
        <AdminNav activePath="/admin/players" />
        <main>
          <PageHeader nav={nav} selectedSeasonId={seasonId} selectedDivisionId={divisionId} sort={sort} />
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 12 }}>
            <h3 style={{ margin: 0 }}>
              <Link href={`/divisions/${view.division.id}`} style={{ textDecoration: "none" }}>{view.division.name}</Link>
            </h3>
            <span className="muted" style={{ fontSize: 12 }}>
              tier {view.division.tierPosition} ({view.division.tierName}) · {view.division.seasonName}
            </span>
            <Link href={`/divisions/${view.division.id}`} style={{ marginLeft: "auto", fontSize: 12 }}>
              full division page →
            </Link>
          </div>
          <div className="card">
            <strong>Active players ({view.active.length})</strong>
            <table style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th></th>
                  <th>Player</th>
                  <th>Rank</th>
                  <th>Pts</th>
                  <th>W-D-L</th>
                  <th>Rating</th>
                  <th>Record/override result</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {view.active.length === 0 ? (
                  <tr><td colSpan={8} className="muted">No active players in this division.</td></tr>
                ) : view.active.map((m) => (
                  <tr key={m.membershipId}>
                    <td style={{ width: 24 }}>{m.rank && m.rank <= 3 ? ["🥇", "🥈", "🥉"][m.rank - 1] : ""}</td>
                    <td>
                      <Link href={`/profile/${m.playerId}`} style={{ color: "var(--text)" }}>
                        <strong>{m.displayName}</strong>
                      </Link>
                      <div className="muted" style={{ fontSize: 10 }}>{m.discordId}</div>
                    </td>
                    <td>{m.rank ?? "—"}</td>
                    <td><strong>{m.points}</strong></td>
                    <td>{m.wins}-{m.draws}-{m.losses}</td>
                    <td>{m.rating ?? <span className="muted">unranked</span>}</td>
                    <td>
                      <form action={recordSetForPlayer} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        <input type="hidden" name="divisionId" value={view.division.id} />
                        <input type="hidden" name="playerId" value={m.playerId} />
                        <span className="muted" style={{ fontSize: 11 }}>vs</span>
                        <select name="opponentId" required style={{ fontSize: 11, maxWidth: 140 }}>
                          <option value="">—</option>
                          {m.unplayedOpponents.map((o) => (
                            <option key={o.playerId} value={o.playerId}>{o.displayName}</option>
                          ))}
                        </select>
                        <select name="result" defaultValue="2-0" style={{ fontSize: 11 }}>
                          <option value="2-0">2-0 (won)</option>
                          <option value="1-1">1-1</option>
                          <option value="0-2">0-2 (lost)</option>
                        </select>
                        <button type="submit" className="secondary" style={{ fontSize: 11 }}>Record</button>
                      </form>
                    </td>
                    <td>
                      <form action={dropPlayer} style={{ display: "inline-block" }}>
                        <input type="hidden" name="playerId" value={m.playerId} />
                        <ConfirmButton
                          message={`Drop ${m.displayName} from this division? Their unplayed matches here will be removed. You can reinstate them afterward.`}
                          className="secondary"
                          style={{ fontSize: 11 }}
                        >
                          Drop
                        </ConfirmButton>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {view.inactive.length > 0 && (
            <details className="card">
              <summary style={{ cursor: "pointer" }}><strong>Inactive (dropped) — {view.inactive.length}</strong></summary>
              <table style={{ marginTop: 8 }}>
                <thead><tr><th>Player</th><th>Dropped</th><th>Discord</th><th></th></tr></thead>
                <tbody>
                  {view.inactive.map((m) => (
                    <tr key={m.membershipId}>
                      <td>
                        <Link href={`/profile/${m.playerId}`} style={{ color: "var(--text)" }}>
                          <s>{m.displayName}</s>
                        </Link>
                      </td>
                      <td className="muted">{m.droppedAt?.toISOString().slice(0, 10) ?? "—"}</td>
                      <td><span className="muted" style={{ fontSize: 11 }}>{m.discordId}</span></td>
                      <td>
                        <form action={reinstatePlayer} style={{ display: "inline-block" }}>
                          <input type="hidden" name="playerId" value={m.playerId} />
                          <button type="submit" className="secondary" style={{ fontSize: 11 }}>Reinstate</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </main>
      </>
    );
  }

  // Mode B — no division selected
  const players = await loadAdminPlayersListView({ seasonId, sort });
  const selectedSeasonName = nav.seasons.find((s) => s.id === seasonId)?.name;

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/players" />
      <main>
        <PageHeader nav={nav} selectedSeasonId={seasonId} selectedDivisionId={divisionId} sort={sort} />

        <div className="card" style={{ marginTop: 12 }}>
          <strong>Add fake player</strong>
          <p className="muted" style={{ fontSize: 12 }}>For testing without real Discord accounts.</p>
          <form action={addFakePlayer} style={{ display: "flex", gap: 6 }}>
            <input name="name" required placeholder="Alice" />
            <select name="divisionId" defaultValue="">
              <option value="">— unassigned —</option>
              {nav.divisionsInSelectedSeason.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
            <button type="submit">Add</button>
          </form>
        </div>

        <div className="card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <strong>BMP MMR snapshots</strong>
            <form action={refreshActiveSeasonMmrs}>
              <button type="submit" className="secondary" style={{ fontSize: 12 }}>
                Refresh BMP MMRs (active season)
              </button>
            </form>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
            Auto-refreshes daily @ 12:00 UTC for current-season players. Click for an on-demand
            refresh — fans out a snapshot job per player, drains at ~1 req/3sec, so a full season
            takes a few minutes.
          </p>
        </div>

        <div className="card">
          <strong>
            {players.length} player(s)
            {selectedSeasonName && <> in {selectedSeasonName}</>}
            {!selectedSeasonName && <> (active season only)</>}
          </strong>
          <table style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Rating</th>
                <th>Division</th>
                <th>Record match</th>
                <th>Discord</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {players.length === 0 ? (
                <tr><td colSpan={6} className="muted">No players match.</td></tr>
              ) : players.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/profile/${p.id}`} style={{ color: "var(--text)" }}>
                      <strong>{p.displayName}</strong>
                    </Link>
                  </td>
                  <td>{p.rating ?? <span className="muted">unranked</span>}</td>
                  <td>
                    {p.membership ? (
                      <>
                        <Link href={`/admin/players?season=${p.membership.seasonId}&division=${p.membership.divisionId}`} style={{ textDecoration: "none" }}>
                          <TierPill name={p.membership.divisionName} position={p.membership.tierPosition} />
                        </Link>
                        {p.membership.dropped && (
                          <span className="pill" style={{ background: "rgba(231,76,60,0.2)", color: "#e74c3c", marginLeft: 6 }}>DROPPED</span>
                        )}
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    {p.membership && !p.membership.dropped && p.membership.unplayedOpponents.length > 0 ? (
                      <form action={recordSetForPlayer} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        <input type="hidden" name="divisionId" value={p.membership.divisionId} />
                        <input type="hidden" name="playerId" value={p.id} />
                        <span className="muted" style={{ fontSize: 11 }}>vs</span>
                        <select name="opponentId" required style={{ fontSize: 11, maxWidth: 140 }}>
                          <option value="">—</option>
                          {p.membership.unplayedOpponents.map((o) => (
                            <option key={o.playerId} value={o.playerId}>{o.displayName}</option>
                          ))}
                        </select>
                        <select name="result" defaultValue="2-0" style={{ fontSize: 11 }}>
                          <option value="2-0">2-0</option>
                          <option value="1-1">1-1</option>
                          <option value="0-2">0-2</option>
                        </select>
                        <button type="submit" className="secondary" style={{ fontSize: 11 }}>Record</button>
                      </form>
                    ) : (
                      <span className="muted" style={{ fontSize: 11 }}>—</span>
                    )}
                  </td>
                  <td>
                    <form action={setPlayerDiscordId} style={{ display: "flex", gap: 4 }}>
                      <input type="hidden" name="playerId" value={p.id} />
                      <input
                        type="text"
                        name="discordId"
                        defaultValue={p.discordId}
                        pattern="\d{17,20}"
                        title="17-20 digits"
                        style={{ fontSize: 11, width: 170, fontFamily: "ui-monospace, monospace" }}
                      />
                      <button type="submit" className="secondary" style={{ fontSize: 11 }}>Save</button>
                    </form>
                  </td>
                  <td>
                    <form action={deletePlayer}>
                      <input type="hidden" name="playerId" value={p.id} />
                      <ConfirmButton
                        message={`Permanently delete ${p.displayName}? This removes the player and ALL their match history across every season. This cannot be undone.`}
                        className="secondary"
                        style={{ fontSize: 11, color: "#e74c3c" }}
                      >
                        Delete
                      </ConfirmButton>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}

function PageHeader({
  nav,
  selectedSeasonId,
  selectedDivisionId,
  sort,
}: {
  nav: { seasons: Array<{ id: string; name: string; isActive: boolean }>; divisionsInSelectedSeason: Array<{ id: string; name: string }> };
  selectedSeasonId?: string;
  selectedDivisionId?: string;
  sort: AdminPlayersListSort;
}) {
  return (
    <>
      <h2>Players</h2>
      <div className="card" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <form method="get" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <strong>Season:</strong>
            <select name="season" defaultValue={selectedSeasonId ?? ""}>
              <option value="">— pick a season —</option>
              {nav.seasons.map((s) => (
                <option key={s.id} value={s.id}>{s.name}{s.isActive ? " (active)" : ""}</option>
              ))}
            </select>
          </label>
          {selectedSeasonId && (
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <strong>Division:</strong>
              <select name="division" defaultValue={selectedDivisionId ?? ""}>
                <option value="">— all in season —</option>
                {nav.divisionsInSelectedSeason.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </label>
          )}
          {!selectedDivisionId && (
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <strong>Sort:</strong>
              <select name="sort" defaultValue={sort}>
                <option value="name">Name (A-Z)</option>
                <option value="rating-desc">Rating (high → low)</option>
                <option value="rating-asc">Rating (low → high)</option>
                <option value="ranked-only">Ranked only</option>
                <option value="unranked-only">Unranked only</option>
              </select>
            </label>
          )}
          <button type="submit" className="secondary">Apply</button>
          {(selectedSeasonId || selectedDivisionId) && (
            <Link href="/admin/players" style={{ fontSize: 12 }}>clear</Link>
          )}
        </form>
      </div>
    </>
  );
}

function TierPill({ name, position }: { name: string; position: number }) {
  const c = tierColors(position);
  return <span className="pill" style={{ background: c.bg, color: c.fg }}>{name}</span>;
}
