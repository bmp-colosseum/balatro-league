import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { computeStandings } from "@/lib/standings";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import {
  addDivisionMemberByDiscordId,
  bulkAddMembers,
  bulkRecordPairings,
  deletePairing,
  deleteShootout,
  dropDivisionMember,
  overridePairing,
  reactivateDivisionMember,
  recordSet,
  recordShootout,
  removeDivisionMember,
  setDivisionTargetSize,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminDivisionDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ err?: string; bulk?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const { err, bulk } = await searchParams;
  // bulk is a URL-encoded query string like "added=5&skipped=1&failed=123,456" or "recorded=8&errors=..."
  const bulkSummary = bulk ? new URLSearchParams(decodeURIComponent(bulk)) : null;

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
      shootouts: { select: { playerAId: true, playerBId: true, winnerId: true, recordedBy: true, recordedAt: true, notes: true } },
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
    division.shootouts,
  ).map((r) => ({ ...r, dropped: droppedIds.has(r.player.id) }));
  // Lookup map for player display in the shootouts section.
  const playerById = new Map(division.members.map((m) => [m.playerId, m.player]));

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

        {bulkSummary && (
          <div className="card" style={{ borderColor: "#2ecc71" }}>
            <strong>Bulk import done</strong>
            <ul className="muted" style={{ marginTop: 4 }}>
              {bulkSummary.get("added") && <li>{bulkSummary.get("added")} member(s) added</li>}
              {bulkSummary.get("skipped") && <li>{bulkSummary.get("skipped")} line(s) skipped (no Discord ID found)</li>}
              {bulkSummary.get("failed") && bulkSummary.get("failed")!.length > 0 && (
                <li style={{ color: "#e74c3c" }}>failed lookups: {bulkSummary.get("failed")}</li>
              )}
              {bulkSummary.get("recorded") && <li>{bulkSummary.get("recorded")} pairing(s) recorded</li>}
              {bulkSummary.get("errors") && bulkSummary.get("errors")!.length > 0 && (
                <li style={{ color: "#e74c3c" }}>line errors: {bulkSummary.get("errors")}</li>
              )}
              {bulkSummary.get("transferred") && bulkSummary.get("transferred")!.length > 0 && (
                <li style={{ color: "#f1c40f" }}>
                  ↪ Transferred from other divisions: {bulkSummary.get("transferred")}
                </li>
              )}
              {bulkSummary.get("from") && (
                <li style={{ color: "#f1c40f" }}>
                  ↪ {bulkSummary.get("transferred")} moved here from <strong>{bulkSummary.get("from")}</strong> (one-per-season rule).
                </li>
              )}
            </ul>
          </div>
        )}

        <details className="card">
          <summary style={{ cursor: "pointer" }}><strong>Bulk import members</strong></summary>
          <p className="muted" style={{ marginTop: 8 }}>
            Paste one Discord ID per line. Mentions like <code>&lt;@123456&gt;</code> work too —
            we just extract the digits. Lines starting with <code>#</code> are skipped.
          </p>
          <form action={bulkAddMembers}>
            <input type="hidden" name="divisionId" value={division.id} />
            <textarea
              name="lines"
              rows={8}
              placeholder={"123456789012345678\n234567890123456789\n# comment lines are ok\n<@345678901234567890>"}
              style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: 12 }}
              required
            />
            <button type="submit" style={{ marginTop: 6 }}>Add all to division</button>
          </form>
        </details>

        <details className="card">
          <summary style={{ cursor: "pointer" }}><strong>Bulk record played pairings</strong></summary>
          <p className="muted" style={{ marginTop: 8 }}>
            One line per played set: <code>discordA discordB RESULT</code> where RESULT is{" "}
            <code>2-0</code>, <code>1-1</code>, or <code>0-2</code> (A's perspective).
            Both players must already be members of this division.
          </p>
          <form action={bulkRecordPairings}>
            <input type="hidden" name="divisionId" value={division.id} />
            <textarea
              name="lines"
              rows={8}
              placeholder={"123456789012345678 234567890123456789 2-0\n123456789012345678 345678901234567890 1-1"}
              style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: 12 }}
              required
            />
            <button type="submit" style={{ marginTop: 6 }}>Record all pairings</button>
          </form>
        </details>

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
                <tr><td colSpan={6} className="muted">No confirmed matches yet.</td></tr>
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
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <strong>Members ({division.members.length}/{division.targetSize ?? division.season.targetGroupSize})</strong>
            <form action={setDivisionTargetSize} style={{ display: "flex", gap: 4, alignItems: "center", marginLeft: "auto" }}>
              <input type="hidden" name="divisionId" value={division.id} />
              <label className="muted" style={{ fontSize: 11 }}>Override size:</label>
              <input
                type="number"
                name="targetSize"
                min={1}
                max={50}
                defaultValue={division.targetSize ?? ""}
                placeholder={`${division.season.targetGroupSize} (default)`}
                style={{ width: 80, fontSize: 12 }}
              />
              <button type="submit" className="secondary" style={{ fontSize: 11 }}>Save</button>
            </form>
          </div>
          <table>
            <thead>
              <tr><th>Player</th><th>Discord ID</th><th></th></tr>
            </thead>
            <tbody>
              {division.members.length === 0 ? (
                <tr><td colSpan={3} className="muted">No members.</td></tr>
              ) : division.members.map((m) => {
                const isDropped = m.status === "DROPPED";
                return (
                  <tr key={m.id}>
                    <td>
                      <strong>{m.player.displayName}</strong>
                      {isDropped && (
                        <span className="pill" style={{ background: "rgba(231,76,60,0.2)", color: "#e74c3c", marginLeft: 6 }}>DROPPED</span>
                      )}
                    </td>
                    <td><span className="muted">{m.player.discordId}</span></td>
                    <td style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      {isDropped ? (
                        <form action={reactivateDivisionMember}>
                          <input type="hidden" name="divisionId" value={division.id} />
                          <input type="hidden" name="playerId" value={m.playerId} />
                          <button type="submit" className="secondary" style={{ fontSize: 11 }}>Reactivate</button>
                        </form>
                      ) : (
                        <form action={dropDivisionMember}>
                          <input type="hidden" name="divisionId" value={division.id} />
                          <input type="hidden" name="playerId" value={m.playerId} />
                          <button
                            type="submit"
                            className="secondary"
                            style={{ fontSize: 11 }}
                            title="Mark dropped — keeps played pairings, voids unplayed"
                          >
                            Drop
                          </button>
                        </form>
                      )}
                      <form action={removeDivisionMember}>
                        <input type="hidden" name="divisionId" value={division.id} />
                        <input type="hidden" name="playerId" value={m.playerId} />
                        <button
                          type="submit"
                          className="secondary"
                          style={{ fontSize: 11, color: "#e74c3c" }}
                          title="Hard remove: deletes membership + ALL their pairings in this division"
                        >
                          Remove
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Recorded matches */}
        <div className="card">
          <strong>Matches — recorded ({division.pairings.length})</strong>
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

        {/* Shootouts */}
        <div className="card">
          <strong>⚔ Shootouts ({division.shootouts.length})</strong>
          <p className="muted" style={{ fontSize: 12 }}>
            Tiebreakers for players tied on points whose regular-season set was a 1-1 draw.
            Sort uses this between head-to-head and wins.
          </p>
          {division.shootouts.length > 0 && (
            <table style={{ marginBottom: 12 }}>
              <thead>
                <tr><th>Players</th><th>Winner</th><th>Source</th><th></th></tr>
              </thead>
              <tbody>
                {division.shootouts.map((s) => {
                  const pA = playerById.get(s.playerAId);
                  const pB = playerById.get(s.playerBId);
                  const winner = s.winnerId === s.playerAId ? pA : pB;
                  if (!pA || !pB || !winner) return null;
                  return (
                    <tr key={`${s.playerAId}-${s.playerBId}`}>
                      <td>{pA.displayName} <span className="muted">vs</span> {pB.displayName}</td>
                      <td><strong>{winner.displayName}</strong></td>
                      <td style={{ fontSize: 11 }} className="muted">{s.recordedBy}</td>
                      <td>
                        <form action={deleteShootout}>
                          <input type="hidden" name="divisionId" value={division.id} />
                          <input type="hidden" name="p1" value={s.playerAId} />
                          <input type="hidden" name="p2" value={s.playerBId} />
                          <button type="submit" className="muted" style={{ background: "none", border: "none", color: "#e74c3c", cursor: "pointer", fontSize: 11 }}>
                            delete
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <form action={recordShootout} style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
            <input type="hidden" name="divisionId" value={division.id} />
            <select name="p1" required defaultValue="" style={{ minWidth: 140 }}>
              <option value="" disabled>p1…</option>
              {division.members.map((m) => (
                <option key={`s1-${m.playerId}`} value={m.playerId}>{m.player.displayName}</option>
              ))}
            </select>
            <span className="muted">vs</span>
            <select name="p2" required defaultValue="" style={{ minWidth: 140 }}>
              <option value="" disabled>p2…</option>
              {division.members.map((m) => (
                <option key={`s2-${m.playerId}`} value={m.playerId}>{m.player.displayName}</option>
              ))}
            </select>
            <span className="muted">winner:</span>
            <select name="winnerId" required defaultValue="" style={{ minWidth: 140 }}>
              <option value="" disabled>winner…</option>
              {division.members.map((m) => (
                <option key={`sw-${m.playerId}`} value={m.playerId}>{m.player.displayName}</option>
              ))}
            </select>
            <button type="submit">Record shootout</button>
          </form>
        </div>

        {/* Unplayed */}
        <div className="card">
          <strong>Matches — unplayed ({unplayed.length})</strong>
          <table>
            <thead>
              <tr><th>Matchup</th><th>Record</th></tr>
            </thead>
            <tbody>
              {unplayed.length === 0 ? (
                <tr><td colSpan={2} className="muted">All round-robin matches recorded.</td></tr>
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
