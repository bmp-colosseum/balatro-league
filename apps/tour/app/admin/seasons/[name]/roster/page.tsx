import Link from "next/link";
import { ArrowLeft, X, Undo2, ShieldAlert } from "lucide-react";
import { getViewer, isAdmin } from "@/lib/auth";
import { capabilitiesFor, captainTeamsFor, seasonIdByName } from "@/lib/permissions";
import { getRosterOps } from "@/lib/services/roster-ops";
import { listPendingRequests, type RosterRequestView } from "@/lib/services/roster-requests";
import { STRIKE_KINDS, STRIKE_LABEL } from "@/lib/services/strikes";
import { NoAccess } from "@/components/NoAccess";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { FormSelect } from "@/components/FormSelect";
import { SubmitButton } from "@/components/SubmitButton";
import { TeamManagePanel } from "@/components/TeamManagePanel";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { Section } from "@/components/admin/Section";
import { reinstateAction, removeMoveAction, addStrikeAction, removeStrikeAction } from "./actions";

export const dynamic = "force-dynamic";

const inputCls = "rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5";
const opt = (items: { value: string; label: string; disabled?: boolean }[]) => [{ value: "", label: "— select —" }, ...items];

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
  // Real, labelled weeks (incl. Playoffs) for every week picker -- no more freeform numbers.
  const weekTabs = data.weekOptions.length ? data.weekOptions : [{ value: 1, label: "W1" }];
  const weekSel = data.weekOptions.map((w) => ({ value: String(w.value), label: w.label }));
  const weekSelOpt = [{ value: "", label: "— one week —" }, ...weekSel]; // optional 'Until' / strike week
  const defWeek = String(data.selectedWeek);

  // Pending captain requests, grouped per team for the inline panel blocks.
  const pendingByTeam = new Map<string, RosterRequestView[]>();
  for (const r of await listPendingRequests(seasonName)) {
    const arr = pendingByTeam.get(r.teamSeasonId) ?? [];
    arr.push(r);
    pendingByTeam.set(r.teamSeasonId, arr);
  }

  return (
    <main>
      <AdminPageHeader
        back={{ href: `/admin/seasons/${enc}`, label: seasonName }}
        title="Roster ops"
        sub={<>Each row is a player; open <strong>Manage</strong> on a row for that player&apos;s actions. The week selector sets the default week actions apply to. Everything is an append-only move log, so history is never overwritten. Free-agent pool: {data.freeAgents.length}.</>}
      />

      {/* Week selector */}
      <div className="card">
        <div className="flex flex-wrap items-center gap-2">
          <span className="sub">Active week (highlight + action default):</span>
          {weekTabs.map((w) => (
            <Link
              key={w.value}
              href={`?week=${w.value}`}
              className="pill hover:no-underline"
              style={{
                background: w.value === data.selectedWeek ? "var(--accent-2)" : "var(--surface-2)",
                color: w.value === data.selectedWeek ? "#fff" : "var(--muted)",
                border: "1px solid var(--border)",
              }}
            >
              {w.label}
            </Link>
          ))}
          {data.weeks.length === 0 && <span className="sub">— no schedule yet; showing week 1 —</span>}
        </div>
      </div>

      {/* Teams: derived lineup + actions. Each card is the SAME TeamManagePanel that also
          appears inline on the team's own page -- one component, identical everywhere. */}
      <div className="grid grid-2">
        {teams.map((t) => (
          <TeamManagePanel
            key={t.teamSeasonId}
            seasonName={seasonName}
            team={t}
            selectedWeek={data.selectedWeek}
            strikeOf={data.strikeOf}
            faOpts={faOpts}
            weekSel={weekSel}
            weekSelOpt={weekSelOpt}
            defWeek={defWeek}
            mode={isMod ? "apply" : "request"}
            pending={pendingByTeam.get(t.teamSeasonId) ?? []}
          />
        ))}
      </div>

      {/* Strikes (TO aid — informational) */}
      {isMod && (<>
      <h2 className="mt-6 mb-1 text-[1.1rem] inline-flex items-center gap-1.5"><ShieldAlert className="size-4" /> Strikes</h2>
      <p className="sub">Reliability / conduct notes to help the TO — they don&apos;t auto-penalize. ⚑ on a player = season count; ⚠ = at risk (career ≥ 3).</p>
      <div className="card">
        <ActionFlashForm action={addStrikeAction}>
          <input type="hidden" name="season" value={seasonName} />
          <div className="flex flex-wrap items-end gap-2">
            <label className="block"><span className="sub">Player</span><FormSelect name="playerId" options={opt(allLineup)} /></label>
            <label className="block"><span className="sub">Kind</span><FormSelect name="kind" options={STRIKE_KINDS.map((k) => ({ value: k, label: STRIKE_LABEL[k] ?? k }))} defaultValue="SCHEDULING" /></label>
            <label className="block"><span className="sub">Week</span><FormSelect name="week" options={weekSelOpt} placeholder="— any —" /></label>
            <input name="reason" placeholder="reason (optional)" className={`${inputCls} w-44`} />
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
      </>)}

      {/* Timeline */}
      <Section className="mt-6" title={`Timeline (${data.timeline.length})`}>
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
                    {isMod && (
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
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </main>
  );
}
