import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { loadAdminDivisionDetail } from "@/lib/loaders/admin";
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

  const data = await loadAdminDivisionDetail(id);
  if (!data) notFound();
  const { division, members, pairings, shootouts, standings: rows, unplayed, playerById } = data;
  const tierColor = tierColors(division.tierPosition);
  // Keep these locals for any later inline references to mirror the
  // previous shape of `division.X`. The page below was built against
  // them; loader's shape mirrors except `season`/`tier` are flattened.

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/divisions" />
      <main>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{division.name}</h2>
          <span className="pill" style={{ background: tierColor.bg, color: tierColor.fg }}>{division.tierName}</span>
          <span className="muted">· {division.seasonName}</span>
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

        {/* Match progress grid — read-only "who's played whom" so admin
            can see at-a-glance who still owes matches. Filled cell =
            played, empty = still owed. Editing happens in the Pairings
            section below (per-row record/override forms). */}
        {(() => {
          const gridPlayers = rows.length > 0
            ? rows.map((r) => ({ id: r.player.id, displayName: r.player.displayName }))
            : members.map((m) => ({ id: m.player.id, displayName: m.player.displayName }));
          if (gridPlayers.length === 0) return null;
          const idxById = new Map(gridPlayers.map((p, i) => [p.id, i]));
          // 0 = unplayed, 1 = played (with confirmed result). Diagonal is -1.
          const played: number[][] = gridPlayers.map((p) =>
            gridPlayers.map((_, i) => (i === idxById.get(p.id) ? -1 : 0)),
          );
          // Per-cell tooltip text — "Alice 2-0 Bob" etc.
          const tooltips: string[][] = gridPlayers.map(() => gridPlayers.map(() => ""));
          for (const pair of pairings) {
            if (pair.status !== "CONFIRMED") continue;
            const aIdx = idxById.get(pair.playerAId);
            const bIdx = idxById.get(pair.playerBId);
            if (aIdx === undefined || bIdx === undefined) continue;
            played[aIdx]![bIdx] = 1;
            played[bIdx]![aIdx] = 1;
            const aName = gridPlayers[aIdx]!.displayName;
            const bName = gridPlayers[bIdx]!.displayName;
            tooltips[aIdx]![bIdx] = `${aName} ${pair.gamesWonA}-${pair.gamesWonB} ${bName}`;
            tooltips[bIdx]![aIdx] = `${bName} ${pair.gamesWonB}-${pair.gamesWonA} ${aName}`;
          }
          const totalPossible = (gridPlayers.length * (gridPlayers.length - 1)) / 2;
          const totalPlayed = pairings.filter((p) => p.status === "CONFIRMED").length;
          return (
            <div className="card">
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <strong>Match progress</strong>
                <span className="muted" style={{ fontSize: 11 }}>
                  {totalPlayed} of {totalPossible} matches played
                </span>
              </div>
              <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 6 }}>
                Filled = match recorded, empty = still owed. Hover for the score. Record results below.
              </p>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
                  <tbody>
                    {gridPlayers.map((rowPlayer, ri) => (
                      <tr key={rowPlayer.id}>
                        <td style={{
                          padding: "2px 8px 2px 0",
                          textAlign: "right",
                          whiteSpace: "nowrap",
                          color: "var(--text)",
                          fontWeight: 500,
                          maxWidth: 140,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}>
                          {rowPlayer.displayName}
                        </td>
                        {gridPlayers.map((_, ci) => {
                          const state = played[ri]![ci]!;
                          const bg = state === -1
                            ? "transparent"
                            : state === 1
                              ? "#2ecc71"
                              : "rgba(149,165,166,0.20)";
                          return (
                            <td
                              key={ci}
                              title={state === 1 ? tooltips[ri]![ci] : state === -1 ? "" : `vs ${gridPlayers[ci]!.displayName} — not yet played`}
                              style={{
                                width: 16,
                                height: 16,
                                background: bg,
                                border: state === -1 ? "none" : "1px solid var(--border)",
                                borderRadius: 2,
                              }}
                            />
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}

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
                    <td>
                      {r.dropped ? (
                        <s>
                          <Link href={`/profile/${r.player.id}`} style={{ color: "var(--text)" }}>{r.player.displayName}</Link>
                        </s>
                      ) : (
                        <Link href={`/profile/${r.player.id}`} style={{ color: "var(--text)" }}>{r.player.displayName}</Link>
                      )}
                      {r.dropped && <span className="muted"> (dropped)</span>}
                    </td>
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
            <strong>Members ({members.length})</strong>
          </div>
          <table>
            <thead>
              <tr><th>Player</th><th>Discord ID</th><th></th></tr>
            </thead>
            <tbody>
              {members.length === 0 ? (
                <tr><td colSpan={3} className="muted">No members.</td></tr>
              ) : members.map((m) => {
                const isDropped = m.status === "DROPPED";
                return (
                  <tr key={m.id}>
                    <td>
                      <strong>
                        <Link href={`/profile/${m.player.id}`} style={{ color: "var(--text)" }}>{m.player.displayName}</Link>
                      </strong>
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
          <strong>Matches — recorded ({pairings.length})</strong>
          <table>
            <thead>
              <tr><th>Matchup</th><th>Result</th><th>Status</th><th>Override</th><th></th></tr>
            </thead>
            <tbody>
              {pairings.length === 0 ? (
                <tr><td colSpan={5} className="muted">None yet.</td></tr>
              ) : pairings.map((p) => {
                const statusBg = p.status === "CONFIRMED" ? "rgba(46,204,113,0.15)" : p.status === "DISPUTED" ? "rgba(231,76,60,0.15)" : "rgba(241,196,15,0.15)";
                const statusFg = p.status === "CONFIRMED" ? "#2ecc71" : p.status === "DISPUTED" ? "#e74c3c" : "#f1c40f";
                return (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/profile/${p.playerA.id}`} style={{ color: "var(--text)" }}>{p.playerA.displayName}</Link>
                      {" "}<span className="muted">vs</span>{" "}
                      <Link href={`/profile/${p.playerB.id}`} style={{ color: "var(--text)" }}>{p.playerB.displayName}</Link>
                    </td>
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
          <strong>⚔ Shootouts ({shootouts.length})</strong>
          <p className="muted" style={{ fontSize: 12 }}>
            Tiebreakers for players tied on points whose regular-season set was a 1-1 draw.
            Sort uses this between head-to-head and wins.
          </p>
          {shootouts.length > 0 && (
            <table style={{ marginBottom: 12 }}>
              <thead>
                <tr><th>Players</th><th>Winner</th><th>Source</th><th></th></tr>
              </thead>
              <tbody>
                {shootouts.map((s) => {
                  const pA = playerById.get(s.playerAId);
                  const pB = playerById.get(s.playerBId);
                  const winner = s.winnerId === s.playerAId ? pA : pB;
                  if (!pA || !pB || !winner) return null;
                  return (
                    <tr key={`${s.playerAId}-${s.playerBId}`}>
                      <td>
                        <Link href={`/profile/${pA.id}`} style={{ color: "var(--text)" }}>{pA.displayName}</Link>
                        {" "}<span className="muted">vs</span>{" "}
                        <Link href={`/profile/${pB.id}`} style={{ color: "var(--text)" }}>{pB.displayName}</Link>
                      </td>
                      <td>
                        <Link href={`/profile/${winner.id}`} style={{ color: "var(--text)" }}>
                          <strong>{winner.displayName}</strong>
                        </Link>
                      </td>
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
              {members.map((m) => (
                <option key={`s1-${m.playerId}`} value={m.playerId}>{m.player.displayName}</option>
              ))}
            </select>
            <span className="muted">vs</span>
            <select name="p2" required defaultValue="" style={{ minWidth: 140 }}>
              <option value="" disabled>p2…</option>
              {members.map((m) => (
                <option key={`s2-${m.playerId}`} value={m.playerId}>{m.player.displayName}</option>
              ))}
            </select>
            <span className="muted">winner:</span>
            <select name="winnerId" required defaultValue="" style={{ minWidth: 140 }}>
              <option value="" disabled>winner…</option>
              {members.map((m) => (
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
                  <td>
                    <Link href={`/profile/${a.id}`} style={{ color: "var(--text)" }}>{a.displayName}</Link>
                    {" "}<span className="muted">vs</span>{" "}
                    <Link href={`/profile/${b.id}`} style={{ color: "var(--text)" }}>{b.displayName}</Link>
                  </td>
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
