// Public division page. Shows standings, played pairings, and the
// remaining matchups. Admins get extra editing controls (drop, remove,
// override, bulk import, etc.) gated by `isAdmin`.

import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { hasTier } from "@/lib/admin";
import { loadDivisionPageData, type DivisionRecentPairing, type DivisionUnplayed } from "@/lib/loaders/division";
import { loadAdminDivisionDetail } from "@/lib/loaders/admin";
import { prisma } from "@/lib/prisma";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";
import {
  addDivisionMemberByDiscordId,
  bulkAddMembers,
  bulkRecordPairings,
  deletePairing,
  deleteShootout,
  dropDivisionMember,
  overridePairing,
  reactivateDivisionMember,
  recordForfeitInDivision,
  recordFromDivisionAction,
  recordSet,
  recordShootout,
  removeDivisionMember,
  reportFromDivisionAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function PublicDivisionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ err?: string; bulk?: string }>;
}) {
  const { id } = await params;
  const { err, bulk } = await searchParams;
  // bulk is a URL-encoded query string like "added=5&skipped=1&failed=123,456" or "recorded=8&errors=..."
  const bulkSummary = bulk ? new URLSearchParams(decodeURIComponent(bulk)) : null;

  const data = await loadDivisionPageData(id);
  if (!data) notFound();
  const { division, standings, recentPairings, shootouts, unplayed } = data;
  const tc = tierColors(division.tierPosition);

  // Viewer identity: drives the per-row reporting controls on
  // the Remaining list. Two paths:
  //   - viewer is one of the two players → report from their POV
  //   - viewer is an admin → record either side's POV
  // Otherwise the row renders as plain text.
  const session = await auth();
  const viewerDiscordId = (session?.user as { discordId?: string } | undefined)?.discordId ?? null;
  const viewerPlayerId: string | null = viewerDiscordId
    ? (await prisma.player.findUnique({
        where: { discordId: viewerDiscordId },
        select: { id: true },
      }))?.id ?? null
    : null;
  const isAdmin = await hasTier("ADMIN");

  // Admin-only extras: members + pairings + shootouts with raw
  // edit/override controls. Skipped when not admin so the public
  // path doesn't pay the cost of the extra query.
  const adminData = isAdmin ? await loadAdminDivisionDetail(id) : null;

  return (
    <>
      <SiteNav activePath="/standings" />
      <main>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>{division.name}</h2>
          <span className="pill" style={{ background: tc.bg, color: tc.fg }}>{division.tierName}</span>
          <Link href={`/seasons/${division.seasonId}`} className="muted">
            {division.seasonName}
          </Link>
          <Link href="/standings" style={{ marginLeft: "auto" }}>← all standings</Link>
        </div>
        <div className="muted" style={{ marginTop: 4 }}>
          {division.activeCount} active player(s) · {division.confirmedPairingCount} match(es) played · {unplayed.length} remaining
        </div>

        {isAdmin && err && (
          <div className="card" style={{ borderColor: "#e74c3c", color: "#e74c3c" }}>
            {err}
          </div>
        )}

        {isAdmin && bulkSummary && (
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

        <div className="card">
          <strong>Standings</strong>
          <div className="table-scroll" style={{ marginTop: 8 }}>
          <table className="table-dense responsive-table">
            <thead>
              <tr>
                <th></th>
                <th>Player</th>
                <th>Pts</th>
                <th>W-D-L</th>
                <th>Games</th>
              </tr>
            </thead>
            <tbody>
              {standings.length === 0 ? (
                <tr><td colSpan={5} className="muted">No matches played yet.</td></tr>
              ) : standings.map((r, i) => {
                const medal = i < 3 ? ["🥇", "🥈", "🥉"][i] : `${i + 1}.`;
                const link = (
                  <Link href={`/profile/${r.player.id}`} style={{ color: "var(--text)" }}>
                    {r.player.displayName}
                  </Link>
                );
                return (
                  <tr key={r.player.id}>
                    <td data-label="Rank">{medal}</td>
                    <td className="card-header">{r.dropped ? <s>{link}</s> : link}{r.dropped && <span className="muted"> (dropped)</span>}</td>
                    <td data-label="Pts"><strong>{r.points}</strong></td>
                    <td data-label="W-D-L">{r.wins}-{r.draws}-{r.losses}</td>
                    <td data-label="Games">{r.gamesWon}-{r.gamesLost}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>

        <MatchesSections
          divisionId={id}
          viewerPlayerId={viewerPlayerId}
          isAdmin={isAdmin}
          unplayed={unplayed}
          recentPairings={recentPairings}
          confirmedPairingCount={division.confirmedPairingCount}
        />

        {shootouts.length > 0 && (
          <div className="card">
            <strong>⚔ Showdowns ({shootouts.length})</strong>
            <p className="muted" style={{ marginTop: 4, fontSize: 12 }}>
              1-game tiebreakers. Recorded when two players tied on points + drew their head-to-head.
            </p>
            <table style={{ marginTop: 8 }}>
              <thead><tr><th>Date</th><th>Result</th><th></th></tr></thead>
              <tbody>
                {shootouts.map((s) => {
                  const date = s.recordedAt.toISOString().slice(0, 10);
                  return (
                    <tr key={s.id}>
                      <td className="muted">{date}</td>
                      <td>
                        <Link href={`/profile/${s.winner.id}`} style={{ color: "var(--text)" }}>
                          <strong>{s.winner.displayName}</strong>
                        </Link>
                        {" "}beat{" "}
                        <Link href={`/profile/${s.loser.id}`} style={{ color: "var(--text)" }}>
                          {s.loser.displayName}
                        </Link>
                      </td>
                      <td className="muted" style={{ fontSize: 11 }}>
                        {s.selfReported ? "self-reported" : "mediator"}
                        {s.notes ? ` · ${s.notes}` : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {isAdmin && adminData && (
          <AdminSection divisionId={id} adminData={adminData} />
        )}
      </main>
    </>
  );
}

// Split the Remaining + Played lists into "Your matches" (top, visible,
// actionable) vs "Division matches" (collapsed, everyone else). When the
// viewer isn't a member of this division we fall back to a single visible
// Remaining list + collapsed Played list — same as before the split.
function MatchesSections({
  divisionId,
  viewerPlayerId,
  isAdmin,
  unplayed,
  recentPairings,
  confirmedPairingCount,
}: {
  divisionId: string;
  viewerPlayerId: string | null;
  isAdmin: boolean;
  unplayed: DivisionUnplayed[];
  recentPairings: DivisionRecentPairing[];
  confirmedPairingCount: number;
}) {
  const involvesViewer = (aId: string, bId: string) =>
    viewerPlayerId !== null && (aId === viewerPlayerId || bId === viewerPlayerId);
  const myUnplayed = unplayed.filter((m) => involvesViewer(m.a.id, m.b.id));
  const otherUnplayed = unplayed.filter((m) => !involvesViewer(m.a.id, m.b.id));
  const myPlayed = recentPairings.filter((p) => involvesViewer(p.playerA.id, p.playerB.id));
  const otherPlayed = recentPairings.filter((p) => !involvesViewer(p.playerA.id, p.playerB.id));
  // "Member" proxy: viewer shows up in either list. A brand-new member
  // with zero history still has unplayed against every other active
  // member, so this catches them.
  const viewerIsMember = myUnplayed.length > 0 || myPlayed.length > 0;

  if (!viewerIsMember) {
    return (
      <>
        {unplayed.length > 0 && (
          <div className="card">
            <strong>Remaining ({unplayed.length})</strong>
            <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 8 }}>
              {viewerPlayerId
                ? "Admins can record any match below. Sign-in won't help unless you're a member."
                : "Players in this division can report their matches by signing in."}
            </p>
            <UnplayedList
              divisionId={divisionId}
              rows={unplayed}
              viewerPlayerId={viewerPlayerId}
              isAdmin={isAdmin}
            />
          </div>
        )}
        <details className="card">
          <summary style={{ cursor: "pointer" }}>
            <strong>Recent matches ({confirmedPairingCount})</strong>
          </summary>
          <PlayedTable rows={recentPairings} />
        </details>
      </>
    );
  }

  return (
    <>
      <h3 style={{ marginTop: 16, marginBottom: 8 }}>🎯 Your matches</h3>

      <div className="card">
        <strong>Your unplayed ({myUnplayed.length})</strong>
        {myUnplayed.length === 0 ? (
          <p className="muted" style={{ marginTop: 6 }}>
            You&apos;ve played everyone in your division.
          </p>
        ) : (
          <UnplayedList
            divisionId={divisionId}
            rows={myUnplayed}
            viewerPlayerId={viewerPlayerId}
            isAdmin={isAdmin}
          />
        )}
      </div>

      {myPlayed.length > 0 && (
        <div className="card">
          <strong>Your played ({myPlayed.length})</strong>
          <YourPlayedTable rows={myPlayed} viewerPlayerId={viewerPlayerId!} />
        </div>
      )}

      <h3 style={{ marginTop: 24, marginBottom: 8 }}>Division matches</h3>

      {otherUnplayed.length > 0 && (
        <details className="card">
          <summary style={{ cursor: "pointer" }}>
            <strong>Remaining ({otherUnplayed.length})</strong>
            <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
              other players&apos; upcoming
            </span>
          </summary>
          <UnplayedList
            divisionId={divisionId}
            rows={otherUnplayed}
            viewerPlayerId={viewerPlayerId}
            isAdmin={isAdmin}
          />
        </details>
      )}

      <details className="card">
        <summary style={{ cursor: "pointer" }}>
          <strong>Played ({otherPlayed.length})</strong>
          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
            other matches in this division
          </span>
        </summary>
        <PlayedTable rows={otherPlayed} />
      </details>
    </>
  );
}

// Per-row Report / admin Record controls for an unplayed matchup. Same
// shape regardless of which section it lives in (yours/others/no-viewer).
function UnplayedList({
  divisionId,
  rows,
  viewerPlayerId,
  isAdmin,
}: {
  divisionId: string;
  rows: DivisionUnplayed[];
  viewerPlayerId: string | null;
  isAdmin: boolean;
}) {
  return (
    <ul style={{ marginTop: 4, listStyle: "none", padding: 0 }}>
      {rows.map((m) => {
        const viewerIsA = viewerPlayerId === m.a.id;
        const viewerIsB = viewerPlayerId === m.b.id;
        const viewerIsPlayer = viewerIsA || viewerIsB;
        const opponent = viewerIsA ? m.b : viewerIsB ? m.a : null;
        return (
          <li
            key={`${m.a.id}-${m.b.id}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 0",
              borderBottom: "1px solid rgba(255,255,255,0.05)",
              fontSize: 12,
              flexWrap: "wrap",
            }}
          >
            <span style={{ flex: "1 1 220px" }}>
              <Link href={`/profile/${m.a.id}`} style={{ color: "var(--text)" }}>{m.a.displayName}</Link>
              <span className="muted"> vs </span>
              <Link href={`/profile/${m.b.id}`} style={{ color: "var(--text)" }}>{m.b.displayName}</Link>
            </span>
            {viewerIsPlayer && opponent && (
              <form action={reportFromDivisionAction} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <input type="hidden" name="divisionId" value={divisionId} />
                <input type="hidden" name="opponentId" value={opponent.id} />
                <select name="result" defaultValue="2-0" style={{ fontSize: 11, padding: "1px 4px" }}>
                  <option value="2-0">I won 2-0</option>
                  <option value="1-1">Draw 1-1</option>
                  <option value="0-2">I lost 0-2</option>
                </select>
                <button type="submit" style={{ fontSize: 11, padding: "1px 8px" }}>Report</button>
              </form>
            )}
            {!viewerIsPlayer && isAdmin && (
              <form action={recordFromDivisionAction} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <input type="hidden" name="divisionId" value={divisionId} />
                <input type="hidden" name="playerAId" value={m.a.id} />
                <input type="hidden" name="playerBId" value={m.b.id} />
                <select name="result" defaultValue="2-0" style={{ fontSize: 11, padding: "1px 4px" }} title="Result from playerA's POV">
                  <option value="2-0">{m.a.displayName} 2-0</option>
                  <option value="1-1">Draw 1-1</option>
                  <option value="0-2">{m.b.displayName} 2-0</option>
                </select>
                <button type="submit" className="secondary" style={{ fontSize: 11, padding: "1px 8px" }}>Record</button>
              </form>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// All-pairings table — date + raw A vs B result. Used for the
// non-member view and the "other matches" collapsible.
function PlayedTable({ rows }: { rows: DivisionRecentPairing[] }) {
  if (rows.length === 0) {
    return <p className="muted" style={{ marginTop: 8 }}>No matches played yet.</p>;
  }
  return (
    <table style={{ marginTop: 8 }}>
      <thead><tr><th>Date</th><th>Result</th></tr></thead>
      <tbody>
        {rows.map((p) => {
          const date = p.date ? p.date.toISOString().slice(0, 10) : "—";
          return (
            <tr key={p.id}>
              <td className="muted">{date}</td>
              <td>
                <Link href={`/profile/${p.playerA.id}`} style={{ color: "var(--text)" }}>{p.playerA.displayName}</Link>
                {" "}<strong>{p.gamesWonA}-{p.gamesWonB}</strong>{" "}
                <Link href={`/profile/${p.playerB.id}`} style={{ color: "var(--text)" }}>{p.playerB.displayName}</Link>
                {p.forfeit && (
                  <span className="muted" style={{ fontSize: 10, marginLeft: 6 }} title="Win by forfeit / disqualification">
                    by DQ
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// Viewer-centric played table — opponent + score from viewer's POV +
// W/D/L pill. More glanceable than the raw A-vs-B layout when you only
// care about your own results.
function YourPlayedTable({ rows, viewerPlayerId }: { rows: DivisionRecentPairing[]; viewerPlayerId: string }) {
  return (
    <table style={{ marginTop: 8 }}>
      <thead>
        <tr>
          <th>Date</th>
          <th>Opponent</th>
          <th>Score</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => {
          const date = p.date ? p.date.toISOString().slice(0, 10) : "—";
          const isA = p.playerA.id === viewerPlayerId;
          const opponent = isA ? p.playerB : p.playerA;
          const myG = isA ? p.gamesWonA : p.gamesWonB;
          const oppG = isA ? p.gamesWonB : p.gamesWonA;
          const outcome =
            myG > oppG ? { bg: "rgba(46,204,113,0.15)", fg: "#2ecc71", label: "W" }
            : myG < oppG ? { bg: "rgba(231,76,60,0.15)", fg: "#e74c3c", label: "L" }
            : { bg: "rgba(241,196,15,0.15)", fg: "#f1c40f", label: "D" };
          return (
            <tr key={p.id}>
              <td className="muted">{date}</td>
              <td>
                <Link href={`/profile/${opponent.id}`} style={{ color: "var(--text)" }}>
                  {opponent.displayName}
                </Link>
              </td>
              <td><strong>{myG}–{oppG}</strong></td>
              <td>
                <span className="pill" style={{ background: outcome.bg, color: outcome.fg }}>
                  {outcome.label}
                </span>
                {p.forfeit && (
                  <span className="muted" style={{ fontSize: 10, marginLeft: 6 }} title="Win by forfeit / disqualification">
                    by DQ
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function AdminSection({
  divisionId,
  adminData,
}: {
  divisionId: string;
  adminData: NonNullable<Awaited<ReturnType<typeof loadAdminDivisionDetail>>>;
}) {
  const { division, members, pairings, shootouts, unplayed, playerById } = adminData;
  return (
    <>
      <div className="card" style={{ borderColor: "#f1c40f" }}>
        <strong style={{ color: "#f1c40f" }}>🔧 Admin tools</strong>
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
          Editing controls only visible to admins. Bulk import, drop/remove, override, shootouts, match progress.
        </p>
      </div>

      <details className="card">
        <summary style={{ cursor: "pointer" }}><strong>Bulk import members</strong></summary>
        <p className="muted" style={{ marginTop: 8 }}>
          Paste one Discord ID per line. Mentions like <code>&lt;@123456&gt;</code> work too —
          we just extract the digits. Lines starting with <code>#</code> are skipped.
        </p>
        <form action={bulkAddMembers}>
          <input type="hidden" name="divisionId" value={divisionId} />
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
          <code>2-0</code>, <code>1-1</code>, or <code>0-2</code> (A&apos;s perspective).
          Both players must already be members of this division.
        </p>
        <form action={bulkRecordPairings}>
          <input type="hidden" name="divisionId" value={divisionId} />
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
          Mid-season add — looks up the member&apos;s guild display name; you can override.
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

      {/* Recorded matches with admin override/delete */}
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

      {/* Record / fix a forfeit (DQ). Works on any pair, played or not — it
          overwrites an existing result in place, so a wrong DQ is fixed by
          just re-submitting with the right winner (no delete-first dance). */}
      <div className="card">
        <strong>⚖ Record / fix a forfeit (DQ)</strong>
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
          Awards a 2-0 win by DQ (no-show, drop-out, rule break). Works even if the pair already
          played — it overwrites that result, so to fix a wrong DQ just pick the right winner and
          submit again. Reason is <strong>admin-only</strong> (players only see &ldquo;by DQ&rdquo;).
        </p>
        <form action={recordForfeitInDivision} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input type="hidden" name="divisionId" value={divisionId} />
          <label style={{ fontSize: 12 }}>
            Winner{" "}
            <select name="winnerId" required defaultValue="">
              <option value="" disabled>— winner —</option>
              {members.filter((m) => m.status === "ACTIVE").map((m) => (
                <option key={m.playerId} value={m.playerId}>{m.player.displayName}</option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 12 }}>
            DQ&apos;d{" "}
            <select name="loserId" required defaultValue="">
              <option value="" disabled>— loser —</option>
              {members.filter((m) => m.status === "ACTIVE").map((m) => (
                <option key={m.playerId} value={m.playerId}>{m.player.displayName}</option>
              ))}
            </select>
          </label>
          <input type="text" name="reason" required placeholder="Reason (admin-only)" style={{ flex: "1 1 200px" }} />
          <button type="submit">Record DQ</button>
        </form>
      </div>

      {/* Shootouts admin controls */}
      <div className="card">
        <strong>⚔ Showdowns ({shootouts.length})</strong>
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
          <button type="submit">Record showdown</button>
        </form>
      </div>

      {/* Unplayed admin recorder — distinct from the public per-row report
          form: admin can set any pair to any result without being one of
          the players. */}
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
    </>
  );
}
