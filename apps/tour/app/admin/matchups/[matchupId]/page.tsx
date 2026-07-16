import Link from "next/link";
import { ArrowLeft, X } from "lucide-react";
import { can, matchupScope } from "@/lib/permissions";
import { getPairingConsole, getMatchupSubOptions } from "@/lib/services/pairing";
import { getMatchupReport } from "@/lib/services/report";
import { Callout } from "@/components/Callout";
import { NoAccess } from "@/components/NoAccess";
import { LiveRefresh } from "@/components/LiveRefresh";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { FormSelect } from "@/components/FormSelect";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmButton } from "@/components/ConfirmButton";
import { SetReportControls } from "@/components/SetReportControls";
import { SeedOrSub } from "@/components/SeedOrSub";
import { DeadlineChip } from "@/components/DeadlineChip";
import {
  overridePairAction,
  autoPairAction,
  setSendFirstAction,
  removePairAction,
  resetPairingAction,
  reassignSetAction,
  setBestOfAction,
} from "./actions";

export const dynamic = "force-dynamic";

type Player = { playerId: string; name: string; seed: number; paired: boolean };
const opts = (players: Player[]) =>
  players.filter((p) => !p.paired).map((p) => ({ value: p.playerId, label: `#${p.seed} ${p.name}` }));

