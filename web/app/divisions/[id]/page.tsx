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
import { loadTieHelper, type TieGroup } from "@/lib/loaders/tie-helper";
import { loadAdminDivisionDetail } from "@/lib/loaders/admin";
import { loadPlayerIdByDiscordId } from "@/lib/loaders/players";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";
import { Callout } from "@/components/Callout";
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
  recordShootout,
  removeDivisionMember,
  reportFromDivisionAction,
  resolveTieAction,
  voidPlayerAction,
  dqForfeitPlayerAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function PublicDivisionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ err?: string; ok?: string }>;
}) {
  const { id } = await params;
  const { err, ok } = await searchParams;
  // Friendly success message for the ?ok= redirect codes admin actions set.
  const okMessage = ((): string | null => {
    if (!ok) return null;
    if (ok.startsWith("dq-forfeit:")) {
      const n = Number(ok.split(":")[1]) || 0;
      return `DQ recorded — awarded ${n} opponent${n === 1 ? "" : "s"} a 2-0 by forfeit. Player kept active (finishes last / relegates).`;
    }
    const known: Record<string, string> = {
      "player-voided": "Player voided — all their games cancelled and they were dropped.",
      "game-voided": "Game voided (0-0).",
      "tie-resolved": "Tie resolved.",
    };
    return known[ok] ?? "Done.";
  })();

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
    ? await loadPlayerIdByDiscordId(viewerDiscordId)
    : null;
  const isAdmin = await hasTier("ADMIN");

  // Admin-only extras: members + pairings + shootouts with raw
  // edit/override controls. Skipped when not admin so the public
  // path doesn't pay the cost of the extra query.
  const adminData = isAdmin ? await loadAdminDivisionDetail(id) : null;
  const tieGroups = isAdmin ? await loadTieHelper(id) : [];

  // BMP MMR for the shared standings table (empty unless the preference is on).
  const showBmpMmr = await getShowBmpMmr();
  const { mmrByPlayerId, bmpCurrentSeason } = await loadMmrForPlayerIds(
    standings.map((r) => r.player.id),
    showBmpMmr,
  );
  const standingsExtras = new Map<string, StandingsRowExtras>(
    standings.map((r) => [r.player.id, { mmr: mmrByPlayerId.get(r.player.id) }]),
  );

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
          {division.activeCount} active {division.activeCount === 1 ? "player" : "players"} · {division.confirmedPairingCount} {division.confirmedPairingCount === 1 ? "match" : "matches"} played · {unplayed.length} remaining
        </div>

        {isAdmin && err && (
          <Callout type="danger">
            {err}
          </Callout>
        )}
        {isAdmin && okMessage && (
          <Callout type="success">
            {okMessage}
          </Callout>
        )}

        <div className="card">
          <strong>Standings</strong>
          <div style={{ marginTop: 8 }}>
            <DivisionStandingsTable
              rows={standings}
              extras={standingsExtras}
              showBmpMmr={showBmpMmr}
              bmpCurrentSeason={bmpCurrentSeason}
            />
          </div>
        </div>

        <MatchesSections
          divisionId={id}
          viewerPlayerId={viewerPlayerId}
          unplayed={unplayed}
          recentPairings={recentPairings}
          confirmedPairingCount={division.confirmedPairingCount}
        />

        {shootouts.length > 0 && (
          <details className="card">
            <summary style={{ cursor: "pointer" }}>
              <strong>⚔ Shootouts ({shootouts.length})</strong>
            </summary>
            <p className="muted" style={{ marginTop: 4, fontSize: 12 }}>
              A shootout is a 1-game tiebreaker. Played when two players tie on points and split their two games 1-1.
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
          </details>
        )}

        {isAdmin && adminData && (
          <AdminSection divisionId={id} adminData={adminData} tieGroups={tieGroups} />
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
                ? "You can only report your own matches. Admins use the Match actions panel below."
                : "Players in this division sign in to report their own matches."}
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
            <p className="muted" style={{ marginTop: 6, marginBottom: 0, fontSize: 13 }}>
              You still play <strong>{myOpponents.length}</strong>:{" "}
              {myOpponents.map((o, i) => (
                <span key={o.playerId}>
                  {i > 0 && " · "}
                  <Link href={`/profile/${o.playerId}`} style={{ color: "var(--text)" }}>{o.displayName}</Link>
                </span>
              ))}
            </p>
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
            myG === 0 && oppG === 0 ? { bg: "rgba(149,165,166,0.18)", fg: "var(--muted)", label: "V" }
            : myG > oppG ? { bg: "rgba(46,204,113,0.15)", fg: "var(--success)", label: "W" }
            : myG < oppG ? { bg: "rgba(231,76,60,0.15)", fg: "var(--danger)", label: "L" }
            : { bg: "rgba(241,196,15,0.15)", fg: "var(--accent)", label: "D" };
          return (
            <tr key={p.id}>
              <td className="muted">{date}</td>
              <td>
                <Link href={`/profile/${opponent.id}`} style={{ color: "var(--text)" }}>
                  {opponent.displayName}
                </Link>
              </td>
              <td><strong>{myG}-{oppG}</strong></td>
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
  tieGroups,
}: {
  divisionId: string;
  adminData: NonNullable<Awaited<ReturnType<typeof loadAdminDivisionDetail>>>;
  tieGroups: TieGroup[];
}) {
  const { division, members, pairings, shootouts, unplayed, playerById } = adminData;
  return (
    <>
      <div className="card card-accent">
        <strong style={{ color: "var(--accent)" }}>🔧 Admin tools</strong>
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
                      <span className="pill" style={{ background: "rgba(231,76,60,0.2)", color: "var(--danger)", marginLeft: 6 }}>DROPPED</span>
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
        decks={CANONICAL_DECKS.map((d) => d.name)}
        stakes={CANONICAL_STAKES.map((s) => s.name)}
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

      {/* Two ways to remove a player mid-season — different effects on opponents. */}
      <div className="card">
        <strong>🏳️ DQ a no-show (forfeit — opponents win 2-0)</strong>
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
          For a player who <strong>hasn&apos;t played</strong>: awards each of their <strong>unplayed scheduled
          opponents a 2-0 win</strong> by forfeit. The player is <strong>kept active</strong> and finishes last on
          those losses — so they take their own relegation (no innocent player pushed down) and come back relegated
          if they sign up again. Already-played results are left alone. Reason is admin-only.
        </p>
        <form action={dqForfeitPlayerAction} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input type="hidden" name="divisionId" value={divisionId} />
          <FormSelect
            name="playerId"
            required
            triggerClassName="min-w-[160px]"
            placeholder="— player —"
            options={members.filter((m) => m.status === "ACTIVE").map((m) => ({ value: m.playerId, label: m.player.displayName }))}
          />
          <Input type="text" name="reason" placeholder="Reason (admin-only)" style={{ flex: "1 1 180px" }} />
          <ConfirmButton message="DQ this no-show? Every unplayed scheduled opponent gets a 2-0 forfeit win. The player stays in the division (finishes last / relegates).">
            DQ (forfeit)
          </ConfirmButton>
        </form>
      </div>

      {/* DQ / void a whole player: cancel all their games + drop them. No 2-0s
          to opponents, no losses to the player. */}
      <div className="card">
        <strong>🚫 DQ / void a player (cancel everything)</strong>
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
          Erases a player from the season: <strong>cancels all their games</strong> and drops them. Opponents
          get no 2-0s and the player records no losses — as if they never played. Use when you <em>don&apos;t</em>{" "}
          want opponents to get forfeit wins. Reason is admin-only.
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
        <strong>⚔ Shootouts ({shootouts.length})</strong>
        <p className="muted" style={{ fontSize: 12 }}>
          Tiebreakers for players tied on points who split their two games 1-1.
          Standings use this between the 1-1 result and total wins.
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
          <Button type="submit">Record shootout</Button>
        </form>
      </div>

      {/* Tie helper: shows exactly who's tied + the head-to-head / game stats
          among them, so you know what to type into the resolve form below. */}
      <TieHelper groups={tieGroups} />

      {/* Resolve a tie of ANY size (3-way+) — type a placement per tied player;
          equal numbers stay tied with each other, so you can pick the winner
          and leave the rest level. Writes the showdowns that encode it. */}
      <div className="card">
        <strong>⚖ Resolve a tie (any size)</strong>
        <p className="muted" style={{ fontSize: 12 }}>
          For a 3-way+ tie the single shootout above can&apos;t express. Type a placement for the
          tied players — <strong>1 = winner</strong>. Players with the <strong>same number stay tied</strong>{" "}
          with each other (e.g. <code>1, 2, 2</code> = one winner, the other two left level). Leave
          everyone else blank. Re-submitting overwrites this group.
        </p>
        <form action={resolveTieAction} style={{ display: "grid", gap: 4, maxWidth: 360 }}>
          <input type="hidden" name="divisionId" value={division.id} />
          {members.map((m) => (
            <label key={m.playerId} style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 13 }}>{m.player.displayName}</span>
              <Input type="number" name={`place_${m.playerId}`} min={1} placeholder="—" className="w-16" />
            </label>
          ))}
          <Button type="submit" variant="secondary" style={{ marginTop: 4 }}>Resolve tie</Button>
        </form>
      </div>

    </>
  );
}

