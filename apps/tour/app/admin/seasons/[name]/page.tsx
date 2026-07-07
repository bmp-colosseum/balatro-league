import Link from "next/link";
import { ArrowLeft, Users, Shield, Shuffle, CalendarDays, UserCog, Trophy, Flag, Hash, ExternalLink, Newspaper, ListOrdered, Trash2, Gamepad2, ClipboardList, Inbox } from "lucide-react";
import { getViewer, isAdmin } from "@/lib/auth";
import { capabilitiesFor, captainTeamsFor, seasonIdByName } from "@/lib/permissions";
import { getSeasonAdmin, listConferences } from "@/lib/services/seasons";
import { getFantasyLeague } from "@/lib/services/fantasy";
import { pendingRequestCount } from "@/lib/services/roster-requests";
import { NoAccess } from "@/components/NoAccess";
import { FormSelect } from "@/components/FormSelect";
import { SetsToWinField } from "@/components/SetsToWinField";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { updateSeasonStateAction, updateSeasonSettingsAction, addConferenceAction, renameConferenceAction, removeConferenceAction } from "../../actions";

export const dynamic = "force-dynamic";

const STATES = ["SIGNUPS", "SIGNUPS_CLOSED", "DRAFTING", "REGULAR", "PLAYOFFS", "DONE"] as const;
const STATE_LABEL: Record<string, string> = { SIGNUPS: "SIGNUPS", SIGNUPS_CLOSED: "CLOSED", DRAFTING: "DRAFTING", REGULAR: "REGULAR", PLAYOFFS: "PLAYOFFS", DONE: "DONE" };
const inputCls = "rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1";