export default async function PairingConsole({ params, searchParams }: { params: Promise<{ matchupId: string }>; searchParams: Promise<{ from?: string }> }) {
  const { matchupId } = await params;
  const { from } = await searchParams;
  // TO, a SCHEDULE mod, or the captain of either team in this matchup.
  const { seasonId, teamSeasonIds } = await matchupScope(matchupId);
  if (!(await can("SCHEDULE", { seasonId, teamSeasonId: teamSeasonIds }))) return <NoAccess what="manage this matchup" />;

  const c = await getPairingConsole(matchupId);
  const report = await getMatchupReport(matchupId);
  const subOpts = await getMatchupSubOptions(matchupId);
  if (!c) {
    return (
      <main>
        <p><Link href="/admin" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> admin</Link></p>
        <h1>Matchup not found</h1>
      </main>
    );
  }

  const enc = encodeURIComponent(c.seasonName);
  const availA = c.teamA.players.filter((p) => !p.paired);
  const availB = c.teamB.players.filter((p) => !p.paired);
  // Back link returns to where you came from (?from=), defaulting to playoffs for a playoff
  // matchup and the schedule otherwise -- so "back" from playoff pairing goes to playoffs.
  const source = from ?? (c.weekKind === "PLAYOFF" ? "playoffs" : "schedule");
  const back =
    source === "playoffs" ? { href: `/admin/seasons/${enc}/playoffs`, label: `${c.seasonName} playoffs` }
      : source === "review" ? { href: `/admin/seasons/${enc}/review`, label: `${c.seasonName} review` }
        : { href: `/admin/seasons/${enc}/schedule`, label: `${c.seasonName} schedule` };

  return (
    <main>
      <LiveRefresh channel={`matchup:${matchupId}`} />
      <p>
        <Link href={back.href} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {back.label}</Link>
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1>
          Week {c.weekNumber} —{" "}
          <Link href={`/teams/${c.teamA.id}`} style={{ color: "inherit" }}>{c.teamA.name}</Link>{" "}
          vs{" "}
          <Link href={`/teams/${c.teamB.id}`} style={{ color: "inherit" }}>{c.teamB.name}</Link>
        </h1>
        {c.pairs.length > 0 && (
          <form action={resetPairingAction}>
            <input type="hidden" name="matchupId" value={c.matchupId} />
            <ConfirmButton message="Clear all pairings for this matchup?" variant="destructive" size="sm">Reset pairings</ConfirmButton>
          </form>
        )}
      </div>
      <p className="sub inline-flex flex-wrap items-center gap-2">
        <span>{c.pairs.length} of {c.targetPairs} sets paired. As TO you pair any two players directly {"—"} the ±{c.windowSize} window is the captains&apos; negotiation rule, not a gate here.</span>
        <DeadlineChip deadline={c.deadlineAt} prefix="play by" />
      </p>

      {/* Coinflip / send-first — only drives the captain-facing negotiation flow. */}
      <div className="card">
        <div className="flex flex-wrap items-center gap-2">
          <span className="sub" title="For the captains' live pairing flow: the coinflip winner proposes first. Doesn't affect TO pairing below.">Captain flow {"—"} proposes first:</span>
          {(["A", "B"] as const).map((t) => {
            const team = t === "A" ? c.teamA : c.teamB;
            const active = c.sendFirst === t;
            return (
              <form key={t} action={setSendFirstAction}>
                <input type="hidden" name="matchupId" value={c.matchupId} />
                <input type="hidden" name="team" value={t} />
                <SubmitButton size="sm" variant={active ? "default" : "secondary"}>{team.name}</SubmitButton>
              </form>
            );
          })}
        </div>
      </div>

      {/* Completed pairs */}
      {c.pairs.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>{c.teamA.name}</th>
                <th>{c.teamB.name}</th>
                <th className="num" title="pairing offset — blank means seed-for-seed">±</th>
                <th className="num">Bo</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {c.pairs.map((p) => (
                <tr key={p.setId}>
                  <td><SeedOrSub seed={p.aSeed} isSub={p.aIsSub} /> <Link href={`/players/${p.aPlayerId}`} style={{ color: "inherit" }}>{p.aName}</Link></td>
                  <td><SeedOrSub seed={p.bSeed} isSub={p.bIsSub} /> <Link href={`/players/${p.bPlayerId}`} style={{ color: "inherit" }}>{p.bName}</Link></td>
                  <td className="num">
                    {/* Off-seed offset only makes sense between two seed-holders. */}
                    {!p.aIsSub && !p.bIsSub && p.bSeed !== p.aSeed && (
                      <span style={{ color: "var(--warning, #f5a524)" }} title={`Not seed-for-seed: #${p.aSeed} vs #${p.bSeed}`}>
                        {p.bSeed > p.aSeed ? "+" : ""}{p.bSeed - p.aSeed}
                      </span>
                    )}
                  </td>
                  <td className="num">{p.bestOf}</td>
                  <td className="sub">{p.status}</td>
                  <td>
                    <form action={removePairAction}>
                      <input type="hidden" name="matchupId" value={c.matchupId} />
                      <input type="hidden" name="setId" value={p.setId} />
                      <SubmitButton size="sm" variant="secondary" pendingText="…"><X className="size-3.5" /></SubmitButton>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pair the remaining players — one direct TO form, no propose/respond theater. */}
      {c.complete ? (
        <Callout type="success">All {c.targetPairs} sets paired — ready to schedule and report.</Callout>
      ) : (
        <div className="card card-accent">
          {c.deadlocked && (
            <p className="sub" style={{ color: "var(--warning, #f5a524)", marginTop: 0 }}>
              Heads-up: the remaining players can&apos;t all be paired within ±{c.windowSize} seeds {"—"} some pairs here will be off-window, which is fine by TO authority.
            </p>
          )}
          <div className="bracket-title">Pair players</div>
          <ActionFlashForm action={autoPairAction} className="mb-2">
            <input type="hidden" name="matchupId" value={c.matchupId} />
            <div className="flex flex-wrap items-center gap-2">
              <SubmitButton pendingText="Pairing…">Auto-pair seed-for-seed</SubmitButton>
              <span className="sub">Pairs every remaining player {c.teamA.name} #1 vs {c.teamB.name} #1, #2 vs #2, and so on.</span>
            </div>
          </ActionFlashForm>
          <ActionFlashForm action={overridePairAction}>
            <input type="hidden" name="matchupId" value={c.matchupId} />
            <div className="flex flex-wrap items-end gap-2">
              <label className="block"><span className="sub">{c.teamA.name}</span><FormSelect name="aPlayerId" options={opts(availA)} /></label>
              <label className="block"><span className="sub">{c.teamB.name}</span><FormSelect name="bPlayerId" options={opts(availB)} /></label>
              <SubmitButton pendingText="Pairing…">Pair</SubmitButton>
            </div>
          </ActionFlashForm>
          <p className="sub mt-2">
            Available — {c.teamA.name}: {availA.map((p) => `#${p.seed} ${p.name}`).join(", ") || "none"} · {c.teamB.name}: {availB.map((p) => `#${p.seed} ${p.name}`).join(", ") || "none"}
          </p>
        </div>
      )}

      {/* Results / reporting */}
      {report && report.sets.length > 0 && (
        <>
          <h2 className="mt-6 mb-1 text-[1.1rem]">Results</h2>
          <div className="card card-accent" style={{ marginBottom: "0.75rem" }}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold"><Link href={`/teams/${report.teamASeasonId}`} style={{ color: "inherit" }}>{report.teamAName}</Link></span>
              <span className="value" style={{ fontSize: 22 }}>{report.setsWonA} – {report.setsWonB}</span>
              <span className="font-semibold"><Link href={`/teams/${report.teamBSeasonId}`} style={{ color: "inherit" }}>{report.teamBName}</Link></span>
            </div>
            <p className="sub mt-1" style={{ textAlign: "center" }}>
              {report.decided
                ? report.winnerTeamName
                  ? `${report.winnerTeamName} wins the week`
                  : "Drawn"
                : `First to ${report.setsToWin} set wins · in progress`}
            </p>
          </div>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>{report.teamAName}</th>
                  <th>{report.teamBName}</th>
                  <th className="num">Bo</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {report.sets.map((s) => (
                  <tr key={s.setId}>
                    <td style={{ fontWeight: s.winner === "A" ? 700 : undefined }}>
                      <SeedOrSub seed={s.aSeed} isSub={s.aIsSub} /> <Link href={`/players/${s.aPlayerId}`} style={{ color: "inherit" }}>{s.aName}</Link>
                      {s.reassignedFrom && <span className="sub" title={`makeup — originally ${s.reassignedFrom}`}> (sub for {s.reassignedFrom})</span>}
                    </td>
                    <td style={{ fontWeight: s.winner === "B" ? 700 : undefined }}>
                      <SeedOrSub seed={s.bSeed} isSub={s.bIsSub} /> <Link href={`/players/${s.bPlayerId}`} style={{ color: "inherit" }}>{s.bName}</Link>
                      {!s.aIsSub && !s.bIsSub && s.bSeed !== s.aSeed && (
                        <span className="sub" style={{ color: "var(--warning, #f5a524)" }} title={`Not seed-for-seed: #${s.aSeed} vs #${s.bSeed}`}>
                          {" "}({s.bSeed > s.aSeed ? "+" : ""}{s.bSeed - s.aSeed})
                        </span>
                      )}
                    </td>
                    <td className="num">
                      {/* Bo is editable in place — e.g. fix a set created under the wrong season default. */}
                      <ActionFlashForm action={setBestOfAction}>
                        <span className="inline-flex items-center gap-1">
                          <input type="hidden" name="matchupId" value={matchupId} />
                          <input type="hidden" name="setId" value={s.setId} />
                          <input
                            type="number" name="bestOf" min={1} max={15} step={2} defaultValue={s.bestOf}
                            title="Best-of for this set"
                            className="w-12 rounded border border-[var(--border)] bg-[var(--surface-2)] px-1 py-0.5 text-center"
                          />
                          <SubmitButton size="sm" variant="secondary" pendingText="…" title="Save best-of">Bo</SubmitButton>
                        </span>
                      </ActionFlashForm>
                    </td>
                    <td>
                      <SetReportControls
                        matchupId={matchupId}
                        setId={s.setId}
                        aName={s.aName}
                        bName={s.bName}
                        bestOf={s.bestOf}
                        reported={s.reported}
                        outcome={s.outcome}
                      />
                      {/* Sub-in for a makeup set (only while unplayed) */}
                      {!s.played && subOpts && (
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <span className="sub" title="Replace who plays this unplayed set — e.g. a makeup the original can't play">Sub in:</span>
                          {(["A", "B"] as const).map((side) => (
                            <ActionFlashForm key={side} action={reassignSetAction}>
                              <input type="hidden" name="matchupId" value={matchupId} />
                              <input type="hidden" name="setId" value={s.setId} />
                              <input type="hidden" name="side" value={side} />
                              <span className="inline-flex items-center gap-1">
                                <FormSelect name="inPlayerId" size="sm" options={[{ value: "", label: side === "A" ? report.teamAName : report.teamBName }, ...((side === "A" ? subOpts.subsA : subOpts.subsB).map((p) => ({ value: p.id, label: p.name })))]} placeholder={side === "A" ? report.teamAName : report.teamBName} />
                                <SubmitButton size="sm" variant="secondary" pendingText="…">↪</SubmitButton>
                              </span>
                            </ActionFlashForm>
                          ))}
                        </div>
                      )}
                    </td>
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
