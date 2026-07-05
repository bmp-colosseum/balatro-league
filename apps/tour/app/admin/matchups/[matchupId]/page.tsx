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
import {
  makePairAction,
  overridePairAction,
  setSendFirstAction,
  removePairAction,
  resetPairingAction,
  reassignSetAction,
} from "./actions";

export const dynamic = "force-dynamic";

type Player = { playerId: string; name: string; seed: number; paired: boolean };
const opts = (players: Player[]) =>
  players.filter((p) => !p.paired).map((p) => ({ value: p.playerId, label: `#${p.seed} ${p.name}` }));

export default async function PairingConsole({ params }: { params: Promise<{ matchupId: string }> }) {
  const { matchupId } = await params;
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
  const proposing = c.proposerTeam === "B" ? c.teamB : c.teamA;
  const responding = c.proposerTeam === "B" ? c.teamA : c.teamB;
  const availA = c.teamA.players.filter((p) => !p.paired);
  const availB = c.teamB.players.filter((p) => !p.paired);

  return (
    <main>
      <LiveRefresh channel={`matchup:${matchupId}`} />
      <p>
        <Link href={`/admin/seasons/${enc}/schedule`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {c.seasonName} schedule</Link>
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1>Week {c.weekNumber} — {c.teamA.name} vs {c.teamB.name}</h1>
        {c.pairs.length > 0 && (
          <form action={resetPairingAction}>
            <input type="hidden" name="matchupId" value={c.matchupId} />
            <ConfirmButton message="Clear all pairings for this matchup?" variant="destructive" size="sm">Reset pairings</ConfirmButton>
          </form>
        )}
      </div>
      <p className="sub">Each player pairs an opponent within ±{c.windowSize} seeds. {c.pairs.length} of {Math.min(c.teamA.players.length, c.teamB.players.length)} sets paired.</p>

      {/* Coinflip / send-first */}
      <div className="card">
        <div className="flex flex-wrap items-center gap-2">
          <span className="sub">Proposes first:</span>
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
                <th className="rank">#</th>
                <th>{c.teamA.name}</th>
                <th>{c.teamB.name}</th>
                <th className="num">Bo</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {c.pairs.map((p, i) => (
                <tr key={p.setId}>
                  <td className="rank">{i + 1}</td>
                  <td>#{p.aSeed} {p.aName}</td>
                  <td>#{p.bSeed} {p.bName}</td>
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

      {/* Next pair / override / done */}
      {c.complete ? (
        <Callout type="success">All players paired — {c.pairs.length} sets ready to schedule and report.</Callout>
      ) : c.deadlocked ? (
        <>
          <Callout type="danger">
            Dead-end: the remaining players can&apos;t complete a ±{c.windowSize} pairing. Pair the rest manually (TO override).
          </Callout>
          <div className="card">
            <div className="bracket-title">TO override (bypasses ±{c.windowSize})</div>
            <ActionFlashForm action={overridePairAction}>
              <input type="hidden" name="matchupId" value={c.matchupId} />
              <div className="flex flex-wrap items-end gap-2">
                <label className="block"><span className="sub">{c.teamA.name}</span><FormSelect name="aPlayerId" options={opts(availA)} /></label>
                <label className="block"><span className="sub">{c.teamB.name}</span><FormSelect name="bPlayerId" options={opts(availB)} /></label>
                <SubmitButton variant="secondary" pendingText="Pairing…">Override pair</SubmitButton>
              </div>
            </ActionFlashForm>
          </div>
        </>
      ) : (
        <div className="card card-accent">
          <div className="bracket-title">{proposing.name} proposes · {responding.name} answers within ±{c.windowSize}</div>
          <ActionFlashForm action={makePairAction}>
            <input type="hidden" name="matchupId" value={c.matchupId} />
            <div className="flex flex-wrap items-end gap-2">
              <label className="block">
                <span className="sub">{proposing.name} (proposes)</span>
                <FormSelect name="proposerPlayerId" options={opts(proposing.players)} />
              </label>
              <label className="block">
                <span className="sub">{responding.name} (responds)</span>
                <FormSelect name="responderPlayerId" options={opts(responding.players)} />
              </label>
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
              <span className="font-semibold">{report.teamAName}</span>
              <span className="value" style={{ fontSize: 22 }}>{report.setsWonA} – {report.setsWonB}</span>
              <span className="font-semibold">{report.teamBName}</span>
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
                  <th>Report (games {report.teamAName}–{report.teamBName})</th>
                </tr>
              </thead>
              <tbody>
                {report.sets.map((s) => (
                  <tr key={s.setId}>
                    <td style={{ fontWeight: s.winner === "A" ? 700 : undefined }}>
                      #{s.aSeed} {s.aName}
                      {s.reassignedFrom && <span className="sub" title={`makeup — originally ${s.reassignedFrom}`}> (sub for {s.reassignedFrom})</span>}
                    </td>
                    <td style={{ fontWeight: s.winner === "B" ? 700 : undefined }}>#{s.bSeed} {s.bName}</td>
                    <td className="num">{s.bestOf}</td>
                    <td>
                      <SetReportControls
                        matchupId={matchupId}
                        setId={s.setId}
                        teamAName={report.teamAName}
                        teamBName={report.teamBName}
                        reported={s.reported}
                        teamAGames={s.teamAGames}
                        teamBGames={s.teamBGames}
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
