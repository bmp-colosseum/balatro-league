// One team's roster-management controls -- the SINGLE source of truth for managing a team,
// rendered both on the season-wide roster-ops page (one per team) and inline on the team's
// own page. The pattern is a per-PLAYER table: each row carries its own collapsed action set,
// pre-bound to that player (no re-selecting from a dropdown), so data and controls live
// together. Rare mod-only surgery (import repair) hides in one "Advanced" disclosure. Every
// action posts to the shared roster-ops server actions, which gate it: a mod applies now, a
// captain files a pending request (mode "request"). The caller has already gated access.
import Link from "next/link";
import { Crown, RefreshCw, UserPlus, UserMinus, AlertTriangle, Check, X, Undo2, Settings2, Wrench } from "lucide-react";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { FormSelect } from "@/components/FormSelect";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmButton } from "@/components/ConfirmButton";
import { PlayerManage } from "@/components/PlayerManage";
import {
  convertToSubAction, makePermanentAction, reinstateAction, removeMoveAction, purgeMemberAction, addPlayerAction,
  approveRequestAction, rejectRequestAction, cancelRequestAction,
} from "@/app/admin/seasons/[name]/roster/actions";
import type { RosterRequestView } from "@/lib/services/roster-requests";

// A compact roster-move row for the per-team "Recent changes" undo list.
export interface RecentMove {
  id: string; kind: string; kindLabel: string; week: number; untilWeek: number | null;
  seed: number | null; player: string; outPlayer: string | null; replaces: string | null;
  teamSeasonId: string; playerId: string;
}

const inputCls = "rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5";
const opt = (items: { value: string; label: string; disabled?: boolean }[]) => [{ value: "", label: "-- select --" }, ...items];

type SelOpt = { value: string; label: string };

export interface ManageTeam {
  teamSeasonId: string;
  name: string;
  membership: {
    playerId: string; name: string; seed: number | null; isMember: boolean;
    joinedWeek: number | null; stints: string[];
    departed: { kind: string; week: number } | null;
    isCaptain: boolean; isCoCaptain: boolean; activeNow: boolean;
  }[];
  lineup: { playerId: string; name: string; seed: number }[];
  subStints: { playerId: string; name: string; window: string }[];
}

type Member = ManageTeam["membership"][number];

