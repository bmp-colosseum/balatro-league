import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { computeStandings } from "@/lib/standings";
import { tierColors } from "@/lib/tier-colors";
import { isMockPlayer } from "@/lib/mock";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { addDivisionMemberByDiscordId, recordSet, overridePairing, deletePairing } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminDivisionDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ err?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const { err } = await searchParams;

  const division = await prisma.division.findUnique({
    where: { id },
    include: {
      season: true,
      tier: true,
      members: { include: { player: true }, orderBy: { joinedAt: "asc" } },
      pairings: {
        include: { playerA: true, playerB: true },
        orderBy: [{ status: "asc" }, { reportedAt: "desc" }],
      },
    },
  });
  if (!division) notFound();

  const droppedIds = new Set(division.members.filter((m) => m.status === "DROPPED").map((m) => m.playerId));
  const confirmedPairings = division.pairings.filter((p) => p.status === "CONFIRMED");
  const rows = computeStandings(
    division.members.map((m) => m.player),
    confirmedPairings.map((p) => ({
      playerAId: p.playerAId,
      playerBId: p.playerBId,
      gamesWonA: p.gamesWonA,
      gamesWonB: p.gamesWonB,
    })),
  ).map((r) => ({ ...r, dropped: droppedIds.has(r.player.id) }));

  // Unplayed matchups: active members with no Pairing row yet
  const activeMembers = division.members.filter((m) => m.status === "ACTIVE");
  const playedKey = (a: string, b: string) => {
    const [x, y] = a < b ? [a, b] : [b, a];
    return `${x}-${y}`;
  };
  const playedSet = new Set(division.pairings.map((p) => playedKey(p.playerAId, p.playerBId)));
  const unplayed: Array<{ a: typeof activeMembers[number]["player"]; b: typeof activeMembers[number]["player"] }> = [];
  for (let i = 0; i < activeMembers.length; i++) {
    for (let j = i + 1; j < activeMembers.length; j++) {
      const a = activeMembers[i]!.player;
      const b = activeMembers[j]!.player;
      if (!playedSet.has(playedKey(a.id, b.id))) unplayed.push({ a, b });
    }
  }

  const tierColor = tierColors(division.tier.position);

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/divisions" />
      <main>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{division.name}</h2>
          <span className="pill" style={{ background: tierColor.bg, color: tierColor.fg }}>{division.tier.name}</span>
          <span className="muted">· {division.season.name}</span>
          <Link href="/admin/divisions" style={{ marginLeft: "auto" }}>← All divisions</Link>
        </div>
        <div className="muted" style={{ marginBottom: 16 }}>
          Round-robin best-of-2 · 3 pts for 2-0, 1 pt each for 1-1, 0 for 0-2
        </div>

        {err && (
          <div className="card" style={{ borderColor: "#e74c3c", color: "#e74c3c" }}>
            {err}
          </div>
        )}

        <div className="card">
          <strong>Add player by Discord ID</strong>
          <p className="muted">
            Mid-season add — looks up the member's guild display name; you can override.
            If this division has a Discord role set up, the new player will also be
            granted the role (and channel access).
          </p>
          <form action={addDivisionMemberByDiscordId} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <input type="hidden" name="divisionId" value={division.id} />
            <input
              type="text"
              name="discordId"
              placeholder="Discord ID (17-20 digits)"
              required
              pattern="\d{17,20}"
              style={{ flex: "1 1 200px" }}
            />
            <input
              type="text"
              name="displayName"
              placeholder="Display name override (optional)"
              style={{ flex: "1 1 200px" }}
            />
            <button type="submit">Add to division</button>
          </form>
        </div>

        {/* Standings */}
        <div className="card">
          <strong>Standings ({rows.length})</strong>
          <table>
            <thead>
              <tr><th></th><th>Player</th><th>Pts</th><th>W-D-L</th><th>Games</th><th>Played</th></tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={6} className="muted">No confirmed sets yet.</td></tr>
              ) : rows.map((r, i) => {
                const medal = i < 3 ? ["🥇", "🥈", "🥉"][i] : `${i + 1}.`;
                return (
                  <tr key={r.player.id}>
                    <td>{medal}</td>
                    <td>{r.dropped ? <s>{r.player.displayName}</s> : r.player.displayName}{r.dropped && <span className="muted"> (dropped)</span>}</td>
                    <td><strong>{r.points}</strong></td>
                    <td>{r.wins}-{r.draws}-{r.losses}</td>
                    <td>{r.gamesWon}-{r.gamesLost}</td>
                    <td>{r.played}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Members */}
        <div className="card">
          <strong>Members ({division.members.length}/{division.season.targetGroupSize})</strong>
          <table>
            <thead>
              <tr><th>Player</th><th>Discord ID</th><th>Joined</th></tr>
            </thead>
            <tbody>
              {division.members.length === 0 ? (
                <tr><td colSpan={3} className="muted">No members.</td></tr>
              ) : division.members.map((m) => {
                const isFake = isMockPlayer(m.player);
                const isDropped = m.status === "DROPPED";
                return (
                  <tr key={m.id}>
                    <td>
                      <strong>{m.player.displayName}</strong>
                      {" "}
                      {isFake ? (
                        <span className="pill" style={{ background: "rgba(241,196,15,0.15)", color: "#f1c40f" }}>FAKE</span>
                      ) : (
                        <span className="pill" style={{ background: "rgba(46,204,113,0.15)", color: "#2ecc71" }}>REAL</span>
                      )}
                      {isDropped && (
                        <span className="pill" style={{ background: "rgba(231,76,60,0.2)", color: "#e74c3c", marginLeft: 4 }}>DROPPED</span>
                      )}
                    </td>
                    <td><span className="muted">{m.player.discordId}</span></td>
                    <td>{m.joinedAt.toISOString().slice(0, 10)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Recorded sets */}
        <div className="card">
          <strong>Sets — recorded ({division.pairings.length})</strong>
          <table>
            <thead>
              <tr><th>Matchup</th><th>Result</th><th>Status</th><th>Override</th><th></th></tr>
            </thead>
            <tbody>
              {division.pairings.length === 0 ? (
                <tr><td colSpan={5} className="muted">None yet.</td></tr>
              ) : division.pairings.map((p) => {
                const statusBg = p.status === "CONFIRMED" ? "rgba(46,204,113,0.15)" : p.status === "DISPUTED" ? "rgba(231,76,60,0.15)" : "rgba(241,196,15,0.15)";
                const statusFg = p.status === "CONFIRMED" ? "#2ecc71" : p.status === "DISPUTED" ? "#e74c3c" : "#f1c40f";
                return (
                  <tr key={p.id}>
                    <td>{p.playerA.displayName} <span className="muted">vs</span> {p.playerB.displayName}</td>
                    <td><strong>{p.gamesWonA}-{p.gamesWonB}</strong></td>
                    <td><span className="pill" style={{ background: statusBg, color: statusFg }}>{p.status}</span></td>
                    <td>
                      <form action={overridePairing} style={{ display: "flex", gap: 4 }}>
                        <input type="hidden" name="pairingId" value={p.id} />
                        <select name="result" defaultValue={`${p.gamesWonA}-${p.gamesWonB}` as string}>
                          <option value="2-0">{p.playerA.displayName} 2-0</option>
                          <option value="1-1">1-1 draw</option>
                          <option value="0-2">{p.playerB.displayName} 2-0</option>
                        </select>
                        <button type="submit">Override</button>
                      </form>
                    </td>
                    <td>
                      <form action={deletePairing}>
                        <input type="hidden" name="pairingId" value={p.id} />
                        <button type="submit" className="danger">Delete</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Unplayed */}
        <div className="card">
          <strong>Sets — unplayed ({unplayed.length})</strong>
          <table>
            <thead>
              <tr><th>Matchup</th><th>Record</th></tr>
            </thead>
            <tbody>
              {unplayed.length === 0 ? (
                <tr><td colSpan={2} className="muted">All round-robin sets recorded.</td></tr>
              ) : unplayed.map(({ a, b }) => (
                <tr key={`${a.id}-${b.id}`}>
                  <td>{a.displayName} <span className="muted">vs</span> {b.displayName}</td>
                  <td>
                    <form action={recordSet} style={{ display: "flex", gap: 4 }}>
                      <input type="hidden" name="divisionId" value={division.id} />
                      <input type="hidden" name="playerAId" value={a.id} />
                      <input type="hidden" name="playerBId" value={b.id} />
                      <select name="result" defaultValue="">
                        <option value="">— pick result —</option>
                        <option value="2-0">{a.displayName} 2-0</option>
                        <option value="1-1">1-1 draw</option>
                        <option value="0-2">{b.displayName} 2-0</option>
                      </select>
                      <button type="submit">Record</button>
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
