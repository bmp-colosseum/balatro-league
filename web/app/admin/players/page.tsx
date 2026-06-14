import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import {
  loadAdminPlayersDivisionView,
  loadAdminPlayersListView,
  loadPlayersPageNav,
  type AdminPlayersListSort,
} from "@/lib/loaders/admin";
import { tierColors } from "@/lib/tier-colors";
import { getShowDiscordIds } from "@/lib/preferences";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Button } from "@/components/ui/button";
import { FormSelect } from "@/components/FormSelect";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { addFakePlayer, deletePlayer, dropPlayer, recordSetForPlayer, refreshActiveSeasonMmrs, reinstatePlayer, setPlayerDiscordId } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminPlayersPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string; division?: string; sort?: AdminPlayersListSort }>;
}) {
  await requireAdmin();
  const { season: seasonId, division: divisionId, sort = "name" } = await searchParams;
  const showDiscordIds = await getShowDiscordIds();
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
                      {showDiscordIds && <div className="muted" style={{ fontSize: 10 }}>{m.discordId}</div>}
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
                        <FormSelect
                          name="opponentId"
                          required
                          size="sm"
                          triggerClassName="max-w-[140px]"
                          placeholder="—"
                          options={m.unplayedOpponents.map((o) => ({ value: o.playerId, label: o.displayName }))}
                        />
                        <FormSelect
                          name="result"
                          defaultValue="2-0"
                          size="sm"
                          options={[
                            { value: "2-0", label: "2-0 (won)" },
                            { value: "1-1", label: "1-1" },
                            { value: "0-2", label: "0-2 (lost)" },
                          ]}
                        />
                        <Button type="submit" variant="secondary" size="sm">Record</Button>
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
                <thead><tr><th>Player</th><th>Dropped</th>{showDiscordIds && <th>Discord</th>}<th></th></tr></thead>
                <tbody>
                  {view.inactive.map((m) => (
                    <tr key={m.membershipId}>
                      <td>
                        <Link href={`/profile/${m.playerId}`} style={{ color: "var(--text)" }}>
                          <s>{m.displayName}</s>
                        </Link>
                      </td>
                      <td className="muted">{m.droppedAt?.toISOString().slice(0, 10) ?? "—"}</td>
                      {showDiscordIds && <td><span className="muted" style={{ fontSize: 11 }}>{m.discordId}</span></td>}
                      <td>
                        <form action={reinstatePlayer} style={{ display: "inline-block" }}>
                          <input type="hidden" name="playerId" value={m.playerId} />
                          <Button type="submit" variant="secondary" size="sm">Reinstate</Button>
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
            <Input name="name" required placeholder="Alice" className="max-w-40" />
            <FormSelect
              name="divisionId"
              defaultValue=""
              options={[
                { value: "", label: "— unassigned —" },
                ...nav.divisionsInSelectedSeason.map((d) => ({ value: d.id, label: d.name })),
              ]}
            />
            <Button type="submit">Add</Button>
          </form>
        </div>

        <div className="card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <strong>BMP MMR snapshots</strong>
            <form action={refreshActiveSeasonMmrs}>
              <Button type="submit" variant="secondary" size="sm">Refresh BMP MMRs (active season)</Button>
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
                          <Badge variant="destructive" className="ml-1.5">DROPPED</Badge>
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
                        <FormSelect
                          name="opponentId"
                          required
                          size="sm"
                          triggerClassName="max-w-[140px]"
                          placeholder="—"
                          options={p.membership.unplayedOpponents.map((o) => ({ value: o.playerId, label: o.displayName }))}
                        />
                        <FormSelect
                          name="result"
                          defaultValue="2-0"
                          size="sm"
                          options={[
                            { value: "2-0", label: "2-0" },
                            { value: "1-1", label: "1-1" },
                            { value: "0-2", label: "0-2" },
                          ]}
                        />
                        <Button type="submit" variant="secondary" size="sm">Record</Button>
                      </form>
                    ) : (
                      <span className="muted" style={{ fontSize: 11 }}>—</span>
                    )}
                  </td>
                  <td>
                    <form action={setPlayerDiscordId} style={{ display: "flex", gap: 4 }}>
                      <input type="hidden" name="playerId" value={p.id} />
                      <Input
                        type="text"
                        name="discordId"
                        defaultValue={p.discordId}
                        pattern="\d{17,20}"
                        title="17-20 digits"
                        className="w-44 font-mono"
                      />
                      <Button type="submit" variant="secondary" size="sm">Save</Button>
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
            <FormSelect
              name="season"
              defaultValue={selectedSeasonId ?? ""}
              placeholder="— pick a season —"
              options={nav.seasons.map((s) => ({ value: s.id, label: `${s.name}${s.isActive ? " (active)" : ""}` }))}
            />
          </label>
          {selectedSeasonId && (
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <strong>Division:</strong>
              <FormSelect
                name="division"
                defaultValue={selectedDivisionId ?? ""}
                options={[
                  { value: "", label: "— all in season —" },
                  ...nav.divisionsInSelectedSeason.map((d) => ({ value: d.id, label: d.name })),
                ]}
              />
            </label>
          )}
          {!selectedDivisionId && (
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <strong>Sort:</strong>
              <FormSelect
                name="sort"
                defaultValue={sort}
                options={[
                  { value: "name", label: "Name (A-Z)" },
                  { value: "rating-desc", label: "Rating (high → low)" },
                  { value: "rating-asc", label: "Rating (low → high)" },
                  { value: "ranked-only", label: "Ranked only" },
                  { value: "unranked-only", label: "Unranked only" },
                ]}
              />
            </label>
          )}
          <Button type="submit" variant="secondary">Apply</Button>
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
