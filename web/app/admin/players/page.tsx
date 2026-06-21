import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import {
  loadAdminDivisionDetail,
  loadAdminPlayersDivisionView,
  loadAdminPlayersListView,
  loadPlayersPageNav,
  type AdminPlayersListSort,
} from "@/lib/loaders/admin";
import { tierColors } from "@/lib/tier-colors";
import { DiscordId } from "@/components/DiscordId";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { ConfirmButton } from "@/components/ConfirmButton";
import { MatchActionsPanel } from "@/components/MatchActionsPanel";
import { Button } from "@/components/ui/button";
import { FormSelect } from "@/components/FormSelect";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { addFakePlayer, deletePlayer, dropPlayer, movePlayer, refreshActiveSeasonMmrs, reinstatePlayer, setPlayerDiscordId, swapPlayers } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminPlayersPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string; division?: string; sort?: AdminPlayersListSort; swap?: string; swaperr?: string }>;
}) {
  await requireAdmin();
  const { season: seasonId, division: divisionId, sort = "name", swap, swaperr } = await searchParams;
  const nav = await loadPlayersPageNav({ seasonId, divisionId });
  // Divisions to offer in the per-row "set division" dropdown: the selected
  // season's if one's picked, otherwise the active season's — so a player who
  // never signed up can still be assigned (they only show in the no-season view).
  const divisionOptions = nav.divisionsInSelectedSeason.length > 0 ? nav.divisionsInSelectedSeason : nav.activeSeasonDivisions;

  // Mode A — division scoped
  if (nav.selectedDivision) {
    const view = await loadAdminPlayersDivisionView(nav.selectedDivision.id);
    const detail = await loadAdminDivisionDetail(nav.selectedDivision.id);
    if (!view || !detail) return null;
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
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {view.active.length === 0 ? (
                  <tr><td colSpan={7} className="muted">No active players in this division.</td></tr>
                ) : view.active.map((m) => (
                  <tr key={m.membershipId}>
                    <td style={{ width: 24 }}>{m.rank && m.rank <= 3 ? ["🥇", "🥈", "🥉"][m.rank - 1] : ""}</td>
                    <td>
                      <Link href={`/profile/${m.playerId}`} style={{ color: "var(--text)" }}>
                        <strong>{m.displayName}</strong>
                      </Link>
                      <DiscordId value={m.discordId} username={m.username} />
                    </td>
                    <td>{m.rank ?? "—"}</td>
                    <td><strong>{m.points}</strong></td>
                    <td>{m.wins}-{m.draws}-{m.losses}</td>
                    <td>{m.rating ?? <span className="muted">unranked</span>}</td>
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

          <MatchActionsPanel
            divisionId={detail.division.id}
            returnTo={`/admin/players?season=${detail.division.seasonId}&division=${detail.division.id}`}
            members={detail.members.filter((m) => m.status === "ACTIVE").map((m) => ({ playerId: m.playerId, displayName: m.player.displayName }))}
            unplayed={detail.unplayed.map((u) => ({ p1Id: u.a.id, p2Id: u.b.id }))}
            played={detail.pairings
              .filter((p) => p.status === "CONFIRMED")
              .map((p) => ({
                p1Id: p.playerAId,
                p2Id: p.playerBId,
                summary: p.gamesWonA === 0 && p.gamesWonB === 0 ? "0-0 void" : `${p.gamesWonA}-${p.gamesWonB}`,
              }))}
          />

          {view.inactive.length > 0 && (
            <details className="card">
              <summary style={{ cursor: "pointer" }}><strong>Inactive (dropped) — {view.inactive.length}</strong></summary>
              <table style={{ marginTop: 8 }}>
                <thead><tr><th>Player</th><th>Dropped</th><th></th></tr></thead>
                <tbody>
                  {view.inactive.map((m) => (
                    <tr key={m.membershipId}>
                      <td>
                        <Link href={`/profile/${m.playerId}`} style={{ color: "var(--text)" }}>
                          <s>{m.displayName}</s>
                        </Link>
                        <DiscordId value={m.discordId} username={m.username} />
                      </td>
                      <td className="muted">{m.droppedAt?.toISOString().slice(0, 10) ?? "—"}</td>
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
  // Players eligible to swap = currently in a division (and not dropped).
  const swappable = players.filter((p) => p.membership && !p.membership.dropped);

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/players" />
      <main>
        <PageHeader nav={nav} selectedSeasonId={seasonId} selectedDivisionId={divisionId} sort={sort} />

        {swap === "ok" && (
          <div className="card" style={{ borderColor: "#2ecc71", marginTop: 12 }}>
            <strong>✅ Players swapped — they&apos;ve traded divisions and schedules.</strong>
          </div>
        )}
        {swaperr && (
          <div className="card" style={{ borderColor: "#e74c3c", marginTop: 12 }}>
            <strong>⚠️ Couldn&apos;t swap:</strong> {swaperr}
          </div>
        )}

        {swappable.length >= 2 && (
          <div className="card" style={{ marginTop: 12 }}>
            <strong>Swap two players</strong>
            <p className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
              Trade two players between their divisions — each takes over the other&apos;s exact schedule, and
              nobody else&apos;s matchups change. Blocked if either player already has a reported result.
            </p>
            <form action={swapPlayers} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <input type="hidden" name="seasonParam" value={seasonId ?? ""} />
              <FormSelect
                name="playerAId"
                defaultValue=""
                options={[
                  { value: "", label: "— player A —" },
                  ...swappable.map((p) => ({ value: p.id, label: `${p.displayName} · ${p.membership!.divisionName}` })),
                ]}
              />
              <span className="muted">↔</span>
              <FormSelect
                name="playerBId"
                defaultValue=""
                options={[
                  { value: "", label: "— player B —" },
                  ...swappable.map((p) => ({ value: p.id, label: `${p.displayName} · ${p.membership!.divisionName}` })),
                ]}
              />
              <ConfirmButton
                message="Swap these two players between their divisions? They'll trade schedules entirely. Blocked if either already has a reported result."
                className="secondary"
                style={{ fontSize: 12 }}
              >
                Swap
              </ConfirmButton>
            </form>
          </div>
        )}

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
            Refreshes automatically every day at 12:00 UTC for current-season players. Click to
            refresh now — it fetches one player at a time, so a full season takes a few minutes.
          </p>
        </div>

        <div className="card">
          <strong>
            {players.length} player{players.length === 1 ? "" : "s"}
            {selectedSeasonName && <> in {selectedSeasonName}</>}
            {!selectedSeasonName && <> (active season only)</>}
          </strong>
          <table style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Rating</th>
                <th>Division</th>
                <th>Record / fix</th>
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
                    <DiscordId value={p.discordId} username={p.username} />
                  </td>
                  <td>{p.rating ?? <span className="muted">unranked</span>}</td>
                  <td>
                    {divisionOptions.length > 0 ? (
                      <form action={movePlayer} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        <input type="hidden" name="playerId" value={p.id} />
                        <FormSelect
                          name="divisionId"
                          defaultValue={p.membership?.divisionId ?? ""}
                          options={[
                            { value: "", label: "— none —" },
                            ...divisionOptions.map((d) => ({ value: d.id, label: d.name })),
                          ]}
                        />
                        <Button type="submit" variant="secondary" size="sm">Set</Button>
                        {p.membership?.dropped && <Badge variant="destructive">DROPPED</Badge>}
                      </form>
                    ) : p.membership ? (
                      <>
                        <Link href={`/admin/players?season=${p.membership.seasonId}&division=${p.membership.divisionId}`} style={{ textDecoration: "none" }}>
                          <TierPill name={p.membership.divisionName} position={p.membership.tierPosition} />
                        </Link>
                        {p.membership.dropped && <Badge variant="destructive" className="ml-1.5">DROPPED</Badge>}
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    {p.membership && !p.membership.dropped ? (
                      <Link href={`/profile/${p.id}`} style={{ fontSize: 12 }}>record / fix →</Link>
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
