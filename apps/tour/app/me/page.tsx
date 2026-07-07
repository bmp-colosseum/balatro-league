import Link from "next/link";
import { LogIn, Crown, ArrowRight } from "lucide-react";
import { getViewer } from "@/lib/auth";
import { getPlayerHome } from "@/lib/player-home";
import { getPlayerStrikes } from "@/lib/services/strikes";
import { getCaptainMatchups } from "@/lib/services/pairing";
import { weekDeadlinesByName } from "@/lib/services/deadlines";
import { getMyFantasy } from "@/lib/services/fantasy";
import { getMyPickem } from "@/lib/services/pickem";
import { myRecentRequests } from "@/lib/services/roster-requests";
import { Callout } from "@/components/Callout";
import { DeadlineChip } from "@/components/DeadlineChip";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { FormSelect } from "@/components/FormSelect";
import { SubmitButton } from "@/components/SubmitButton";
import { DECKS, STAKES } from "@/lib/balatro";
import { LiveRefresh } from "@/components/LiveRefresh";
import { reportSetAction, confirmSetAction, disputeSetAction, renameMyTeamAction } from "./actions";

const g = "w-12 rounded border border-[var(--border)] bg-[var(--surface-2)] px-1 py-0.5 text-center";
const deckOpts = [{ value: "", label: "deck" }, ...DECKS.map((d) => ({ value: d, label: d }))];
const stakeOpts = [{ value: "", label: "stake" }, ...STAKES.map((s) => ({ value: s, label: s }))];

export const dynamic = "force-dynamic";

const STATUS_COLOR: Record<string, string> = {
  PROPOSED: "var(--muted)",
  SCHEDULED: "var(--accent-2)",
  REPORTED: "var(--accent-2)",
  CONFIRMED: "var(--success)",
  DISPUTED: "var(--danger)",
  FORFEIT: "var(--danger)",
};

const REQ_STATUS_COLOR: Record<string, string> = {
  PENDING: "var(--accent-2)",
  APPROVED: "var(--success)",
  REJECTED: "var(--danger)",
  CANCELLED: "var(--muted)",
};