export function TeamManagePanel({
  seasonName,
  team,
  selectedWeek,
  strikeOf,
  faOpts,
  crossTeamOpts = [],
  weekSel,
  weekSelOpt,
  defWeek,
  linkName = true,
  mode = "apply",
  pending = [],
  recentMoves = [],
}: {
  seasonName: string;
  team: ManageTeam;
  selectedWeek: number;
  strikeOf: Record<string, { season: number; career: number; atRisk: boolean }>;
  faOpts: SelOpt[];
  crossTeamOpts?: SelOpt[]; // players rostered on another team (cross-team / playoff subs)
  weekSel: SelOpt[];
  weekSelOpt: SelOpt[];
  defWeek: string;
  linkName?: boolean; // link the team name to its page (roster-ops) vs plain text (team page)
  mode?: "apply" | "request"; // captain -> "request" (ops queue for a mod); mod/TO -> "apply"
  pending?: RosterRequestView[];
  recentMoves?: RecentMove[]; // this team's move log, for the inline undo list (apply mode)
}) {
  const t = team;
  const req = mode === "request";
  const lineupOpts = t.lineup.map((p) => ({ value: p.playerId, label: `#${p.seed} ${p.name}` }));
  // Most-recent-first slice of this team's moves for the "Recent changes" undo list.
  const recent = [...recentMoves].slice(-6).reverse();
  const moveDetail = (m: RecentMove) =>
    m.kind === "SUB" ? `${m.outPlayer ?? "?"} -> ${m.player}`
      : m.kind === "ADDED" ? `${m.player}${m.replaces ? ` replaces ${m.replaces}` : ""}`
        : m.kind === "CAPTAIN_CHANGE" ? `${m.player} becomes captain`
          : m.kind === "RESEED" ? `${m.player} -> seed #${m.seed ?? "?"}`
            : m.player;

  // Which players are named in a pending request -> show a dot on their row.
  const pendingIds = new Set<string>();
  for (const r of pending) for (const id of [r.playerId, r.outPlayerId, r.replacesPlayerId, r.playerBId]) if (id) pendingIds.add(id);

  const hidden = (playerKey: string, playerId: string) => (
    <>
      <input type="hidden" name="season" value={seasonName} />
      <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
      <input type="hidden" name={playerKey} value={playerId} />
    </>
  );

  // Option pools for one member's actions (sub-in / swap / perm), pre-filtered of self.
  // The forms themselves live in the client <PlayerManage> intent menu.
  const optionSetFor = (p: Member) => ({
    subInOpts: opt([
      ...(lineupOpts.filter((o) => o.value !== p.playerId).length
        ? [{ value: "__team", label: "on this team", disabled: true }, ...lineupOpts.filter((o) => o.value !== p.playerId)]
        : []),
      ...(faOpts.length ? [{ value: "__pool", label: "free agents", disabled: true }, ...faOpts] : []),
      ...(crossTeamOpts.length ? [{ value: "__other", label: "other teams (cross-team sub)", disabled: true }, ...crossTeamOpts] : []),
    ]),
    swapOpts: opt(lineupOpts.filter((o) => o.value !== p.playerId)),
    permOpts: opt(faOpts),
  });

  // Departed player: reinstating is TO/mod-only surgery (a plain redirect action), so it only
  // shows in apply mode.
  const departedActions = (p: Member) =>
    req ? (
      <p className="sub" style={{ margin: "4px 0" }}>A mod can reinstate this player.</p>
    ) : (
      <form action={reinstateAction} style={{ padding: "6px 0 2px" }}>
        {hidden("playerId", p.playerId)}
        <div className="flex flex-wrap items-end gap-1.5">
          <FormSelect name="effectiveWeek" size="sm" options={weekSel} defaultValue={defWeek} />
          <input name="reason" placeholder="reason" className={`${inputCls} w-28`} />
          <SubmitButton size="sm" variant="secondary" pendingText="..."><Undo2 className="size-3.5" /> Reinstate</SubmitButton>
        </div>
      </form>
    );

  return (
    <div className="card" style={{ marginBottom: 0 }}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">
          {linkName ? <Link href={`/teams/${t.teamSeasonId}`} style={{ color: "inherit" }}>{t.name}</Link> : t.name}
        </span>
        <span className="badge">W{selectedWeek} default &middot; {t.lineup.length} active</span>
      </div>

      {req && (
        <p className="sub" style={{ margin: "4px 0 0" }}>
          You&apos;re a captain here -- changes you submit are sent to a mod for approval, not applied right away.
        </p>
      )}

      {/* Pending requests for this team -- mods approve/reject; the captain can withdraw. */}
      {pending.length > 0 && (
        <div className="mt-2 rounded border border-[var(--accent-2)] p-2" style={{ background: "var(--surface-2)" }}>
          <div className="bracket-title" style={{ padding: 0 }}>
            Pending requests <span className="badge" style={{ color: "var(--accent-2)" }}>{pending.length}</span>
          </div>
          <ul className="mt-1 list-none p-0" style={{ margin: 0 }}>
            {pending.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-1">
                <span className="badge">{r.kindLabel}</span>
                <span>{r.summary}</span>
                <span className="sub">by {r.requestedName ?? r.requestedBy}</span>
                {req ? (
                  <ActionFlashForm action={cancelRequestAction}>
                    <input type="hidden" name="season" value={seasonName} />
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
                    <SubmitButton size="sm" variant="secondary" pendingText="...">Withdraw</SubmitButton>
                  </ActionFlashForm>
                ) : (
                  <>
                    <ActionFlashForm action={approveRequestAction}>
                      <input type="hidden" name="season" value={seasonName} />
                      <input type="hidden" name="id" value={r.id} />
                      <SubmitButton size="sm" pendingText="..."><Check className="size-3.5" /> Approve</SubmitButton>
                    </ActionFlashForm>
                    <ActionFlashForm action={rejectRequestAction}>
                      <input type="hidden" name="season" value={seasonName} />
                      <input type="hidden" name="id" value={r.id} />
                      <span className="inline-flex items-center gap-1">
                        <input name="note" placeholder="note (optional)" className={`${inputCls} w-28`} />
                        <SubmitButton size="sm" variant="secondary" pendingText="..."><X className="size-3.5" /> Reject</SubmitButton>
                      </span>
                    </ActionFlashForm>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The roster AS the control surface: one row per player, actions on the row. The week
          selector (roster page) sets the default "From week" shown inside each action. */}
      <div className="mt-2" style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr><th className="rank" style={{ width: "2.2rem" }}>Seed</th><th>Player</th><th style={{ width: "6.5rem" }}></th></tr>
          </thead>
          <tbody>
            {t.membership.map((p) => {
              const st = strikeOf[p.playerId];
              const opts = p.isMember && !p.departed ? optionSetFor(p) : null;
              const note = !p.isMember
                ? `sub ${p.stints.join(", ")}`
                : p.departed
                  ? `${p.departed.kind === "BANNED" ? "banned" : "left"} W${p.departed.week}`
                  : p.joinedWeek != null && p.joinedWeek > 1
                    ? `joined W${p.joinedWeek}`
                    : null;
              return (
                <tr key={p.playerId} style={{ opacity: p.activeNow ? 1 : 0.6 }}>
                  <td className="rank" style={{ verticalAlign: "top" }}>{p.isMember ? p.seed : <span className="badge">sub</span>}</td>
                  <td style={{ verticalAlign: "top" }}>
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      {p.isCaptain && <Crown className="size-3.5 shrink-0 text-[var(--accent)]" />}
                      <Link href={`/players/${p.playerId}`} style={{ color: "inherit" }}>{p.name}</Link>
                      {p.isCoCaptain && <span className="badge" title="Co-captain -- same team powers as the captain">CC</span>}
                      {pendingIds.has(p.playerId) && <span className="badge" style={{ color: "var(--accent-2)" }} title="named in a pending request">pending</span>}
                      {note && <span className="sub">{note}</span>}
                      {!p.activeNow && !p.departed && p.isMember && <span className="sub">&middot; not W{selectedWeek}</span>}
                      {st && st.season > 0 && (
                        <span className="badge inline-flex items-center gap-1" style={{ color: st.atRisk ? "var(--danger)" : "var(--accent-2)" }} title={`${st.season} this season &middot; ${st.career} career`}>
                          {st.atRisk && <AlertTriangle className="size-3" />}{st.season} flag
                        </span>
                      )}
                    </span>
                  </td>
                  <td style={{ textAlign: "right", verticalAlign: "top" }}>
                    {opts ? (
                      <PlayerManage
                        seasonName={seasonName}
                        teamSeasonId={t.teamSeasonId}
                        playerId={p.playerId}
                        playerName={p.name}
                        isCaptain={p.isCaptain}
                        isCoCaptain={p.isCoCaptain}
                        req={req}
                        subInOpts={opts.subInOpts}
                        swapOpts={opts.swapOpts}
                        permOpts={opts.permOpts}
                        weekSel={weekSel}
                        weekSelOpt={weekSelOpt}
                        defWeek={defWeek}
                      />
                    ) : (
                      <details>
                        <summary className="pill inline-flex items-center gap-1" style={{ cursor: "pointer", listStyle: "none", background: "var(--surface-2)", border: "1px solid var(--border)" }}>
                          <Settings2 className="size-3.5" /> Manage
                        </summary>
                        <div style={{ textAlign: "left" }}>
                          {p.departed ? departedActions(p) : <p className="sub" style={{ margin: "6px 0" }}>Temporary sub. Use Advanced below to convert to a permanent member.</p>}
                        </div>
                      </details>
                    )}
                  </td>
                </tr>
              );
            })}
            {t.membership.length === 0 && (
              <tr><td colSpan={3} className="sub">Nobody on this team yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add a brand-new player who was never signed up -- creates the Player by Discord ID
          and rosters them. Mod/TO only. */}
      {!req && (
        <details className="mt-2">
          <summary className="pill inline-flex items-center gap-1" style={{ cursor: "pointer", listStyle: "none", background: "var(--surface-2)", border: "1px solid var(--border)" }}>
            <UserPlus className="size-3.5" /> Add a player (new -- not signed up)
          </summary>
          <ActionFlashForm action={addPlayerAction} className="mt-2 flex flex-wrap items-end gap-1.5">
            <input type="hidden" name="season" value={seasonName} />
            <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
            <label className="block"><span className="sub">Display name</span><input name="displayName" placeholder="name" className={`${inputCls} w-32`} required /></label>
            <label className="block"><span className="sub">Discord ID</span><input name="discordId" inputMode="numeric" pattern="\d{17,20}" placeholder="17-20 digits" className={`${inputCls} w-32`} required /></label>
            <label className="block"><span className="sub">Seed</span><input type="number" name="seed" min={1} placeholder="next" className={`${inputCls} w-16`} /></label>
            <label className="block"><span className="sub">From week</span><FormSelect name="effectiveWeek" size="sm" options={weekSel} defaultValue={defWeek} /></label>
            <SubmitButton size="sm" variant="secondary" pendingText="..."><UserPlus className="size-3.5" /> Add to team</SubmitButton>
          </ActionFlashForm>
          <p className="sub" style={{ margin: "4px 0 0" }}>The Discord ID is how the player is identified everywhere -- required, and reused if they already exist.</p>
        </details>
      )}

      {/* Recent changes -- this team's latest moves with one-click Undo, right where you
          made them (mod/TO only). The move log is append-only, so Undo deletes the move. */}
      {!req && recent.length > 0 && (
        <div className="mt-2">
          <div className="bracket-title" style={{ padding: 0 }}>Recent changes</div>
          <ul className="mt-1 list-none p-0" style={{ margin: 0 }}>
            {recent.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2 py-0.5">
                <span className="sub num" style={{ minWidth: "2.5rem" }}>W{m.week}{m.untilWeek ? `-${m.untilWeek}` : ""}</span>
                <span className="badge">{m.kindLabel}</span>
                <span className="sub">{moveDetail(m)}</span>
                <span className="inline-flex items-center gap-1" style={{ marginLeft: "auto" }}>
                  {(m.kind === "QUIT" || m.kind === "BANNED") && (
                    <form action={reinstateAction}>
                      <input type="hidden" name="season" value={seasonName} />
                      <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
                      <input type="hidden" name="playerId" value={m.playerId} />
                      <input type="hidden" name="effectiveWeek" value={m.week} />
                      <input type="hidden" name="reason" value={`reinstated (was ${m.kindLabel})`} />
                      <SubmitButton size="sm" variant="secondary" pendingText="..." title="Reinstate this player"><Undo2 className="size-3.5" /> Reinstate</SubmitButton>
                    </form>
                  )}
                  <form action={removeMoveAction}>
                    <input type="hidden" name="season" value={seasonName} />
                    <input type="hidden" name="moveId" value={m.id} />
                    <SubmitButton size="sm" variant="secondary" pendingText="..." title="Undo this change"><Undo2 className="size-3.5" /> Undo</SubmitButton>
                  </form>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Advanced / import repair -- mod-only surgery, hidden from captains and collapsed by
          default so it never competes with the everyday roster ops. */}
      {!req && (t.subStints.length > 0 || t.lineup.length > 0) && (
        <details className="mt-2">
          <summary className="sub inline-flex items-center gap-1" style={{ cursor: "pointer" }}>
            <Wrench className="size-3.5" /> Advanced / import repair
          </summary>
          <div className="mt-2 flex flex-col gap-3">
            {/* Member/sub -> the other (fix a bad import) */}
            <ActionFlashForm action={convertToSubAction}>
              <input type="hidden" name="season" value={seasonName} />
              <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
              <div className="flex flex-wrap items-end gap-1.5">
                <label className="block"><span className="sub">Make sub</span><FormSelect name="playerId" size="sm" options={opt([
                  ...lineupOpts,
                  ...t.subStints.filter((s) => !t.lineup.some((p) => p.playerId === s.playerId)).map((s) => ({ value: s.playerId, label: `${s.name} (sub ${s.window})` })),
                ])} /></label>
                <label className="block"><span className="sub">Weeks</span><FormSelect name="effectiveWeek" size="sm" options={weekSel} defaultValue={defWeek} /></label>
                <FormSelect name="untilWeek" size="sm" options={weekSelOpt} placeholder="-- until --" />
                <label className="block"><span className="sub">Covering for</span><FormSelect name="outPlayerId" size="sm" options={opt(lineupOpts)} placeholder="-- optional --" /></label>
                <input name="reason" placeholder="reason" className={`${inputCls} w-24`} />
                <SubmitButton size="sm" variant="secondary" pendingText="..."><RefreshCw className="size-3.5" /> Make sub</SubmitButton>
              </div>
            </ActionFlashForm>
            {t.subStints.length > 0 && (
              <ActionFlashForm action={makePermanentAction}>
                <input type="hidden" name="season" value={seasonName} />
                <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
                <div className="flex flex-wrap items-end gap-1.5">
                  <label className="block"><span className="sub">Sub to permanent</span><FormSelect name="playerId" size="sm" options={opt([...new Map(t.subStints.map((s) => [s.playerId, { value: s.playerId, label: `${s.name} (${s.window})` }])).values()])} /></label>
                  <label className="block"><span className="sub">From W</span><FormSelect name="effectiveWeek" size="sm" options={weekSel} defaultValue="1" /></label>
                  <label className="block"><span className="sub">Seed</span><input type="number" name="seed" min={1} placeholder="keep" className={`${inputCls} w-16`} /></label>
                  <input name="reason" placeholder="reason" className={`${inputCls} w-24`} />
                  <SubmitButton size="sm" variant="secondary" pendingText="..."><UserPlus className="size-3.5" /> Make permanent</SubmitButton>
                </div>
              </ActionFlashForm>
            )}

            {/* Danger zone: hard delete. Wipes a player's roster data on this team with NO log
                entry (vs "Remove from team", which records a QUIT). For bad/duplicate/phantom
                imports only -- a re-import can't resurrect them because the draft entry goes too. */}
            {t.membership.length > 0 && (
              <div className="rounded border p-2" style={{ borderColor: "var(--danger)" }}>
                <span className="sub" style={{ color: "var(--danger)" }}>Delete a player from this team (data fix -- leaves no log, not a departure)</span>
                <form action={purgeMemberAction} className="mt-1 flex flex-wrap items-end gap-1.5">
                  <input type="hidden" name="season" value={seasonName} />
                  <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
                  <FormSelect name="playerId" size="sm" options={opt(t.membership.map((p) => ({ value: p.playerId, label: p.isMember ? `${p.name}${p.seed != null ? ` #${p.seed}` : ""}` : `${p.name} (sub)` })))} placeholder="-- player --" />
                  <ConfirmButton size="sm" variant="destructive" message="Permanently DELETE this player from the team? Removes their draft entry + all roster moves with NO log entry. Use only for bad/duplicate data -- to record someone leaving, use Remove from team instead.">
                    <UserMinus className="size-3.5" /> Delete
                  </ConfirmButton>
                </form>
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