// The tie-resolution helper: for each group of tied players, a head-to-head grid
// (who beat whom, and by what score) among just those players, their net-life
// differential vs each other, and any shootout already on record. This is the
// mini-league you use to decide the placements typed into the form below.
function TieHelper({ groups }: { groups: TieGroup[] }) {
  const cell = (r: "win" | "loss" | "draw" | "none") =>
    r === "win"
      ? { bg: "rgba(46,204,113,0.15)", fg: "var(--success)" }
      : r === "loss"
      ? { bg: "rgba(231,76,60,0.15)", fg: "var(--danger)" }
      : r === "draw"
      ? { bg: "rgba(241,196,15,0.15)", fg: "var(--accent)" }
      : { bg: "transparent", fg: "var(--muted)" };

  return (
    <div className="card">
      <strong>🔗 Ties to resolve</strong>
      <p className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
        Only ties that actually decide <strong>promotion or relegation</strong> are shown. For each, the{" "}
        <strong>head-to-head grid</strong> (✓ = beat them, ✗ = lost, = drew, with per-game lives), then a{" "}
        <strong>life table</strong> across every game each tied player played this season: lives kept in wins, lives
        conceded in losses, and <strong>Net ♥</strong> (in wins − conceded) — the tiebreaker to sort by. Expand{" "}
        <em>Every game</em> for the raw list. Then type the placements below.
      </p>
      {groups.length === 0 ? (
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>No ties affecting promotion or relegation right now.</p>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {groups.map((g, gi) => (
            <div key={gi} style={{ borderTop: gi === 0 ? undefined : "1px solid var(--border)", paddingTop: gi === 0 ? 0 : 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                {g.members.length}-way tie on <strong>{g.points}</strong> pts
                <span className="pill" style={{ fontSize: 10, marginLeft: 8, background: "rgba(118,199,255,0.18)", color: "var(--info)" }}>
                  {g.boundary === "both" ? "promotion & relegation" : g.boundary === "promotion" ? "promotion" : "relegation"}
                </span>
                {g.allDecided ? (
                  <span className="pill" style={{ fontSize: 10, marginLeft: 6, background: "rgba(46,204,113,0.16)", color: "var(--success)" }}>head-to-head separates them</span>
                ) : (
                  <span className="pill" style={{ fontSize: 10, marginLeft: 6, background: "rgba(241,196,15,0.16)", color: "var(--accent)" }}>needs a call / shootout</span>
                )}
              </div>
              <div className="table-scroll">
                <table className="table-dense" style={{ margin: 0 }}>
                  <thead>
                    <tr>
                      <th></th>
                      {g.members.map((m) => (
                        <th key={m.playerId} style={{ textAlign: "center", fontSize: 11 }}>{m.displayName}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {g.members.map((m) => {
                      const vs = new Map(m.h2h.map((h) => [h.oppId, h]));
                      return (
                        <tr key={m.playerId}>
                          <td style={{ fontWeight: 500, whiteSpace: "nowrap" }}>{m.displayName}</td>
                          {g.members.map((o) => {
                            if (o.playerId === m.playerId) return <td key={o.playerId} className="muted" style={{ textAlign: "center" }}>·</td>;
                            const h = vs.get(o.playerId);
                            const c = cell(h?.result ?? "none");
                            const mark = h?.result === "win" ? "✓" : h?.result === "loss" ? "✗" : h?.result === "draw" ? "=" : "—";
                            return (
                              <td key={o.playerId} style={{ textAlign: "center", background: c.bg, color: c.fg, fontVariantNumeric: "tabular-nums", verticalAlign: "top" }}>
                                <div>{mark} {h && h.result !== "none" ? h.score : ""}</div>
                                {h && h.games.length > 0 && (
                                  <div style={{ fontSize: 10, marginTop: 1 }}>
                                    {h.games.map((gm, k) => (
                                      <span
                                        key={k}
                                        style={{ marginRight: 4, color: gm.won ? "var(--success)" : "var(--danger)" }}
                                        title={`Game ${gm.num}: ${gm.won ? "won" : "lost"}${gm.lives != null ? `, ${gm.lives} lives` : ""}`}
                                      >
                                        {gm.lives != null ? `♥${gm.lives}` : "♥?"}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {g.shootouts.length > 0 && (
                <p className="muted" style={{ fontSize: 11, margin: "6px 0 0" }}>
                  Shootouts: {g.shootouts.map((s, i) => (
                    <span key={i}>{i > 0 && " · "}<strong style={{ color: "var(--text)" }}>{s.winnerName}</strong> beat {s.loserName}</span>
                  ))}
                </p>
              )}

              {/* Life table across ALL games (the Net ♥ tiebreaker). */}
              <div className="table-scroll" style={{ marginTop: 10 }}>
                <table className="table-dense" style={{ margin: 0 }}>
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th style={{ textAlign: "center" }}>W-L</th>
                      <th style={{ textAlign: "right" }} title="lives kept across games won (avg per win)">♥ in wins</th>
                      <th style={{ textAlign: "right" }} title="opponents' lives across games lost (avg per loss)">♥ conceded</th>
                      <th style={{ textAlign: "right" }} title="lives in wins − lives conceded (across all games this season)">Net ♥</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...g.members]
                      .sort((a, b) => b.livesInWins - b.livesConceded - (a.livesInWins - a.livesConceded))
                      .map((m) => {
                        const net = m.livesInWins - m.livesConceded;
                        return (
                          <tr key={m.playerId}>
                            <td style={{ fontWeight: 500 }}>{m.displayName}</td>
                            <td style={{ textAlign: "center", fontVariantNumeric: "tabular-nums" }}>{m.wins}-{m.losses}</td>
                            <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                              {m.livesInWins}{m.wins > 0 ? <span className="muted"> ({(m.livesInWins / m.wins).toFixed(1)})</span> : ""}
                            </td>
                            <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                              {m.livesConceded}{m.losses > 0 ? <span className="muted"> ({(m.livesConceded / m.losses).toFixed(1)})</span> : ""}
                            </td>
                            <td style={{ textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums", color: net > 0 ? "var(--success)" : net < 0 ? "var(--danger)" : "var(--muted)" }}>
                              {net > 0 ? `+${net}` : net}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>

              {/* Raw per-player game list, collapsed by default. */}
              <details style={{ marginTop: 6 }}>
                <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>Every game (all opponents)</summary>
                <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
                  {g.members.map((m) => (
                    <div key={m.playerId}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{m.displayName}</div>
                      <div style={{ fontSize: 11, marginTop: 2, display: "flex", flexWrap: "wrap", gap: "2px 10px" }}>
                        {m.games.map((gm, k) => (
                          <span key={k} style={{ whiteSpace: "nowrap" }} title={gm.deck || gm.stake ? `${gm.deck ?? "?"} / ${gm.stake ?? "?"}` : "deck/stake not recorded"}>
                            <span className="muted">vs {gm.opponentName}</span>{" "}
                            <span style={{ color: gm.won ? "var(--success)" : "var(--danger)" }}>
                              {gm.won ? "W" : "L"} {gm.lives != null ? `♥${gm.lives}` : "♥?"}
                            </span>
                          </span>
                        ))}
                        {m.games.length === 0 && <span className="muted">no games played</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
