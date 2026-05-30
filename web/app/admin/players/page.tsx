import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { isMockPlayer } from "@/lib/mock";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { addFakePlayer, movePlayer, dropPlayer, reinstatePlayer, deletePlayer } from "./actions";

export const dynamic = "force-dynamic";

type Filter = "all" | "real" | "fake" | "unassigned" | "dropped";

export default async function AdminPlayersPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: Filter }>;
}) {
  await requireAdmin();
  const { filter = "all" } = await searchParams;

  // Pull divisions from every non-ended season so admin can place into INTERNAL
  // / inactive seasons too — not just the live one.
  const seasonsWithDivisions = await prisma.season.findMany({
    where: { endedAt: null },
    include: {
      tiers: { orderBy: { position: "asc" }, include: { divisions: { orderBy: { groupNumber: "asc" } } } },
    },
    orderBy: [{ isActive: "desc" }, { startedAt: "desc" }],
  });
  // Flat list of {id, label} where label is "Season name · Division name"
  const divisionOptions = seasonsWithDivisions.flatMap((s) =>
    s.tiers.flatMap((t) => t.divisions.map((d) => ({ id: d.id, label: `${s.name} · ${d.name}` }))),
  );
  const activeSeason = seasonsWithDivisions.find((s) => s.isActive) ?? null;

  const allPlayers = await prisma.player.findMany({
    include: {
      memberships: {
        where: { division: { season: { isActive: true } } },
        include: { division: { include: { tier: true } } },
      },
    },
    orderBy: { displayName: "asc" },
  });

  let players = allPlayers;
  if (filter === "real") players = players.filter((p) => !isMockPlayer(p));
  else if (filter === "fake") players = players.filter((p) => isMockPlayer(p));
  else if (filter === "unassigned") players = players.filter((p) => p.memberships.length === 0);
  else if (filter === "dropped") players = players.filter((p) => p.memberships.some((m) => m.status === "DROPPED"));

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/players" />
      <main>
        <h2>Players</h2>

        <div className="card">
          <strong>Add fake player</strong>
          <p className="muted">For testing without real Discord accounts.</p>
          <form action={addFakePlayer}>
            <label>
              Name
              <input name="name" required placeholder="Alice" />
            </label>
            <label>
              Division (optional)
              <select name="divisionId">
                <option value="">— unassigned —</option>
                {divisionOptions.map((d) => (
                  <option key={d.id} value={d.id}>{d.label}</option>
                ))}
              </select>
            </label>
            <button type="submit">Add fake player</button>
          </form>
        </div>

        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <strong>{players.length} player(s)</strong>
            <span style={{ marginLeft: "auto" }}>
              <Link href="/admin/players?filter=all">All</Link>
              {" · "}
              <Link href="/admin/players?filter=real">Real</Link>
              {" · "}
              <Link href="/admin/players?filter=fake">Fake</Link>
              {" · "}
              <Link href="/admin/players?filter=unassigned">Unassigned</Link>
              {" · "}
              <Link href="/admin/players?filter=dropped">Dropped</Link>
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Discord ID</th>
                <th>Division</th>
                <th>Move to</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {players.length === 0 ? (
                <tr><td colSpan={7} className="muted">No players match.</td></tr>
              ) : (
                players.map((p) => {
                  const isFake = isMockPlayer(p);
                  const membership = p.memberships[0];
                  const currentDiv = membership?.division;
                  const isDropped = membership?.status === "DROPPED";
                  return (
                    <tr key={p.id}>
                      <td><strong>{p.displayName}</strong></td>
                      <td>
                        {isFake ? (
                          <span className="pill" style={{ background: "rgba(241,196,15,0.15)", color: "#f1c40f" }}>FAKE</span>
                        ) : (
                          <span className="pill" style={{ background: "rgba(46,204,113,0.15)", color: "#2ecc71" }}>REAL</span>
                        )}
                      </td>
                      <td><span className="muted">{p.discordId}</span></td>
                      <td>
                        {currentDiv ? (
                          <>
                            <TierPill name={currentDiv.name} position={currentDiv.tier.position} />
                            {isDropped && (
                              <span className="pill" style={{ background: "rgba(231,76,60,0.2)", color: "#e74c3c", marginLeft: 6 }}>DROPPED</span>
                            )}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <form action={movePlayer} style={{ display: "flex", gap: 4 }}>
                          <input type="hidden" name="playerId" value={p.id} />
                          <select name="divisionId" defaultValue={currentDiv?.id ?? ""}>
                            <option value="">— remove —</option>
                            {divisionOptions.map((d) => (
                              <option key={d.id} value={d.id}>{d.label}</option>
                            ))}
                          </select>
                          <button type="submit">Apply</button>
                        </form>
                      </td>
                      <td>
                        {currentDiv ? (
                          isDropped ? (
                            <form action={reinstatePlayer}>
                              <input type="hidden" name="playerId" value={p.id} />
                              <button type="submit" className="secondary">Reinstate</button>
                            </form>
                          ) : (
                            <form action={dropPlayer}>
                              <input type="hidden" name="playerId" value={p.id} />
                              <button type="submit" className="secondary">Drop</button>
                            </form>
                          )
                        ) : null}
                      </td>
                      <td>
                        <form action={deletePlayer}>
                          <input type="hidden" name="playerId" value={p.id} />
                          <button type="submit" className="danger">Delete</button>
                        </form>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}

function TierPill({ name, position }: { name: string; position: number }) {
  const c = tierColors(position);
  return <span className="pill" style={{ background: c.bg, color: c.fg }}>{name}</span>;
}
