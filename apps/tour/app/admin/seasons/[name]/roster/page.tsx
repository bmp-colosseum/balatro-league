import Link from "next/link";
import { ArrowLeft, Crown, X, RefreshCw, UserMinus, UserPlus, Undo2, ShieldAlert, AlertTriangle, ArrowUpDown } from "lucide-react";
import { getViewer, isAdmin } from "@/lib/auth";
import { capabilitiesFor, captainTeamsFor, seasonIdByName } from "@/lib/permissions";
import { getRosterOps } from "@/lib/services/roster-ops";
import { STRIKE_KINDS, STRIKE_LABEL } from "@/lib/services/strikes";
import { NoAccess } from "@/components/NoAccess";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { FormSelect } from "@/components/FormSelect";
import { SubmitButton } from "@/components/SubmitButton";
import { substituteAction, departureAction, replaceAction, reinstateAction, removeMoveAction, changeCaptainAction, reseedAction, swapSeedsAction, addStrikeAction, removeStrikeAction, setCoCaptainAction, convertToSubAction, makePermanentAction } from "./actions";

export const dynamic = "force-dynamic";

const inputCls = "rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5";
const opt = (items: { value: string; label: string }[]) => [{ value: "", label: "— select —" }, ...items];

export default async function RosterOpsAdmin({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const { name } = await params;
  const { week } = await searchParams;
  const seasonName = decodeURIComponent(name);
  const enc = encodeURIComponent(seasonName);

  // ROSTERS mod / TO see every team; a captain sees only the team(s) they captain.
  const to = await isAdmin();
  const seasonId = to ? null : await seasonIdByName(seasonName);
  const viewer = to ? null : await getViewer();
  const isMod = to || !!(viewer && (await capabilitiesFor(viewer, seasonId)).has("ROSTERS"));
  const myTeams = !isMod && viewer ? await captainTeamsFor(viewer, seasonId) : null;
  if (!isMod && !(myTeams && myTeams.size)) return <NoAccess what="manage rosters" />;

  const data = await getRosterOps(seasonName, week ? Number(week) : undefined);

  if (!data) {
    return (
      <main>
        <p><Link href="/admin" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> admin</Link></p>
        <h1>Season not found</h1>
      </main>
    );
  }

  // Captains only see (and act on) their own team(s).
  const teams = myTeams ? data.teams.filter((t) => myTeams.has(t.teamSeasonId)) : data.teams;
  const faOpts = data.freeAgents.map((p) => ({ value: p.id, label: p.name }));
  const allLineup = teams.flatMap((t) => t.lineup.map((p) => ({ value: p.playerId, label: `${p.name} (${t.name})` })));
  const weekTabs = data.weeks.length ? data.weeks : [1];

  return (
    <main>
      <p>
        <Link href={`/admin/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {seasonName}</Link>
      </p>
      <h1>Roster ops</h1>
      <p className="sub">
        Lineups are <strong>derived per week</strong> from an append-only move log — subs, quits, bans and replacements
        are recorded, never overwritten, so the full history is preserved. Free-agent pool: {data.freeAgents.length}.
      </p>

      {/* Week selector */}
      <div className="card">
        <div className="flex flex-wrap items-center gap-2">
          <span className="sub">Lineup as of week:</span>
          {weekTabs.map((n) => (
            <Link
              key={n}
              href={`?week=${n}`}
              className="pill hover:no-underline"
              style={{
                background: n === data.selectedWeek ? "var(--accent-2)" : "var(--surface-2)",
                color: n === data.selectedWeek ? "#fff" : "var(--muted)",
                border: "1px solid var(--border)",
              }}
            >
              W{n}
            </Link>
          ))}
          {data.weeks.length === 0 && <span className="sub">— no schedule yet; showing week 1 —</span>}
        </div>
      </div>

      {/* Teams: derived lineup + actions */}
      <div className="grid grid-2">
        {teams.map((t) => {
          const lineupOpts = t.lineup.map((p) => ({ value: p.playerId, label: `#${p.seed} ${p.name}` }));
          return (
            <div className="card" key={t.teamSeasonId} style={{ marginBottom: 0 }}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold"><Link href={`/teams/${t.teamSeasonId}`} style={{ color: "inherit" }}>{t.name}</Link></span>
                <span className="badge">W{data.selectedWeek} · {t.lineup.length} active</span>
              </div>
              <ol className="mt-2 list-none p-0" style={{ margin: 0 }}>
                {t.lineup.map((p) => {
                  const st = data.strikeOf[p.playerId];
                  return (
                    <li key={p.playerId} className="flex items-baseline gap-2 py-0.5">
                      <span className="rank" style={{ width: "1.4rem" }}>{p.seed}</span>
                      {p.isCaptain && <Crown className="size-3.5 shrink-0 text-[var(--accent)]" />}
                      <span><Link href={`/players/${p.playerId}`} style={{ color: "inherit" }}>{p.name}</Link></span>
                      {p.isCoCaptain && <span className="badge" title="Co-captain — same team powers as the captain">CC</span>}
                      {p.viaSub && <span className="badge">sub</span>}
                      {st && st.season > 0 && (
                        <span className="badge inline-flex items-center gap-1" style={{ color: st.atRisk ? "var(--danger)" : "var(--accent-2)" }} title={`${st.season} this season · ${st.career} career${st.atRisk ? " · at risk" : ""}`}>
                          {st.atRisk && <AlertTriangle className="size-3" />}{st.season}⚑
                        </span>
                      )}
                    </li>
                  );
                })}
                {t.lineup.length === 0 && <li className="sub">No active players this week.</li>}
              </ol>

              {/* Sub stints are ALWAYS listed (the lineup above only shows the selected week,
                  so a sub whose window is elsewhere would otherwise be invisible here). */}
              {t.subStints.length > 0 && (
                <p className="sub" style={{ marginTop: "0.35rem" }}>
                  Subs:{" "}
                  {t.subStints.map((s, i) => (
                    <span key={`${s.playerId}-${i}`}>
                      {i > 0 && ", "}
                      <Link href={`/players/${s.playerId}`} style={{ color: "inherit" }}>{s.name}</Link>{" "}
                      <span title={s.activeNow ? "active in the selected week" : "window outside the selected week"}>
                        ({s.window}{s.activeNow ? "" : " · not this week"})
                      </span>
                    </span>
                  ))}
                </p>
              )}

              {/* Change captain */}
              <div className="bracket-title mt-3">Captain</div>
              <ActionFlashForm action={changeCaptainAction}>
                <input type="hidden" name="season" value={seasonName} />
                <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block"><span className="sub">New captain</span><FormSelect name="newCaptainPlayerId" options={opt(lineupOpts)} /></label>
                  <label className="block"><span className="sub">From week</span><input type="number" name="effectiveWeek" min={1} defaultValue={data.selectedWeek} className={`${inputCls} w-16`} /></label>
                  <input name="reason" placeholder="reason" className={`${inputCls} w-36`} />
                  <SubmitButton size="sm" variant="secondary" pendingText="…"><Crown className="size-3.5" /> Set captain</SubmitButton>
                </div>
              </ActionFlashForm>

              {/* Co-captain (same team powers as the captain; toggleable) */}
              <div className="bracket-title mt-3">Co-captain</div>
              <ActionFlashForm action={setCoCaptainAction}>
                <input type="hidden" name="season" value={seasonName} />
                <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block"><span className="sub">Player</span><FormSelect name="playerId" options={opt(lineupOpts)} /></label>
                  <SubmitButton size="sm" variant="secondary" name="isCoCaptain" value="true" pendingText="…">Make co-captain</SubmitButton>
                  <SubmitButton size="sm" variant="secondary" name="isCoCaptain" value="false" pendingText="…">Remove</SubmitButton>
                </div>
              </ActionFlashForm>

              {/* Re-seed a player */}
              <div className="bracket-title mt-3">Re-seed</div>
              <ActionFlashForm action={reseedAction}>
                <input type="hidden" name="season" value={seasonName} />
                <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block"><span className="sub">Player</span><FormSelect name="playerId" options={opt(lineupOpts)} /></label>
                  <label className="block"><span className="sub">New seed</span><input type="number" name="newSeed" min={1} className={`${inputCls} w-16`} /></label>
                  <label className="block"><span className="sub">From week</span><input type="number" name="effectiveWeek" min={1} defaultValue={data.selectedWeek} className={`${inputCls} w-16`} /></label>
                  <input name="reason" placeholder="reason" className={`${inputCls} w-32`} />
                  <SubmitButton size="sm" variant="secondary" pendingText="…"><ArrowUpDown className="size-3.5" /> Re-seed</SubmitButton>
                </div>
              </ActionFlashForm>

              {/* Swap two players' seeds (the common one-up-one-down re-seed) */}
              <div className="bracket-title mt-3">Swap seeds</div>
              <ActionFlashForm action={swapSeedsAction}>
                <input type="hidden" name="season" value={seasonName} />
                <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block"><span className="sub">Player A</span><FormSelect name="playerAId" options={opt(lineupOpts)} /></label>
                  <label className="block"><span className="sub">Player B</span><FormSelect name="playerBId" options={opt(lineupOpts)} /></label>
                  <label className="block"><span className="sub">From week</span><input type="number" name="effectiveWeek" min={1} defaultValue={data.selectedWeek} className={`${inputCls} w-16`} /></label>
                  <input name="reason" placeholder="reason" className={`${inputCls} w-32`} />
                  <SubmitButton size="sm" variant="secondary" pendingText="…"><ArrowUpDown className="size-3.5" /> Swap</SubmitButton>
                </div>
              </ActionFlashForm>

              {/* Substitute (temporary) */}
              <div className="bracket-title mt-3">Substitute (temporary)</div>
              <ActionFlashForm action={substituteAction}>
                <input type="hidden" name="season" value={seasonName} />
                <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block"><span className="sub">Out</span><FormSelect name="outPlayerId" options={opt(lineupOpts)} /></label>
                  <label className="block"><span className="sub">In</span><FormSelect name="inPlayerId" options={opt(faOpts)} placeholder="— pool —" /></label>
                  <label className="block"><span className="sub">Week</span><input type="number" name="effectiveWeek" min={1} defaultValue={data.selectedWeek} className={`${inputCls} w-16`} /></label>
                  <label className="block"><span className="sub">Until</span><input type="number" name="untilWeek" min={1} placeholder="opt" className={`${inputCls} w-16`} /></label>
                  <input name="reason" placeholder="reason" className={`${inputCls} w-36`} />
                  <SubmitButton size="sm" variant="secondary" pendingText="…"><RefreshCw className="size-3.5" /> Sub</SubmitButton>
                </div>
              </ActionFlashForm>

              {/* Membership fix — imports sometimes record a temporary sub as a permanent
                  seed-holder (or vice versa). Converts between the two, keeping stats. */}
              <div className="bracket-title mt-3">Fix membership (import corrections)</div>
              <ActionFlashForm action={convertToSubAction}>
                <input type="hidden" name="season" value={seasonName} />
                <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
                <div className="flex flex-wrap items-end gap-2">
                  {/* Lineup members + existing subs (re-running adjusts a sub's window). */}
                  <label className="block"><span className="sub">Member / sub to (re)convert</span><FormSelect name="playerId" options={opt([
                    ...lineupOpts,
                    ...t.subStints.filter((s) => !t.lineup.some((p) => p.playerId === s.playerId)).map((s) => ({ value: s.playerId, label: `${s.name} (sub ${s.window})` })),
                  ])} /></label>
                  <label className="block"><span className="sub">Subbed W</span><input type="number" name="effectiveWeek" min={1} defaultValue={data.selectedWeek} className={`${inputCls} w-16`} /></label>
                  <label className="block"><span className="sub">Until</span><input type="number" name="untilWeek" min={1} placeholder="opt" className={`${inputCls} w-16`} /></label>
                  <label className="block"><span className="sub">Covering for</span><FormSelect name="outPlayerId" options={opt(lineupOpts)} placeholder="— optional —" /></label>
                  <input name="reason" placeholder="reason" className={`${inputCls} w-32`} />
                  <SubmitButton size="sm" variant="secondary" pendingText="…"><RefreshCw className="size-3.5" /> Make sub</SubmitButton>
                </div>
              </ActionFlashForm>
              {t.subStints.length > 0 && (
                <ActionFlashForm action={makePermanentAction} className="mt-2">
                  <input type="hidden" name="season" value={seasonName} />
                  <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="block"><span className="sub">Sub who is really permanent</span><FormSelect name="playerId" options={opt([...new Map(t.subStints.map((s) => [s.playerId, { value: s.playerId, label: `${s.name} (${s.window})` }])).values()])} /></label>
                    <label className="block"><span className="sub">From W</span><input type="number" name="effectiveWeek" min={1} defaultValue={1} className={`${inputCls} w-16`} /></label>
                    <label className="block"><span className="sub">Seed</span><input type="number" name="seed" min={1} placeholder="keep" className={`${inputCls} w-16`} /></label>
                    <input name="reason" placeholder="reason" className={`${inputCls} w-32`} />
                    <SubmitButton size="sm" variant="secondary" pendingText="…"><UserPlus className="size-3.5" /> Make permanent</SubmitButton>
                  </div>
                </ActionFlashForm>
              )}

              {/* Quit / Ban (permanent) */}
              <div className="bracket-title mt-3">Quit / Ban (permanent)</div>
              <ActionFlashForm action={departureAction}>
                <input type="hidden" name="season" value={seasonName} />
                <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block"><span className="sub">Player</span><FormSelect name="playerId" options={opt(lineupOpts)} /></label>
                  <label className="block"><span className="sub">Type</span><FormSelect name="kind" options={[{ value: "QUIT", label: "Quit" }, { value: "BANNED", label: "Banned" }]} defaultValue="QUIT" /></label>
                  <label className="block"><span className="sub">From week</span><input type="number" name="effectiveWeek" min={1} defaultValue={data.selectedWeek} className={`${inputCls} w-16`} /></label>
                  <input name="reason" placeholder="reason" className={`${inputCls} w-36`} />
                  <SubmitButton size="sm" variant="secondary" pendingText="…"><UserMinus className="size-3.5" /> Record</SubmitButton>
                </div>
              </ActionFlashForm>

              {/* Replace (permanent add) */}
              <div className="bracket-title mt-3">Replace (permanent add)</div>
              <ActionFlashForm action={replaceAction}>
                <input type="hidden" name="season" value={seasonName} />
                <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block"><span className="sub">In</span><FormSelect name="inPlayerId" options={opt(faOpts)} placeholder="— pool —" /></label>
                  <label className="block"><span className="sub">Replaces</span><FormSelect name="replacesPlayerId" options={opt(lineupOpts)} placeholder="— slot —" /></label>
                  <label className="block"><span className="sub">From week</span><input type="number" name="effectiveWeek" min={1} defaultValue={data.selectedWeek} className={`${inputCls} w-16`} /></label>
                  <input name="reason" placeholder="reason" className={`${inputCls} w-36`} />
                  <SubmitButton size="sm" variant="secondary" pendingText="…"><UserPlus className="size-3.5" /> Add</SubmitButton>
                </div>
              </ActionFlashForm>
            </div>
          );
        })}
      </div>

      {/* Strikes (TO aid — informational) */}
      <h2 className="mt-6 mb-1 text-[1.1rem] inline-flex items-center gap-1.5"><ShieldAlert className="size-4" /> Strikes</h2>
      <p className="sub">Reliability / conduct notes to help the TO — they don&apos;t auto-penalize. ⚑ on a player = season count; ⚠ = at risk (career ≥ 3).</p>
      <div className="card">
        <ActionFlashForm action={addStrikeAction}>
          <input type="hidden" name="season" value={seasonName} />
          <div className="flex flex-wrap items-end gap-2">
            <label className="block"><span className="sub">Player</span><FormSelect name="playerId" options={opt(allLineup)} /></label>
            <label className="block"><span className="sub">Kind</span><FormSelect name="kind" options={STRIKE_KINDS.map((k) => ({ value: k, label: STRIKE_LABEL[k] ?? k }))} defaultValue="SCHEDULING" /></label>
            <label className="block"><span className="sub">Week</span><input type="number" name="week" min={1} placeholder="opt" className={`${inputCls} w-16`} /></label>
            <input name="reason" placeholder="reason" className={`${inputCls} w-44`} />
            <SubmitButton size="sm" variant="secondary" pendingText="…">Add strike</SubmitButton>
          </div>
        </ActionFlashForm>
        {data.strikeLog.length > 0 && (
          <table className="mt-3">
            <thead><tr><th>Player</th><th>Kind</th><th>Reason</th><th className="num">Wk</th><th></th></tr></thead>
            <tbody>
              {data.strikeLog.map((s) => (
                <tr key={s.id}>
                  <td>{s.player}</td>
                  <td><span className="badge">{s.kindLabel}</span></td>
                  <td className="sub">{s.reason}</td>
                  <td className="num">{s.week ? `W${s.week}` : "—"}</td>
                  <td style={{ textAlign: "right" }}>
                    <form action={removeStrikeAction}>
                      <input type="hidden" name="season" value={seasonName} />
                      <input type="hidden" name="strikeId" value={s.id} />
                      <SubmitButton size="sm" variant="secondary" pendingText="…"><X className="size-3.5" /></SubmitButton>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Timeline */}
      <h2 className="mt-6 mb-1 text-[1.1rem]">Timeline ({data.timeline.length})</h2>
      <div className="card">
        {data.timeline.length === 0 ? (
          <p className="sub">No roster moves recorded.</p>
        ) : (
          <table>
            <thead><tr><th className="num">Wk</th><th>Type</th><th>Detail</th><th>Reason</th><th></th></tr></thead>
            <tbody>
              {data.timeline.map((m) => (
                <tr key={m.id}>
                  <td className="num">W{m.week}{m.untilWeek ? `–${m.untilWeek}` : ""}</td>
                  <td><span className="badge">{m.kindLabel}</span></td>
                  <td>
                    {m.kind === "SUB"
                      ? <>{m.outPlayer} <span className="muted">→</span> {m.player} <span className="sub">({m.team})</span></>
                      : m.kind === "ADDED"
                        ? <>{m.player}{m.replaces ? <> <span className="muted">replaces</span> {m.replaces}</> : null} <span className="sub">({m.team})</span></>
                        : m.kind === "CAPTAIN_CHANGE"
                          ? <>{m.player} <span className="muted">becomes captain{m.replaces ? <> (was {m.replaces})</> : null}</span> <span className="sub">({m.team})</span></>
                          : m.kind === "RESEED"
                            ? <>{m.player} <span className="muted">→ seed #{m.seed}</span> <span className="sub">({m.team})</span></>
                            : <>{m.player} <span className="sub">({m.team})</span></>}
                  </td>
                  <td className="sub">{m.reason}</td>
                  <td style={{ textAlign: "right" }}>
                    <div className="inline-flex items-center gap-1">
                      {(m.kind === "QUIT" || m.kind === "BANNED") && (
                        <form action={reinstateAction}>
                          <input type="hidden" name="season" value={seasonName} />
                          <input type="hidden" name="teamSeasonId" value={m.teamSeasonId} />
                          <input type="hidden" name="playerId" value={m.playerId} />
                          <input type="hidden" name="effectiveWeek" value={m.week} />
                          <input type="hidden" name="reason" value={`reinstated (was ${m.kindLabel})`} />
                          <SubmitButton size="sm" variant="secondary" pendingText="…" title="Reinstate"><Undo2 className="size-3.5" /></SubmitButton>
                        </form>
                      )}
                      <form action={removeMoveAction}>
                        <input type="hidden" name="season" value={seasonName} />
                        <input type="hidden" name="moveId" value={m.id} />
                        <SubmitButton size="sm" variant="secondary" pendingText="…"><X className="size-3.5" /></SubmitButton>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
