// One team's roster-management controls -- the SINGLE source of truth for managing a
// team, rendered both on the season-wide roster-ops page (one per team) and inline on
// the team's own page (so "manage a team" happens where you look at the team). Every
// action is a form that posts to the shared roster-ops server actions; the caller has
// already gated access (TO / ROSTERS mod / this team's captain).
import Link from "next/link";
import { Crown, RefreshCw, UserMinus, UserPlus, ArrowUpDown, AlertTriangle } from "lucide-react";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { FormSelect } from "@/components/FormSelect";
import { SubmitButton } from "@/components/SubmitButton";
import {
  substituteAction, departureAction, replaceAction, changeCaptainAction, reseedAction,
  swapSeedsAction, setCoCaptainAction, convertToSubAction, makePermanentAction,
} from "@/app/admin/seasons/[name]/roster/actions";

const inputCls = "rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5";
const opt = (items: { value: string; label: string; disabled?: boolean }[]) => [{ value: "", label: "— select —" }, ...items];

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

export function TeamManagePanel({
  seasonName,
  team,
  selectedWeek,
  strikeOf,
  faOpts,
  weekSel,
  weekSelOpt,
  defWeek,
  linkName = true,
}: {
  seasonName: string;
  team: ManageTeam;
  selectedWeek: number;
  strikeOf: Record<string, { season: number; career: number; atRisk: boolean }>;
  faOpts: SelOpt[];
  weekSel: SelOpt[];
  weekSelOpt: SelOpt[];
  defWeek: string;
  linkName?: boolean; // link the team name to its page (roster-ops) vs plain text (team page)
}) {
  const t = team;
  const lineupOpts = t.lineup.map((p) => ({ value: p.playerId, label: `#${p.seed} ${p.name}` }));
  return (
    <div className="card" style={{ marginBottom: 0 }}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">
          {linkName ? <Link href={`/teams/${t.teamSeasonId}`} style={{ color: "inherit" }}>{t.name}</Link> : t.name}
        </span>
        <span className="badge">W{selectedWeek} · {t.lineup.length} active</span>
      </div>
      {/* The WHOLE season membership -- everyone who was ever on the team. The week
          selector only decides who's highlighted as active (dimmed = not playing the
          selected week: sub window elsewhere, quit/banned, or joined later). */}
      <ol className="mt-2 list-none p-0" style={{ margin: 0 }}>
        {t.membership.map((p) => {
          const st = strikeOf[p.playerId];
          const note = !p.isMember
            ? `sub ${p.stints.join(", ")}`
            : p.departed
              ? `${p.departed.kind === "BANNED" ? "banned" : "left"} W${p.departed.week}`
              : p.joinedWeek != null && p.joinedWeek > 1
                ? `joined W${p.joinedWeek}`
                : null;
          return (
            <li key={p.playerId} className="flex items-baseline gap-2 py-0.5" style={{ opacity: p.activeNow ? 1 : 0.55 }}>
              <span className="rank" style={{ width: "1.6rem" }}>{p.isMember ? p.seed : <span className="badge">sub</span>}</span>
              {p.isCaptain && <Crown className="size-3.5 shrink-0 text-[var(--accent)]" />}
              <span><Link href={`/players/${p.playerId}`} style={{ color: "inherit" }}>{p.name}</Link></span>
              {p.isCoCaptain && <span className="badge" title="Co-captain — same team powers as the captain">CC</span>}
              {note && <span className="sub">{note}</span>}
              {!p.activeNow && !p.departed && <span className="sub" title="not in the selected week's lineup">· not W{selectedWeek}</span>}
              {st && st.season > 0 && (
                <span className="badge inline-flex items-center gap-1" style={{ color: st.atRisk ? "var(--danger)" : "var(--accent-2)" }} title={`${st.season} this season · ${st.career} career${st.atRisk ? " · at risk" : ""}`}>
                  {st.atRisk && <AlertTriangle className="size-3" />}{st.season}⚑
                </span>
              )}
            </li>
          );
        })}
        {t.membership.length === 0 && <li className="sub">Nobody on this team yet.</li>}
      </ol>

      {/* Change captain */}
      <div className="bracket-title mt-3">Captain</div>
      <ActionFlashForm action={changeCaptainAction}>
        <input type="hidden" name="season" value={seasonName} />
        <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
        <div className="flex flex-wrap items-end gap-2">
          <label className="block"><span className="sub">New captain</span><FormSelect name="newCaptainPlayerId" options={opt(lineupOpts)} /></label>
          <label className="block"><span className="sub">From week</span><FormSelect name="effectiveWeek" options={weekSel} defaultValue={defWeek} /></label>
          <input name="reason" placeholder="reason (optional)" className={`${inputCls} w-36`} />
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
          <label className="block"><span className="sub">From week</span><FormSelect name="effectiveWeek" options={weekSel} defaultValue={defWeek} /></label>
          <input name="reason" placeholder="reason (optional)" className={`${inputCls} w-32`} />
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
          <label className="block"><span className="sub">From week</span><FormSelect name="effectiveWeek" options={weekSel} defaultValue={defWeek} /></label>
          <input name="reason" placeholder="reason (optional)" className={`${inputCls} w-32`} />
          <SubmitButton size="sm" variant="secondary" pendingText="…"><ArrowUpDown className="size-3.5" /> Swap</SubmitButton>
        </div>
      </ActionFlashForm>

      {/* Substitute (temporary) */}
      <div className="bracket-title mt-3">Substitute (temporary {"—"} for specific weeks)</div>
      <p className="sub" style={{ margin: "0 0 0.3rem" }}>
        Covers the weeks you set (blank Until = that one week). Their unplayed sets in the window move to
        the sub automatically. For the <strong>rest of the season</strong>, use Replace below.
      </p>
      <ActionFlashForm action={substituteAction}>
        <input type="hidden" name="season" value={seasonName} />
        <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
        <div className="flex flex-wrap items-end gap-2">
          <label className="block"><span className="sub">Out</span><FormSelect name="outPlayerId" options={opt(lineupOpts)} /></label>
          {/* In = a teammate covering a set (internal sub) OR someone from the free-agent pool. */}
          <label className="block"><span className="sub">In</span><FormSelect name="inPlayerId" options={opt([
            ...(lineupOpts.length ? [{ value: "__team", label: "on this team", disabled: true }, ...lineupOpts] : []),
            ...(faOpts.length ? [{ value: "__pool", label: "free agents", disabled: true }, ...faOpts] : []),
          ])} placeholder="— teammate or pool —" /></label>
          <label className="block"><span className="sub">Week</span><FormSelect name="effectiveWeek" options={weekSel} defaultValue={defWeek} /></label>
          <label className="block"><span className="sub">Until</span><FormSelect name="untilWeek" options={weekSelOpt} placeholder="— one week —" /></label>
          <input name="reason" placeholder="reason (optional)" className={`${inputCls} w-36`} />
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
          <label className="block"><span className="sub">Subbed W</span><FormSelect name="effectiveWeek" options={weekSel} defaultValue={defWeek} /></label>
          <label className="block"><span className="sub">Until</span><FormSelect name="untilWeek" options={weekSelOpt} placeholder="— one week —" /></label>
          <label className="block"><span className="sub">Covering for</span><FormSelect name="outPlayerId" options={opt(lineupOpts)} placeholder="— optional —" /></label>
          <input name="reason" placeholder="reason (optional)" className={`${inputCls} w-32`} />
          <SubmitButton size="sm" variant="secondary" pendingText="…"><RefreshCw className="size-3.5" /> Make sub</SubmitButton>
        </div>
      </ActionFlashForm>
      {t.subStints.length > 0 && (
        <ActionFlashForm action={makePermanentAction} className="mt-2">
          <input type="hidden" name="season" value={seasonName} />
          <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
          <div className="flex flex-wrap items-end gap-2">
            <label className="block"><span className="sub">Sub who is really permanent</span><FormSelect name="playerId" options={opt([...new Map(t.subStints.map((s) => [s.playerId, { value: s.playerId, label: `${s.name} (${s.window})` }])).values()])} /></label>
            <label className="block"><span className="sub">From W</span><FormSelect name="effectiveWeek" options={weekSel} defaultValue="1" /></label>
            <label className="block"><span className="sub">Seed</span><input type="number" name="seed" min={1} placeholder="keep" className={`${inputCls} w-16`} /></label>
            <input name="reason" placeholder="reason (optional)" className={`${inputCls} w-32`} />
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
          <label className="block"><span className="sub">From week</span><FormSelect name="effectiveWeek" options={weekSel} defaultValue={defWeek} /></label>
          <input name="reason" placeholder="reason (optional)" className={`${inputCls} w-36`} />
          <SubmitButton size="sm" variant="secondary" pendingText="…"><UserMinus className="size-3.5" /> Record</SubmitButton>
        </div>
      </ActionFlashForm>

      {/* Replace (permanent add) */}
      <div className="bracket-title mt-3">Replace (permanent {"—"} rest of the season)</div>
      <p className="sub" style={{ margin: "0 0 0.3rem" }}>
        The newcomer takes the slot from the given week onward; the replaced player&apos;s unplayed sets
        move to them automatically. Played sets stay history.
      </p>
      <ActionFlashForm action={replaceAction}>
        <input type="hidden" name="season" value={seasonName} />
        <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
        <div className="flex flex-wrap items-end gap-2">
          <label className="block"><span className="sub">In</span><FormSelect name="inPlayerId" options={opt(faOpts)} placeholder="— pool —" /></label>
          <label className="block"><span className="sub">Replaces</span><FormSelect name="replacesPlayerId" options={opt(lineupOpts)} placeholder="— slot —" /></label>
          <label className="block"><span className="sub">From week</span><FormSelect name="effectiveWeek" options={weekSel} defaultValue={defWeek} /></label>
          <input name="reason" placeholder="reason (optional)" className={`${inputCls} w-36`} />
          <SubmitButton size="sm" variant="secondary" pendingText="…"><UserPlus className="size-3.5" /> Add</SubmitButton>
        </div>
      </ActionFlashForm>
    </div>
  );
}