export default async function MyTour() {
  const viewer = await getViewer();

  if (!viewer.discordId) {
    return (
      <main>
        <h1>My Tour</h1>
        <p className="sub">Sign in with Discord to see your team, schedule, and sets.</p>
        <Link href="/auth/signin" className="inline-flex items-center gap-1.5"><LogIn className="size-4" /> Sign in with Discord</Link>
      </main>
    );
  }

  if (!viewer.playerId) {
    return (
      <main>
        <h1>My Tour</h1>
        <p className="sub">Signed in as <strong>{viewer.name ?? viewer.discordId}</strong>.</p>
        <Callout type="info">
          Your Discord isn&apos;t linked to a Team Tour player yet — you&apos;ll appear here once you&apos;ve been drafted
          onto a team. If a season is open, <Link href="/signup">sign up</Link>.
        </Callout>
      </main>
    );
  }

  const [home, strikes] = await Promise.all([getPlayerHome(viewer.playerId), getPlayerStrikes(viewer.playerId)]);
  const focusTeam = home.teams.find((t) => t.seasonName === home.focusSeason);
  const enc = focusTeam ? encodeURIComponent(focusTeam.seasonName) : "";
  const captainMatchups = focusTeam?.isCaptain && home.focusSeason ? await getCaptainMatchups(home.focusSeason, viewer.playerId) : [];
  const deadlines = focusTeam ? await weekDeadlinesByName(focusTeam.seasonName) : new Map<number, Date | null>();
  const [myFantasy, myPickem] = focusTeam
    ? await Promise.all([getMyFantasy(focusTeam.seasonName, viewer.discordId), getMyPickem(focusTeam.seasonName, viewer.discordId)])
    : [null, null];
  // The round-trip: roster changes this player filed as a captain, and how they were decided.
  const myReqs = await myRecentRequests(viewer.discordId, 8);

  // "On your clock" -- what needs action right now, hoisted above the reference tables.
  const setsToReport = home.sets.filter((s) => s.canReport);
  const setsToConfirm = home.sets.filter((s) => s.awaitingMyConfirm);
  const weeksToPair = captainMatchups.filter((mu) => !mu.decided);
  const pendingCount = setsToReport.length + setsToConfirm.length + weeksToPair.length;
  const pendingTargets = [
    ...setsToReport.map((s) => deadlines.get(s.week) ?? null),
    ...setsToConfirm.map((s) => deadlines.get(s.week) ?? null),
    ...weeksToPair.map((mu) => mu.deadline),
  ].filter((d): d is Date => d != null);
  const nextTarget = pendingTargets.length ? pendingTargets.reduce((a, b) => (a < b ? a : b)) : null;

  return (
    <main>
      <LiveRefresh channel="sets" />
      <h1>My Tour</h1>
      <p className="sub">
        Signed in as <strong>{viewer.name ?? viewer.discordId}</strong> ·{" "}
        <Link href={`/players/${viewer.playerId}`}>public profile <ArrowRight className="inline size-3.5" /></Link>
      </p>

      {strikes.total > 0 && (
        <Callout type={strikes.atRisk ? "danger" : "admin"}>
          You have <strong>{strikes.total}</strong> reliability note{strikes.total === 1 ? "" : "s"} on record
          {strikes.atRisk ? " — please make sure you're communicating and scheduling on time." : "."} A TO logs these to keep
          weeks moving; reach out if anything looks off.
        </Callout>
      )}

      {home.teams.length === 0 && (
        <Callout type="info">You&apos;re not on a roster yet.</Callout>
      )}

      {/* On your clock -- action-first summary; the tables below carry the actual forms. */}
      {focusTeam && (
        pendingCount > 0 ? (
          <div className="card card-accent" style={{ marginTop: "0.75rem" }}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="bracket-title" style={{ padding: 0 }}>On your clock</span>
              {setsToReport.length > 0 && <span className="badge" style={{ color: "var(--accent-2)" }}>{setsToReport.length} to report</span>}
              {setsToConfirm.length > 0 && <span className="badge" style={{ color: "var(--accent-2)" }}>{setsToConfirm.length} to confirm</span>}
              {weeksToPair.length > 0 && <span className="badge" style={{ color: "var(--accent)" }}>{weeksToPair.length} week{weeksToPair.length === 1 ? "" : "s"} to pair</span>}
              {nextTarget && <DeadlineChip deadline={nextTarget} prefix="next" />}
            </div>
            <p className="sub" style={{ margin: "6px 0 0" }}>Sort these out below -- report and confirm your sets, and pair any weeks you captain.</p>
          </div>
        ) : (
          <Callout type="success">You&apos;re all caught up here -- the bot keeps the week moving.</Callout>
        )
      )}

      {/* Pick'em & Fantasy -- the plain player's reason to open the site; the bot runs their
          actual match ops. Hoisted above the captain/roster tables so it's front and center. */}
      {focusTeam && (myPickem || myFantasy) && (
        <>
          <h2 className="mt-6 mb-1 text-[1.1rem]">Pick&apos;em &amp; Fantasy</h2>
          <div className="card flex flex-col gap-2">
            {myPickem && (
              <div className="flex flex-wrap items-center gap-2">
                <span style={{ color: myPickem.unmade > 0 ? "var(--accent-2)" : "var(--muted)" }}>
                  {myPickem.unmade > 0 ? `${myPickem.unmade} pick${myPickem.unmade === 1 ? "" : "s"} to make` : "all picks in"}
                </span>
                {myPickem.nextLock && <DeadlineChip deadline={myPickem.nextLock} prefix="locks" />}
                {myPickem.decided > 0 && <span className="sub num">{myPickem.correct}/{myPickem.decided}</span>}
                <Link href={`/seasons/${enc}/pickem`}>Make picks -&gt;</Link>
              </div>
            )}
            {myFantasy && (
              <div className="flex flex-wrap items-center gap-2">
                {myFantasy.state === "OPEN" && !myFantasy.joined ? (
                  <>
                    <span>Fantasy draft is open</span>
                    <Link href={`/seasons/${enc}/fantasy`}>Join -&gt;</Link>
                  </>
                ) : myFantasy.state === "DRAFTING" && myFantasy.myTurn ? (
                  <>
                    <span style={{ color: "var(--accent)" }}>You&apos;re on the clock in the fantasy draft</span>
                    <Link href={`/seasons/${enc}/fantasy`}>Draft -&gt;</Link>
                  </>
                ) : myFantasy.joined && myFantasy.rank != null ? (
                  <>
                    <span>Fantasy: {myFantasy.rank} of {myFantasy.of} ({myFantasy.points} pts)</span>
                    <Link href={`/seasons/${enc}/fantasy`}>View -&gt;</Link>
                  </>
                ) : (
                  <>
                    <span>Fantasy</span>
                    <Link href={`/seasons/${enc}/fantasy`}>View -&gt;</Link>
                  </>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {myReqs.length > 0 && (
        <>
          <h2 className="mt-6 mb-1 text-[1.1rem]">Your roster requests</h2>
          <div className="card">
            <table>
              <thead><tr><th>Change</th><th>Status</th><th>Note</th></tr></thead>
              <tbody>
                {myReqs.map((r) => (
                  <tr key={r.id}>
                    <td><span className="badge">{r.kindLabel}</span> {r.summary} <span className="sub">({r.teamName})</span></td>
                    <td><span className="badge" style={{ color: REQ_STATUS_COLOR[r.status] ?? "var(--muted)" }}>{r.status.toLowerCase()}</span></td>
                    <td className="sub">{r.status === "REJECTED" && r.decisionNote ? r.decisionNote : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {captainMatchups.length > 0 && (
        <>
          <h2 className="mt-6 mb-1 text-[1.1rem]">Captain — pair your weeks</h2>
          <div className="card">
            <table>
              <thead><tr><th className="num">Wk</th><th>Opponent</th><th>Target</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {captainMatchups.map((mu) => (
                  <tr key={mu.matchupId}>
                    <td className="num">W{mu.week}</td>
                    <td>vs <Link href={`/teams/${mu.oppTeamSeasonId}`}>{mu.opponent}</Link></td>
                    <td><DeadlineChip deadline={mu.deadline} /></td>
                    <td className="sub">{mu.status}</td>
                    <td style={{ textAlign: "right" }}>
                      {mu.decided ? <span className="sub">done</span> : <Link href={`/matchups/${mu.matchupId}`}>Pair →</Link>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {focusTeam && (
        <>
          <h2 className="mt-6 mb-1 text-[1.1rem]">Your sets — <Link href={`/seasons/${encodeURIComponent(focusTeam.seasonName)}`}>{focusTeam.seasonName}</Link></h2>
          {home.sets.length === 0 ? (
            <div className="card"><p className="sub">No sets assigned yet. When your captain pairs the week&apos;s lineup, your matchups show up here.</p></div>
          ) : (
            <div className="card">
              <table>
                <thead><tr><th className="num">Wk</th><th>Target</th><th>Opponent</th><th>Result / action</th></tr></thead>
                <tbody>
                  {home.sets.map((s) => (
                    <tr key={s.setId}>
                      <td className="num">W{s.week}</td>
                      <td><DeadlineChip deadline={deadlines.get(s.week) ?? null} /></td>
                      <td style={{ fontWeight: s.result === "won" ? 700 : undefined }}>vs <Link href={`/players/${s.opponentId}`}>{s.opponentName}</Link></td>
                      <td>
                        {s.status === "CONFIRMED" ? (
                          <span>
                            <strong style={{ color: s.result === "won" ? "var(--success)" : s.result === "lost" ? "var(--danger)" : undefined }}>
                              {s.result === "won" ? "Won" : s.result === "lost" ? "Lost" : "Tie"}
                            </strong>{" "}
                            <span className="num">{s.myGames}–{s.oppGames}</span>
                          </span>
                        ) : s.awaitingMyConfirm ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <span>Opponent reported <strong>{s.myGames}–{s.oppGames}</strong> (your side).</span>
                            <ActionFlashForm action={confirmSetAction}>
                              <input type="hidden" name="setId" value={s.setId} />
                              <SubmitButton size="sm" pendingText="…">Confirm</SubmitButton>
                            </ActionFlashForm>
                            <ActionFlashForm action={disputeSetAction}>
                              <input type="hidden" name="setId" value={s.setId} />
                              <span className="inline-flex items-center gap-1">
                                <input name="reason" placeholder="reason" className="w-28 rounded border border-[var(--border)] bg-[var(--surface-2)] px-1 py-0.5" />
                                <SubmitButton size="sm" variant="secondary" pendingText="…">Dispute</SubmitButton>
                              </span>
                            </ActionFlashForm>
                          </div>
                        ) : s.awaitingOpponent ? (
                          <span className="sub">Reported <strong>{s.myGames}–{s.oppGames}</strong> — waiting for <Link href={`/players/${s.opponentId}`}>{s.opponentName}</Link> to confirm.</span>
                        ) : s.canReport ? (
                          <ActionFlashForm action={reportSetAction}>
                            <input type="hidden" name="setId" value={s.setId} />
                            <span className="inline-flex items-center gap-1">
                              {s.status === "DISPUTED" && <span className="badge" style={{ color: "var(--danger)" }}>disputed</span>}
                              <span className="sub">you</span>
                              <input type="number" name="myGames" min={0} className={g} />
                              <span className="sub">–</span>
                              <input type="number" name="oppGames" min={0} className={g} />
                              <span className="sub">{s.opponentName}</span>
                              <SubmitButton size="sm" pendingText="…">Report</SubmitButton>
                            </span>
                            <details className="mt-1">
                              <summary className="sub" style={{ cursor: "pointer" }}>Log decks per game (optional — fills the score for you)</summary>
                              <div className="mt-1 flex flex-col gap-1">
                                {Array.from({ length: s.bestOf }, (_, i) => i + 1).map((n) => (
                                  <span key={n} className="inline-flex flex-wrap items-center gap-1">
                                    <span className="sub" style={{ width: "3.2rem" }}>Game {n}</span>
                                    <FormSelect name={`game${n}Deck`} size="sm" options={deckOpts} placeholder="deck" />
                                    <FormSelect name={`game${n}Stake`} size="sm" options={stakeOpts} placeholder="stake" />
                                    <FormSelect name={`game${n}Winner`} size="sm" options={[{ value: "", label: "winner" }, { value: "me", label: "you" }, { value: "opp", label: s.opponentName }]} placeholder="winner" />
                                  </span>
                                ))}
                              </div>
                            </details>
                          </ActionFlashForm>
                        ) : (
                          <span className="badge" style={{ color: STATUS_COLOR[s.status] ?? "var(--muted)" }}>{s.status}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {home.teams.length > 0 && (
        <>
          <h2 className="mt-6 mb-1 text-[1.1rem]">Your teams</h2>
          <div className="card">
            <table>
              <thead><tr><th>Season</th><th>Team</th><th className="num">Seed</th><th>Role</th><th></th></tr></thead>
              <tbody>
                {home.teams.map((t) => (
                  <tr key={t.teamSeasonId}>
                    <td><Link href={`/seasons/${encodeURIComponent(t.seasonName)}`}>{t.seasonName}</Link>{t.active && <span className="badge" style={{ marginLeft: 6 }}>active</span>}</td>
                    <td>
                      <Link href={`/teams/${t.teamSeasonId}`}>{t.teamName}</Link>
                      {(t.isCaptain || t.isCoCaptain) && t.active && (
                        <details className="mt-0.5">
                          <summary className="sub" style={{ cursor: "pointer" }}>rename</summary>
                          <ActionFlashForm action={renameMyTeamAction} className="mt-1 flex items-center gap-1.5">
                            <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
                            <input name="teamName" defaultValue={t.teamName} required maxLength={48} className="w-44 rounded border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5" />
                            <SubmitButton size="sm" variant="secondary" pendingText="...">Save</SubmitButton>
                          </ActionFlashForm>
                        </details>
                      )}
                    </td>
                    <td className="num">{t.seed}</td>
                    <td className="sub">{t.isCaptain ? <span className="inline-flex items-center gap-1"><Crown className="size-3.5 text-[var(--accent)]" /> Captain</span> : t.isCoCaptain ? <span className="inline-flex items-center gap-1"><Crown className="size-3.5 text-[var(--muted)]" /> Co-captain</span> : "Player"}</td>
                    <td style={{ textAlign: "right" }}><Link href={`/seasons/${encodeURIComponent(t.seasonName)}`}>Season &rarr;</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
