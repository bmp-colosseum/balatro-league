// Intent-first per-player action menu. "Manage" opens a short "what are you doing with
// this person?" menu; picking ONE intent reveals only that action's form (with a back).
// Replaces the old dump of seven stacked forms -- same server actions, far less overwhelm.
"use client";
import { useState } from "react";
import { Crown, RefreshCw, UserMinus, UserPlus, ArrowUpDown, ChevronLeft, Settings2 } from "lucide-react";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { FormSelect } from "@/components/FormSelect";
import { SubmitButton } from "@/components/SubmitButton";
import {
  substituteAction, departureAction, replaceAction, changeCaptainAction, reseedAction,
  swapSeedsAction, setCoCaptainAction,
} from "@/app/admin/seasons/[name]/roster/actions";

const inputCls = "rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5";

type SelOpt = { value: string; label: string; disabled?: boolean };
type Intent = "sub" | "perm" | "reseed" | "swap" | "captain" | "cocaptain" | "depart";

export interface PlayerManageProps {
  seasonName: string;
  teamSeasonId: string;
  playerId: string;
  playerName: string;
  isCaptain: boolean;
  isCoCaptain: boolean;
  req: boolean; // captain request-mode vs mod apply-mode
  subInOpts: SelOpt[];
  swapOpts: SelOpt[];
  permOpts: SelOpt[];
  weekSel: SelOpt[];
  weekSelOpt: SelOpt[];
  defWeek: string;
}

