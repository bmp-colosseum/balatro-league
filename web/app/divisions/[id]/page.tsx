// Public division page. Shows standings, played pairings, and the
// remaining matchups. Admins get extra editing controls (drop, remove,
// override, bulk import, etc.) gated by `isAdmin`.

import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { hasTier } from "@/lib/admin";
import { DivisionStandingsTable, type StandingsRowExtras } from "@/components/DivisionStandingsTable";
import { loadMmrForPlayerIds } from "@/lib/loaders/standings";
import { getShowBmpMmr } from "@/lib/preferences";
import { loadDivisionPageData, type DivisionRecentPairing, type DivisionUnplayed } from "@/lib/loaders/division";
import { loadAdminDivisionDetail } from "@/lib/loaders/admin";
import { prisma } from "@/lib/prisma";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";
import { DiscordId } from "@/components/DiscordId";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ConfirmButton";
import { MatchActionsPanel } from "@/components/MatchActionsPanel";
import { ReportForm } from "@/components/ReportForm";
import { CANONICAL_DECKS, CANONICAL_STAKES } from "@/lib/balatro-info";
import { FormSelect } from "@/components/FormSelect";
import { Input } from "@/components/ui/input";
import {
  addDivisionMemberByDiscordId,
  deleteShootout,
  dropDivisionMember,
  reactivateDivisionMember,
  recordSet,
  recordShootout,
  removeDivisionMember,
  reportFromDivisionAction,
  resolveTieAction,
  voidPlayerAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function PublicDivisionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ err?: string }>;
}) {
  const { id } = await params;
  const { err } = await searchParams;

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

  // BMP MMR for the shared standings table (empty unless the preference is on).
  const showBmpMmr = await getShowBmpMmr();
  const { mmrByPlayerId, bmpCurrentSeason } = await loadMmrForPlayerIds(
    standings.map((r) => r.player.id),
    showBmpMmr,
  );
  const standingsExtras = new Map<string, StandingsRowExtras>(
    standings.map((r) => [r.player.id, { mmr: mmrByPlayerId.get(r.player.id) }]),
  );

  // Sub-group context: if this division is sub-grouped and the viewer belongs
  // to one, we show their group's mini-table above the full division table.
  // Promotion still runs off the full division — the mini-table is just "how
  // your own matchups are shaking out."
  const groupMembers = await prisma.divisionMember.findMany({
    where: { divisionId: id, status: "ACTIVE", assignmentGroup: { not: null } },
    select: { playerId: true, assignmentGroup: true },
  });
  const groupByPlayer = new Map(groupMembers.map((m) => [m.playerId, m.assignmentGroup!]));
  const viewerGroup = viewerPlayerId != null ? groupByPlayer.get(viewerPlayerId) ?? null : null;
  const myGroupRows =
    viewerGroup != null ? standings.filter((r) => groupByPlayer.get(r.player.id) === viewerGroup) : [];

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

        {myGroupRows.length > 0 && (
          <div className="card">
            <strong>Your group</strong>{" "}
            <span className="muted" style={{ fontSize: 12 }}>— your matchups this season. Promotion runs off the full division below.</span>
            <DivisionStandingsTable
              rows={myGroupRows}
              extras={standingsExtras}
              showBmpMmr={showBmpMmr}
              bmpCurrentSeason={bmpCurrentSeason}
            />
          </div>
        )}

        <div className="card">
          <strong>{myGroupRows.length > 0 ? "Full division" : "Standings"}</strong>
          <DivisionStandingsTable
            rows={standings}
            extras={standingsExtras}
            showBmpMmr={showBmpMmr}
            bmpCurrentSeason={bmpCurrentSeason}
          />
        </div>

        <MatchesSections
          divisionId={id}
          viewerPlayerId={viewerPlayerId}
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
                        <DiscordId value={s.winner.discordId} username={s.winner.username} />
                        {" "}beat{" "}
                        <Link href={`/profile/${s.loser.id}`} style={{ color: "var(--text)" }}>
                          {s.loser.displayName}
                        </Link>
                        <DiscordId value={s.loser.discordId} username={s.loser.username} />
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
  unplayed,
  recentPairings,
  confirmedPairingCount,
}: {
  divisionId: string;
  viewerPlayerId: string | null;
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
  // The viewer's unplayed opponents → the report form's dropdown.
  const myOpponents = myUnplayed.map((m) => {
    const opp = m.a.id === viewerPlayerId ? m.b : m.a;
    return { playerId: opp.id, displayName: opp.displayName, alreadyPending: false };
  });

  if (!viewerIsMember) {
    return (
      <>
        {unplayed.length > 0 && (
          <div className="card">
            <strong>Remaining ({unplayed.length})</strong>
            <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 8 }}>
              {viewerPlayerId
                ? "Sign-in only lets you report your own matches — admins use the Match-actions panel below."
                : "Players in this division report their own matches by signing in."}
            </p>
            <UnplayedList rows={unplayed} />
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
        <strong>Report a match</strong>
        {myOpponents.length === 0 ? (
          <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>
            You&apos;ve played everyone in your division.
          </p>
        ) : (
          <>
            <div style={{ marginTop: 8 }}>
              <ReportForm
                action={reportFromDivisionAction}
                opponents={myOpponents}
                decks={CANONICAL_DECKS.map((d) => d.name)}
                stakes={CANONICAL_STAKES.map((s) => s.name)}
                hiddenFields={{ divisionId }}
              />
            </div>
            <p className="muted" style={{ fontSize: 11, marginTop: 8, marginBottom: 0 }}>
              Recorded right away and posted to <strong>#results</strong>. Your opponent gets a DM to dispute if the score is wrong.
            </p>
          </>
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
          <UnplayedList rows={otherUnplayed} />
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

// Read-only list of unplayed matchups (who still has to play whom). Players
// report via the single ReportForm above; admins act via the Match-actions
// panel in the admin section.
function UnplayedList({ rows }: { rows: DivisionUnplayed[] }) {
  return (
    <ul style={{ marginTop: 4, listStyle: "none", padding: 0 }}>
      {rows.map((m) => (
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
          <span>
            <Link href={`/profile/${m.a.id}`} style={{ color: "var(--text)" }}>{m.a.displayName}</Link>
            <DiscordId value={m.a.discordId} username={m.a.username} />
            <span className="muted"> vs </span>
            <Link href={`/profile/${m.b.id}`} style={{ color: "var(--text)" }}>{m.b.displayName}</Link>
            <DiscordId value={m.b.discordId} username={m.b.username} />
          </span>
        </li>
      ))}
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
                <DiscordId value={p.playerA.discordId} username={p.playerA.username} />
                {" "}<strong>{p.gamesWonA}-{p.gamesWonB}</strong>{" "}
                <Link href={`/profile/${p.playerB.id}`} style={{ color: "var(--text)" }}>{p.playerB.displayName}</Link>
                <DiscordId value={p.playerB.discordId} username={p.playerB.username} />
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
          // A 0-0 is a void (finished, no points) — distinct from a 1-1 draw.
          const outcome =
            myG === 0 && oppG === 0 ? { bg: "rgba(149,165,166,0.18)", fg: "#95a5a6", label: "V" }
            : myG > oppG ? { bg: "rgba(46,204,113,0.15)", fg: "#2ecc71", label: "W" }
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
  const { division, members, pairings, shootouts, unplayed, playerById, lifeDiffByPlayer } = adminData;
  return (
    <>
      <div className="card" style={{ borderColor: "#f1c40f" }}>
        <strong style={{ color: "#f1c40f" }}>🔧 Admin tools</strong>
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
          Editing controls only visible to admins. Add/drop/remove players, override results, shootouts, match progress.
        </p>
      </div>

      <div className="card">
        <strong>Add player by Discord ID</strong>
        <p className="muted">
          Mid-season add — looks up the member&apos;s guild display name; you can override.
          If this division has a Discord role set up, the new player will also be
          granted the role (and channel access).
        </p>
        <form action={addDivisionMemberByDiscordId} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <input type="hidden" name="divisionId" value={division.id} />
          <Input
            type="text"
            name="discordId"
            placeholder="Discord ID (17-20 digits)"
            required
            pattern="\d{17,20}"
            style={{ flex: "1 1 200px" }}
          />
          <Input
            type="text"
            name="displayName"
            placeholder="Display name override (optional)"
            style={{ flex: "1 1 200px" }}
          />
          <Button type="submit">Add to division</Button>
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
                        <Button type="submit" variant="secondary" size="sm">Reactivate</Button>
                      </form>
                    ) : (
                      <form action={dropDivisionMember}>
                        <input type="hidden" name="divisionId" value={division.id} />
                        <input type="hidden" name="playerId" value={m.playerId} />
                        <Button
                          type="submit"
                          variant="secondary"
                          size="sm"
                          title="Mark dropped — keeps played pairings, voids unplayed"
                        >
                          Drop
                        </Button>
                      </form>
                    )}
                    <form action={removeDivisionMember}>
                      <input type="hidden" name="divisionId" value={division.id} />
                      <input type="hidden" name="playerId" value={m.playerId} />
                      <Button
                        type="submit"
                        variant="secondary"
                        size="sm"
                        className="text-[#e74c3c]"
                        title="Hard remove: deletes membership + ALL their pairings in this division"
                      >
                        Remove
                      </Button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Consolidated match actions: pick a matchup → pick what happened.
          Covers record / override / DQ / void / undo in one flow — the single
          place admins act on matches. */}
      <MatchActionsPanel
        divisionId={divisionId}
        returnTo={`/divisions/${divisionId}`}
        members={members.filter((m) => m.status === "ACTIVE").map((m) => ({ playerId: m.playerId, displayName: m.player.displayName }))}
        unplayed={unplayed.map((u) => ({ p1Id: u.a.id, p2Id: u.b.id }))}
        played={pairings
          .filter((p) => p.status === "CONFIRMED")
          .map((p) => ({
            p1Id: p.playerAId,
            p2Id: p.playerBId,
            summary: p.gamesWonA === 0 && p.gamesWonB === 0 ? "0-0 void" : `${p.gamesWonA}-${p.gamesWonB}`,
          }))}
      />

      {/* DQ / void a whole player: cancel all their games + drop them. No 2-0s
          to opponents, no losses to the player. */}
      <div className="card">
        <strong>🚫 DQ / void a player</strong>
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
          Erases a player from the season: <strong>cancels all their games</strong> and drops them. Opponents
          get no 2-0s and the player records no losses — as if they never played. Use for a mid-season
          DQ. Reason is admin-only.
        </p>
        <form action={voidPlayerAction} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input type="hidden" name="divisionId" value={divisionId} />
          <FormSelect
            name="playerId"
            required
            triggerClassName="min-w-[160px]"
            placeholder="— player —"
            options={members.filter((m) => m.status === "ACTIVE").map((m) => ({ value: m.playerId, label: m.player.displayName }))}
          />
          <Input type="text" name="reason" placeholder="Reason (admin-only)" style={{ flex: "1 1 180px" }} />
          <ConfirmButton message="Void this player? All their games are cancelled and they're dropped from the division.">
            Void player
          </ConfirmButton>
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
                        <Button type="submit" variant="ghost" size="sm" className="text-[#e74c3c]">
                          delete
                        </Button>
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
          <FormSelect
            name="p1"
            required
            triggerClassName="min-w-[140px]"
            placeholder="p1…"
            options={members.map((m) => ({ value: m.playerId, label: m.player.displayName }))}
          />
          <span className="muted">vs</span>
          <FormSelect
            name="p2"
            required
            triggerClassName="min-w-[140px]"
            placeholder="p2…"
            options={members.map((m) => ({ value: m.playerId, label: m.player.displayName }))}
          />
          <span className="muted">winner:</span>
          <FormSelect
            name="winnerId"
            required
            triggerClassName="min-w-[140px]"
            placeholder="winner…"
            options={members.map((m) => ({ value: m.playerId, label: m.player.displayName }))}
          />
          <Button type="submit">Record showdown</Button>
        </form>
      </div>

      {/* Resolve a tie of ANY size (3-way+) — type a placement per tied player;
          equal numbers stay tied with each other, so you can pick the winner
          and leave the rest level. Writes the showdowns that encode it. */}
      <div className="card">
        <strong>⚖ Resolve a tie (any size)</strong>
        <p className="muted" style={{ fontSize: 12 }}>
          For a 3-way+ tie the single showdown above can&apos;t express. Type a placement for the
          tied players — <strong>1 = winner</strong>. Players with the <strong>same number stay tied</strong>{" "}
          with each other (e.g. <code>1, 2, 2</code> = one winner, the other two left level). Leave
          everyone else blank. Re-submitting overwrites this group. The{" "}
          <span style={{ color: "#2ecc71" }}>± lives</span> figure is the net life differential (won-game
          lives minus lost-game lives) — a reference for breaking the tie, applied however you decide.
        </p>
        <form action={resolveTieAction} style={{ display: "grid", gap: 4, maxWidth: 360 }}>
          <input type="hidden" name="divisionId" value={division.id} />
          {members.map((m) => {
            const diff = lifeDiffByPlayer[m.playerId];
            return (
              <label key={m.playerId} style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 13 }}>
                  {m.player.displayName}
                  {diff !== undefined && (
                    <span
                      title="Net life differential across regular-season games: lives kept in wins minus opponents' lives kept in your losses. Higher = more dominant."
                      style={{
                        marginLeft: 6,
                        fontSize: 11,
                        fontVariantNumeric: "tabular-nums",
                        color: diff > 0 ? "#2ecc71" : diff < 0 ? "#e74c3c" : "var(--muted)",
                      }}
                    >
                      {diff > 0 ? `+${diff}` : diff} lives
                    </span>
                  )}
                </span>
                <Input type="number" name={`place_${m.playerId}`} min={1} placeholder="—" className="w-16" />
              </label>
            );
          })}
          <Button type="submit" variant="secondary" style={{ marginTop: 4 }}>Resolve tie</Button>
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
                    <FormSelect
                      name="result"
                      placeholder="— pick result —"
                      options={[
                        { value: "2-0", label: `${a.displayName} 2-0` },
                        { value: "1-1", label: "1-1 draw" },
                        { value: "0-2", label: `${b.displayName} 2-0` },
                      ]}
                    />
                    <Button type="submit">Record</Button>
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
