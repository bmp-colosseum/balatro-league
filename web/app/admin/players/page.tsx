import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { tierColors } from "@/lib/tier-colors";
import { computeStandings } from "@/lib/standings";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { addFakePlayer, deletePlayer, dropPlayer, reinstatePlayer } from "./actions";

export const dynamic = "force-dynamic";

type Sort = "name" | "rating-desc" | "rating-asc" | "ranked-only" | "unranked-only";

export default async function AdminPlayersPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string; division?: string; sort?: Sort }>;
}) {
  await requireAdmin();
  const { season: seasonId, division: divisionId, sort = "name" } = await searchParams;

  // Season + division pickers
  const seasons = await prisma.season.findMany({
    where: { endedAt: null },
    include: {
      tiers: { orderBy: { position: "asc" }, include: { divisions: { orderBy: { groupNumber: "asc" } } } },
    },
    orderBy: [{ isActive: "desc" }, { startedAt: "desc" }],
  });
  const selectedSeason = seasonId ? seasons.find((s) => s.id === seasonId) : null;
  const divisionsInSeason = selectedSeason
    ? selectedSeason.tiers.flatMap((t) => t.divisions.map((d) => ({ id: d.id, name: d.name, tierPosition: t.position, tierName: t.name })))
    : [];
  const selectedDivisionMeta = divisionId ? divisionsInSeason.find((d) => d.id === divisionId) : null;

  // Mode A — division scoped: show active + inactive sections with actions
  if (selectedDivisionMeta) {
    const division = await prisma.division.findUnique({
      where: { id: selectedDivisionMeta.id },
      include: {
        season: true,
        tier: true,
        members: { include: { player: true } },
        pairings: { where: { status: "CONFIRMED" } },
      },
    });
    if (!division) return null;

    const standings = computeStandings(
      division.members.map((m) => m.player),
      division.pairings.map((p) => ({ playerAId: p.playerAId, playerBId: p.playerBId, gamesWonA: p.gamesWonA, gamesWonB: p.gamesWonB })),
    );
    const standingByPlayer = new Map(standings.map((r, i) => [r.player.id, { rank: i + 1, points: r.points, wins: r.wins, draws: r.draws, losses: r.losses }]));

    const active = division.members.filter((m) => m.status === "ACTIVE");
    const inactive = division.members.filter((m) => m.status === "DROPPED");

    return (
      <>
        <SiteNav activePath="/admin" />
        <AdminNav activePath="/admin/players" />
        <main>
          <PageHeader seasons={seasons} selectedSeasonId={seasonId} divisionsInSeason={divisionsInSeason} selectedDivisionId={divisionId} sort={sort} />

          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 12 }}>
            <h3 style={{ margin: 0 }}>
              <Link href={`/admin/divisions/${division.id}`} style={{ textDecoration: "none" }}>{division.name}</Link>
            </h3>
            <span className="muted" style={{ fontSize: 12 }}>
              tier {division.tier.position} ({division.tier.name}) · {division.season.name}
            </span>
            <Link href={`/admin/divisions/${division.id}`} style={{ marginLeft: "auto", fontSize: 12 }}>
              full division page →
            </Link>
          </div>

          <div className="card">
            <strong>Active players ({active.length})</strong>
            <table style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th></th>
                  <th>Player</th>
                  <th>Rank</th>
                  <th>Pts</th>
                  <th>W-D-L</th>
                  <th>Rating</th>
                  <th>Discord</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {active.length === 0 ? (
                  <tr><td colSpan={8} className="muted">No active players in this division.</td></tr>
                ) : active.map((m) => {
                  const s = standingByPlayer.get(m.playerId);
                  return (
                    <tr key={m.id}>
                      <td style={{ width: 24 }}>{s && s.rank <= 3 ? ["🥇", "🥈", "🥉"][s.rank - 1] : ""}</td>
                      <td>
                        <Link href={`/profile/${m.player.id}`} style={{ color: "var(--text)" }}>
                          <strong>{m.player.displayName}</strong>
                        </Link>
                      </td>
                      <td>{s?.rank ?? "—"}</td>
                      <td><strong>{s?.points ?? 0}</strong></td>
                      <td>{s ? `${s.wins}-${s.draws}-${s.losses}` : "—"}</td>
                      <td>{m.player.rating ?? <span className="muted">unranked</span>}</td>
                      <td><span className="muted" style={{ fontSize: 11 }}>{m.player.discordId}</span></td>
                      <td>
                        <form action={dropPlayer} style={{ display: "inline-block" }}>
                          <input type="hidden" name="playerId" value={m.player.id} />
                          <button type="submit" className="secondary" style={{ fontSize: 11 }}>Drop</button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {inactive.length > 0 && (
            <details className="card">
              <summary style={{ cursor: "pointer" }}><strong>Inactive (dropped) — {inactive.length}</strong></summary>
              <table style={{ marginTop: 8 }}>
                <thead><tr><th>Player</th><th>Dropped</th><th>Discord</th><th></th></tr></thead>
                <tbody>
                  {inactive.map((m) => (
                    <tr key={m.id}>
                      <td><s>{m.player.displayName}</s></td>
                      <td className="muted">{m.droppedAt?.toISOString().slice(0, 10) ?? "—"}</td>
                      <td><span className="muted" style={{ fontSize: 11 }}>{m.player.discordId}</span></td>
                      <td>
                        <form action={reinstatePlayer} style={{ display: "inline-block" }}>
                          <input type="hidden" name="playerId" value={m.player.id} />
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

  // Mode B — no division selected: all-players list with rating sort
  const playersAll = await prisma.player.findMany({
    include: {
      memberships: {
        where: selectedSeason
          ? { division: { seasonId: selectedSeason.id } }
          : { division: { season: { isActive: true } } },
        include: { division: { include: { tier: true } } },
      },
    },
  });
  let players = playersAll;
  if (selectedSeason) {
    players = players.filter((p) => p.memberships.length > 0);
  }
  if (sort === "ranked-only") players = players.filter((p) => p.rating != null);
  if (sort === "unranked-only") players = players.filter((p) => p.rating == null);
  if (sort === "rating-desc") players.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || a.displayName.localeCompare(b.displayName));
  else if (sort === "rating-asc") players.sort((a, b) => (a.rating ?? -1) - (b.rating ?? -1) || a.displayName.localeCompare(b.displayName));
  else players.sort((a, b) => a.displayName.localeCompare(b.displayName));

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/players" />
      <main>
        <PageHeader seasons={seasons} selectedSeasonId={seasonId} divisionsInSeason={divisionsInSeason} selectedDivisionId={divisionId} sort={sort} />

        <div className="card" style={{ marginTop: 12 }}>
          <strong>Add fake player</strong>
          <p className="muted" style={{ fontSize: 12 }}>For testing without real Discord accounts.</p>
          <form action={addFakePlayer} style={{ display: "flex", gap: 6 }}>
            <input name="name" required placeholder="Alice" />
            <select name="divisionId" defaultValue="">
              <option value="">— unassigned —</option>
              {divisionsInSeason.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
            <button type="submit">Add</button>
          </form>
        </div>

        <div className="card">
          <strong>
            {players.length} player(s)
            {selectedSeason && <> in {selectedSeason.name}</>}
            {!selectedSeason && <> (active season only)</>}
          </strong>
          <table style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Rating</th>
                <th>Division</th>
                <th>Discord</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {players.length === 0 ? (
                <tr><td colSpan={5} className="muted">No players match.</td></tr>
              ) : players.map((p) => {
                const membership = p.memberships[0];
                const div = membership?.division;
                const isDropped = membership?.status === "DROPPED";
                return (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/profile/${p.id}`} style={{ color: "var(--text)" }}>
                        <strong>{p.displayName}</strong>
                      </Link>
                    </td>
                    <td>{p.rating ?? <span className="muted">unranked</span>}</td>
                    <td>
                      {div ? (
                        <>
                          <Link href={`/admin/players?season=${div.seasonId}&division=${div.id}`} style={{ textDecoration: "none" }}>
                            <TierPill name={div.name} position={div.tier.position} />
                          </Link>
                          {isDropped && (
                            <span className="pill" style={{ background: "rgba(231,76,60,0.2)", color: "#e74c3c", marginLeft: 6 }}>DROPPED</span>
                          )}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td><span className="muted" style={{ fontSize: 11 }}>{p.discordId}</span></td>
                    <td>
                      <form action={deletePlayer}>
                        <input type="hidden" name="playerId" value={p.id} />
                        <button type="submit" className="secondary" style={{ fontSize: 11, color: "#e74c3c" }}>Delete</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}

function PageHeader({
  seasons,
  selectedSeasonId,
  divisionsInSeason,
  selectedDivisionId,
  sort,
}: {
  seasons: Array<{ id: string; name: string; isActive: boolean }>;
  selectedSeasonId?: string;
  divisionsInSeason: Array<{ id: string; name: string; tierPosition: number }>;
  selectedDivisionId?: string;
  sort: Sort;
}) {
  return (
    <>
      <h2>Players</h2>
      <div className="card" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <form method="get" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <strong>Season:</strong>
            <select name="season" defaultValue={selectedSeasonId ?? ""} onChange={undefined}>
              <option value="">— pick a season —</option>
              {seasons.map((s) => (
                <option key={s.id} value={s.id}>{s.name}{s.isActive ? " (active)" : ""}</option>
              ))}
            </select>
          </label>
          {selectedSeasonId && (
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <strong>Division:</strong>
              <select name="division" defaultValue={selectedDivisionId ?? ""}>
                <option value="">— all in season —</option>
                {divisionsInSeason.map((d) => (
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
