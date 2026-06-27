import Link from "next/link";
import { ArrowLeft, Crown, X, RefreshCw, UserMinus, UserPlus, Undo2 } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { getRosterOps } from "@/lib/services/roster-ops";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { FormSelect } from "@/components/FormSelect";
import { SubmitButton } from "@/components/SubmitButton";
import { substituteAction, departureAction, replaceAction, reinstateAction, removeMoveAction } from "./actions";

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
  if (!isAdmin()) {
    return (
      <main>
        <h1>Admin</h1>
        <Callout type="admin">Not authorized. Set <code>TOUR_DEV_ADMIN=1</code>.</Callout>
      </main>
    );
  }

  const { name } = await params;
  const { week } = await searchParams;
  const seasonName = decodeURIComponent(name);
  const enc = encodeURIComponent(seasonName);
  const data = await getRosterOps(seasonName, week ? Number(week) : undefined);

  if (!data) {
    return (
      <main>
        <p><Link href="/admin" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> admin</Link></p>
        <h1>Season not found</h1>
      </main>
    );
  }

  const faOpts = data.freeAgents.map((p) => ({ value: p.id, label: p.name }));
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
        {data.teams.map((t) => {
          const lineupOpts = t.lineup.map((p) => ({ value: p.playerId, label: `#${p.seed} ${p.name}` }));
          return (
            <div className="card" key={t.teamSeasonId} style={{ marginBottom: 0 }}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{t.name}</span>
                <span className="badge">W{data.selectedWeek} · {t.lineup.length} active</span>
              </div>
              <ol className="mt-2 list-none p-0" style={{ margin: 0 }}>
                {t.lineup.map((p) => (
                  <li key={p.playerId} className="flex items-baseline gap-2 py-0.5">
                    <span className="rank" style={{ width: "1.4rem" }}>{p.seed}</span>
                    {p.isCaptain && <Crown className="size-3.5 shrink-0 text-[var(--accent)]" />}
                    <span>{p.name}</span>
                    {p.viaSub && <span className="badge">sub</span>}
                  </li>
                ))}
                {t.lineup.length === 0 && <li className="sub">No active players this week.</li>}
              </ol>

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