export function PlayerManage(props: PlayerManageProps) {
  const { seasonName, teamSeasonId, playerId, playerName, isCaptain, isCoCaptain, req } = props;
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<Intent | null>(null);
  const verb = (immediate: string, request: string) => (req ? request : immediate);

  const hidden = (key: string) => (
    <>
      <input type="hidden" name="season" value={seasonName} />
      <input type="hidden" name="teamSeasonId" value={teamSeasonId} />
      <input type="hidden" name={key} value={playerId} />
    </>
  );

  const menu: { key: Intent; label: string; icon: typeof RefreshCw; show: boolean }[] = [
    { key: "sub", label: "Sub in a week", icon: RefreshCw, show: true },
    { key: "perm", label: "Replace all season", icon: UserPlus, show: true },
    { key: "reseed", label: "Change seed", icon: ArrowUpDown, show: true },
    { key: "swap", label: "Swap w/ teammate", icon: ArrowUpDown, show: props.swapOpts.length > 1 },
    { key: "captain", label: "Make captain", icon: Crown, show: !isCaptain },
    { key: "cocaptain", label: isCoCaptain ? "Remove co-captain" : "Make co-captain", icon: Crown, show: true },
    { key: "depart", label: "Remove from team", icon: UserMinus, show: true },
  ];

  function close() { setOpen(false); setIntent(null); }

  const managePill = (
    <button
      type="button"
      onClick={() => (open ? close() : setOpen(true))}
      className="pill inline-flex items-center gap-1"
      style={{ cursor: "pointer", background: "var(--surface-2)", border: "1px solid var(--border)" }}
    >
      <Settings2 className="size-3.5" /> Manage
    </button>
  );

  if (!open) return managePill;

  return (
    <div style={{ textAlign: "left" }}>
      {managePill}
      {intent === null ? (
        <div className="mt-2 flex flex-col gap-1.5">
          <span className="sub">What are you doing with {playerName}?</span>
          <div className="flex flex-wrap gap-1.5">
            {menu.filter((m) => m.show).map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setIntent(m.key)}
                className="pill inline-flex items-center gap-1"
                style={{ cursor: "pointer", background: "var(--surface-2)", border: "1px solid var(--border)" }}
              >
                <m.icon className="size-3.5" /> {m.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-col gap-1.5">
          <button type="button" onClick={() => setIntent(null)} className="sub inline-flex items-center gap-1" style={{ cursor: "pointer", alignSelf: "flex-start" }}>
            <ChevronLeft className="size-3.5" /> back
          </button>

          {intent === "sub" && (
            <ActionFlashForm action={substituteAction}>
              {hidden("outPlayerId")}
              <div className="flex flex-wrap items-end gap-1.5">
                <span className="sub" style={{ minWidth: "2.5rem" }}>in</span>
                <FormSelect name="inPlayerId" size="sm" options={props.subInOpts} placeholder="-- in --" />
                <FormSelect name="effectiveWeek" size="sm" options={props.weekSel} defaultValue={props.defWeek} />
                <FormSelect name="untilWeek" size="sm" options={props.weekSelOpt} placeholder="-- until --" />
                <input name="reason" placeholder="reason" className={`${inputCls} w-24`} />
                <SubmitButton size="sm" variant="secondary" pendingText="..."><RefreshCw className="size-3.5" /> {verb("Sub in", "Request")}</SubmitButton>
              </div>
            </ActionFlashForm>
          )}

          {intent === "perm" && (
            <ActionFlashForm action={replaceAction}>
              {hidden("replacesPlayerId")}
              <div className="flex flex-wrap items-end gap-1.5">
                <span className="sub" style={{ minWidth: "2.5rem" }}>in</span>
                <FormSelect name="inPlayerId" size="sm" options={props.permOpts} placeholder="-- pool --" />
                <FormSelect name="effectiveWeek" size="sm" options={props.weekSel} defaultValue={props.defWeek} />
                <input name="reason" placeholder="reason" className={`${inputCls} w-24`} />
                <SubmitButton size="sm" variant="secondary" pendingText="..."><UserPlus className="size-3.5" /> {verb("Replace", "Request")}</SubmitButton>
              </div>
            </ActionFlashForm>
          )}

          {intent === "reseed" && (
            <ActionFlashForm action={reseedAction}>
              {hidden("playerId")}
              <div className="flex flex-wrap items-end gap-1.5">
                <input type="number" name="newSeed" min={1} placeholder="seed" className={`${inputCls} w-16`} />
                <FormSelect name="effectiveWeek" size="sm" options={props.weekSel} defaultValue={props.defWeek} />
                <input name="reason" placeholder="reason" className={`${inputCls} w-24`} />
                <SubmitButton size="sm" variant="secondary" pendingText="..."><ArrowUpDown className="size-3.5" /> {verb("Re-seed", "Request")}</SubmitButton>
              </div>
            </ActionFlashForm>
          )}

          {intent === "swap" && (
            <ActionFlashForm action={swapSeedsAction}>
              {hidden("playerAId")}
              <div className="flex flex-wrap items-end gap-1.5">
                <span className="sub" style={{ minWidth: "2.5rem" }}>with</span>
                <FormSelect name="playerBId" size="sm" options={props.swapOpts} placeholder="-- player --" />
                <FormSelect name="effectiveWeek" size="sm" options={props.weekSel} defaultValue={props.defWeek} />
                <SubmitButton size="sm" variant="secondary" pendingText="..."><ArrowUpDown className="size-3.5" /> {verb("Swap", "Request")}</SubmitButton>
              </div>
            </ActionFlashForm>
          )}

          {intent === "captain" && (
            <ActionFlashForm action={changeCaptainAction}>
              {hidden("newCaptainPlayerId")}
              <input type="hidden" name="effectiveWeek" value={props.defWeek} />
              <SubmitButton size="sm" variant="secondary" pendingText="..."><Crown className="size-3.5" /> {verb("Make captain", "Request captain")}</SubmitButton>
            </ActionFlashForm>
          )}

          {intent === "cocaptain" && (
            <ActionFlashForm action={setCoCaptainAction}>
              {hidden("playerId")}
              <SubmitButton size="sm" variant="secondary" name="isCoCaptain" value={isCoCaptain ? "false" : "true"} pendingText="...">
                <Crown className="size-3.5" /> {isCoCaptain ? verb("Remove co-captain", "Request remove CC") : verb("Make co-captain", "Request co-captain")}
              </SubmitButton>
            </ActionFlashForm>
          )}

          {intent === "depart" && (
            <ActionFlashForm action={departureAction}>
              {hidden("playerId")}
              <div className="flex flex-wrap items-end gap-1.5">
                <FormSelect name="kind" size="sm" options={[{ value: "QUIT", label: "Quit" }, { value: "BANNED", label: "Banned" }]} defaultValue="QUIT" />
                <FormSelect name="effectiveWeek" size="sm" options={props.weekSel} defaultValue={props.defWeek} />
                <input name="reason" placeholder="reason" className={`${inputCls} w-24`} />
                <SubmitButton size="sm" variant="secondary" pendingText="..."><UserMinus className="size-3.5" /> {verb("Remove", "Request")}</SubmitButton>
              </div>
            </ActionFlashForm>
          )}
        </div>
      )}
    </div>
  );
}