export default async function SeasonAdmin({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const seasonName = decodeURIComponent(name);
  // Shell already checked "has any access"; here we show only the stages this viewer can act on.
  const to = await isAdmin();
  const seasonId = to ? null : await seasonIdByName(seasonName);
  const viewer = to ? null : await getViewer();
  const caps = viewer ? await capabilitiesFor(viewer, seasonId) : null;
  const isCaptain = viewer ? (await captainTeamsFor(viewer, seasonId)).size > 0 : false;
  const cap = (c: "NEWS" | "RANKINGS" | "ROSTERS" | "DRAFT") => to || !!caps?.has(c);

  const data = await getSeasonAdmin(seasonName);
  if (!data) {
    return (
      <main>
        <p><Link href="/admin" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> admin</Link></p>
        <h1>Season not found</h1>
      </main>
    );
  }

  const { season, signups } = data;
  const enc = encodeURIComponent(season.name);
  const stageIdx = STATES.indexOf(season.state);
  // Linear "next" state for the primary Advance action; null once DONE (or on an unknown state).
  const nextState = stageIdx > -1 && stageIdx < STATES.length - 1 ? STATES[stageIdx + 1] : null;
  const conferences = to ? await listConferences(season.name) : [];
  const fantasy = to ? await getFantasyLeague(season.name).catch(() => null) : null;
  const structureLocked = !!season.draft; // once the draft exists, structure is baked in
  // Pending captain roster requests awaiting a mod (only the inbox owners need the count).
  const pendingReqCount = cap("ROSTERS") ? await pendingRequestCount((await seasonIdByName(season.name)) ?? "") : 0;

  // `show` gates each tile by capability/captaincy (TO sees all). Structural stages are TO-only.
  const stages = [
    { key: "signups", label: "Signups", icon: Users, href: `/admin/seasons/${enc}/signups`, count: `${signups.APPROVED} approved · ${signups.PENDING} pending`, ready: true, show: to },
    { key: "teams", label: "Teams", icon: Shield, href: `/admin/seasons/${enc}/teams`, count: `${season._count.teamSeasons} teams · ${season._count.conferences} conf`, ready: true, show: to },
    { key: "draft", label: "Draft", icon: Shuffle, href: `/admin/seasons/${enc}/draft`, count: season.draft ? season.draft.state : "not started", ready: true, show: cap("DRAFT") || isCaptain },
    { key: "schedule", label: "Schedule", icon: CalendarDays, href: `/admin/seasons/${enc}/schedule`, count: `${season._count.weeks} weeks`, ready: true, show: to },
    { key: "audit", label: "Reporting audit", icon: ClipboardList, href: `/admin/seasons/${enc}/audit`, count: "unsettled matchups · who's behind", ready: true, show: to },
    { key: "roster", label: "Roster ops", icon: UserCog, href: `/admin/seasons/${enc}/roster`, count: "subs · drops · DQs", ready: true, show: cap("ROSTERS") || isCaptain },
    { key: "roster-requests", label: "Roster requests", icon: Inbox, href: `/admin/seasons/${enc}/roster/requests`, count: pendingReqCount > 0 ? `${pendingReqCount} pending` : "none pending", ready: true, show: cap("ROSTERS") },
    { key: "playoffs", label: "Playoffs", icon: Trophy, href: `/admin/seasons/${enc}/playoffs`, count: season.state === "PLAYOFFS" || season.state === "DONE" ? `bracket · ${season.state}` : `field of ${season.playoffTeams}`, ready: true, show: to },
    { key: "end", label: "Season end", icon: Flag, href: `/admin/seasons/${enc}/end`, count: season.state === "DONE" ? "crowned · awards" : "crown + awards", ready: true, show: to },
    { key: "fantasy", label: "Fantasy", icon: Gamepad2, href: `/admin/seasons/${enc}/fantasy`, count: fantasy ? `${fantasy.teams.length} managers · ${fantasy.scope === "PLAYOFFS" ? "playoffs" : "season"}` : "not opened", ready: true, show: to },
    { key: "discord", label: "Discord roles", icon: Hash, href: `/admin/seasons/${enc}/discord`, count: season.playerRoleId ? "synced" : "preview", ready: true, show: to },
    { key: "news", label: "News Network", icon: Newspaper, href: `/admin/seasons/${enc}/news`, count: "previews · recaps", ready: true, show: cap("NEWS") },
    { key: "rankings", label: "Power rankings", icon: ListOrdered, href: `/admin/seasons/${enc}/rankings`, count: "teams · players", ready: true, show: cap("RANKINGS") },
  ].filter((s) => s.show);

  if (!stages.length) return <NoAccess what="manage this season" />;

  return (
    <main>
      <p>
        <Link href="/admin" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> admin</Link>
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1>{season.name}</h1>
        <Link href={`/seasons/${enc}`} className="inline-flex items-center gap-1 text-sm">
          Public page <ExternalLink className="size-3.5" />
        </Link>
      </div>

      {/* Lifecycle stepper */}
      <div className="card">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {STATES.map((s, i) => (
            <span key={s} className="inline-flex items-center gap-2">
              <span
                className="pill"
                style={{
                  background: i === stageIdx ? "var(--accent-2)" : "var(--surface-2)",
                  color: i === stageIdx ? "#fff" : i < stageIdx ? "var(--success)" : "var(--muted)",
                  border: "1px solid var(--border)",
                }}
              >
                {STATE_LABEL[s]}
              </span>
              {i < STATES.length - 1 && <span className="text-[var(--border)]">→</span>}
            </span>
          ))}
        </div>
        {season.state === "SIGNUPS" && (
          <p className="sub" style={{ margin: "10px 0 0" }}>
            Signups are open — players sign up at <Link href="/signup">/signup</Link> (share the full URL from your browser).
          </p>
        )}
        {season.state === "SIGNUPS_CLOSED" && (
          <p className="sub" style={{ margin: "10px 0 0" }}>
            Signups are closed — the committee window. Review the pool in <Link href={`/admin/seasons/${enc}/signups`}>Signups</Link>,
            set the format and conferences in Season settings below, then build teams in <Link href={`/admin/seasons/${enc}/teams`}>Teams</Link>.
          </p>
        )}
        {to && (
          <div className="mt-3">
            {nextState && (
              <form action={updateSeasonStateAction} className="flex items-end gap-2">
                <input type="hidden" name="name" value={season.name} />
                <input type="hidden" name="state" value={nextState} />
                <SubmitButton>Advance to {STATE_LABEL[nextState]}</SubmitButton>
              </form>
            )}
            <details className="mt-2">
              <summary className="sub" style={{ cursor: "pointer" }}>Override state</summary>
              <form action={updateSeasonStateAction} className="mt-2 flex items-end gap-2">
                <input type="hidden" name="name" value={season.name} />
                <FormSelect name="state" defaultValue={season.state} options={STATES.map((s) => ({ value: s, label: STATE_LABEL[s] }))} />
                <SubmitButton variant="secondary">Set state</SubmitButton>
              </form>
            </details>
          </div>
        )}
      </div>

      {/* Season settings — structure is decided AFTER signups (the pool size drives it),
          so this stays editable until the draft exists, then locks. */}
      {to ? (
        <div className="card">
          <div className="bracket-title">Season settings</div>

          <div className="bracket-title" style={{ marginTop: 16 }}>Format &amp; structure</div>
          {structureLocked ? (
            <>
              <p className="sub" style={{ marginTop: 0 }}>Locked — the draft exists, so the structure is baked in.</p>
              <div className="grid grid-3">
                <div className="stat"><div className="label">Format</div><div className="value">{season.format === "CONFERENCES" ? "Conf" : "Swiss"}</div></div>
                <div className="stat"><div className="label">Team size</div><div className="value">{season.teamSize}</div><div className="muted">{season.setsToWin} sets to win</div></div>
                <div className="stat"><div className="label">Conferences</div><div className="value">{season.conferenceCount}</div></div>
                <div className="stat"><div className="label">Playoff field</div><div className="value">{season.playoffTeams}</div><div className="muted">teams</div></div>
              </div>
              {/* Repairable values — NOT structure. Sets-per-matchup and sets-to-win are
                  data corrections (imports derived them from roster capacity, subs included,
                  which inflates them); best-of is the default for newly-paired sets. */}
              <ActionFlashForm action={updateSeasonSettingsAction} className="mt-3 flex flex-wrap items-end gap-2">
                <input type="hidden" name="name" value={season.name} />
                <label className="grid gap-1 text-sm">
                  <span className="muted">Sets per matchup</span>
                  <input type="number" name="teamSize" min={1} max={25} defaultValue={season.teamSize} className={inputCls} style={{ width: 80 }}
                    title="How many sets one team-vs-team match has (drives the completeness audit, NOT roster size)" />
                </label>
                <label className="grid gap-1 text-sm">
                  <span className="muted">Sets to win</span>
                  <input type="number" name="setsToWin" min={1} max={25} defaultValue={season.setsToWin} className={inputCls} style={{ width: 80 }} />
                </label>
                <label className="grid gap-1 text-sm">
                  <span className="muted">Best-of (per new set)</span>
                  <input type="number" name="defaultBestOf" min={1} max={9} step={2} defaultValue={season.defaultBestOf} className={inputCls} style={{ width: 80 }} />
                </label>
                <SubmitButton variant="secondary" size="sm">Save</SubmitButton>
              </ActionFlashForm>
            </>
          ) : (
            <ActionFlashForm action={updateSeasonSettingsAction} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="name" value={season.name} />
              <label className="grid gap-1 text-sm">
                <span className="muted">Format</span>
                <FormSelect name="format" defaultValue={season.format} options={[{ value: "CONFERENCES", label: "Conferences" }, { value: "SWISS", label: "Swiss" }]} />
              </label>
              <SetsToWinField teamSize={season.teamSize} setsToWin={season.setsToWin} />
              <label className="grid gap-1 text-sm">
                <span className="muted">Playoff teams</span>
                <input type="number" name="playoffTeams" min={2} max={32} defaultValue={season.playoffTeams} className={inputCls} style={{ width: 80 }} />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="muted">Best-of (per set)</span>
                <input type="number" name="defaultBestOf" min={1} max={9} step={2} defaultValue={season.defaultBestOf} className={inputCls} style={{ width: 80 }} />
              </label>
              <SubmitButton variant="secondary">Save settings</SubmitButton>
            </ActionFlashForm>
          )}

          {/* Conference manager — where the real names ("Hack", "Sock") get set. */}
          {season.format === "CONFERENCES" && (
            <div style={{ marginTop: 16 }}>
              <div className="bracket-title">Conferences</div>
              {conferences.length === 0 && (
                <p className="sub" style={{ marginTop: 0 }}>
                  None yet — add them once the pool size is known. Teams created before then park in &quot;Unassigned&quot;.
                </p>
              )}
              {conferences.map((c) => (
                <div key={c.id} className="flex flex-wrap items-center gap-2" style={{ marginBottom: 8 }}>
                  {c.name === "Unassigned" ? (
                    <>
                      <span className="pill">Unassigned</span>
                      <span className="muted text-sm">{c._count.teamSeasons} team(s) parked — move them via Teams</span>
                    </>
                  ) : (
                    <>
                      <ActionFlashForm action={renameConferenceAction} className="flex items-center gap-2">
                        <input type="hidden" name="season" value={season.name} />
                        <input type="hidden" name="conferenceId" value={c.id} />
                        <input name="confName" defaultValue={c.name} required maxLength={40} className={inputCls} style={{ width: 160 }} />
                        <SubmitButton variant="secondary" size="sm">Rename</SubmitButton>
                      </ActionFlashForm>
                      <span className="muted text-sm">{c._count.teamSeasons} team(s)</span>
                      {c._count.teamSeasons === 0 && (
                        <form action={removeConferenceAction}>
                          <input type="hidden" name="season" value={season.name} />
                          <input type="hidden" name="conferenceId" value={c.id} />
                          <ConfirmButton message={`Remove conference "${c.name}"?`} variant="destructive" size="sm">
                            <Trash2 className="size-3.5" />
                          </ConfirmButton>
                        </form>
                      )}
                    </>
                  )}
                </div>
              ))}
              <ActionFlashForm action={addConferenceAction} className="flex items-center gap-2" style={{ marginTop: 8 }}>
                <input type="hidden" name="season" value={season.name} />
                <input name="confName" placeholder="New conference name" required maxLength={40} className={inputCls} style={{ width: 200 }} />
                <SubmitButton variant="secondary" size="sm">Add conference</SubmitButton>
              </ActionFlashForm>
            </div>
          )}
        </div>
      ) : (
        <div className="card">
          <div className="bracket-title">Configuration</div>
          <div className="grid grid-3">
            <div className="stat"><div className="label">Format</div><div className="value">{season.format === "CONFERENCES" ? "Conf" : "Swiss"}</div></div>
            <div className="stat"><div className="label">Team size</div><div className="value">{season.teamSize}</div><div className="muted">{season.setsToWin} sets to win</div></div>
            <div className="stat"><div className="label">Best-of</div><div className="value">{season.defaultBestOf}</div><div className="muted">default per set</div></div>
            <div className="stat"><div className="label">Conferences</div><div className="value">{season.conferenceCount}</div></div>
            <div className="stat"><div className="label">Playoff field</div><div className="value">{season.playoffTeams}</div><div className="muted">teams</div></div>
          </div>
        </div>
      )}

      {/* Lifecycle stages */}
      <div className="grid grid-2">
        {stages.map((st) => {
          const Icon = st.icon;
          const inner = (
            <div className="card" style={{ marginBottom: 0, borderColor: st.ready ? "var(--accent-2)" : "var(--border)" }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-semibold"><Icon className="size-4" /> {st.label}</div>
                {st.ready ? <span className="text-sm text-[var(--accent-2)]">Open →</span> : <span className="badge">soon</span>}
              </div>
              <div className="sub mt-1">{st.count}</div>
            </div>
          );
          return st.ready ? (
            <Link key={st.key} href={st.href} className="hover:no-underline">{inner}</Link>
          ) : (
            <div key={st.key}>{inner}</div>
          );
        })}
      </div>
    </main>
  );
}
