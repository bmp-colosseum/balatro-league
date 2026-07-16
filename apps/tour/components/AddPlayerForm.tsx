// Add a brand-new person (never signed up) to a team -- as a permanent roster MEMBER or as
// a SUB covering a chosen current player for a week window. Client-side because the two roles
// need different fields. Creates the core Player by Discord ID; no signup (a sub isn't one).
"use client";
import { useState } from "react";
import { UserPlus } from "lucide-react";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { FormSelect } from "@/components/FormSelect";
import { SubmitButton } from "@/components/SubmitButton";
import { addPlayerAction } from "@/app/admin/seasons/[name]/roster/actions";

const inputCls = "rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5";
type SelOpt = { value: string; label: string; disabled?: boolean };

export function AddPlayerForm({
  seasonName,
  teamSeasonId,
  lineupOpts,
  weekSel,
  weekSelOpt,
  defWeek,
}: {
  seasonName: string;
  teamSeasonId: string;
  lineupOpts: SelOpt[]; // current members, for "covers for" when adding a sub
  weekSel: SelOpt[];
  weekSelOpt: SelOpt[];
  defWeek: string;
}) {
  const [role, setRole] = useState<"member" | "sub">("member");
  const toggle = (r: "member" | "sub", label: string) => (
    <button
      type="button"
      onClick={() => setRole(r)}
      className="pill inline-flex items-center gap-1"
      style={{ cursor: "pointer", border: "1px solid var(--border)", background: role === r ? "var(--accent-2)" : "var(--surface-2)", color: role === r ? "var(--bg)" : "var(--fg)", fontWeight: role === r ? 600 : 400 }}
    >
      {label}
    </button>
  );

  return (
    <ActionFlashForm action={addPlayerAction} className="mt-2 flex flex-col gap-2">
      <input type="hidden" name="season" value={seasonName} />
      <input type="hidden" name="teamSeasonId" value={teamSeasonId} />
      <input type="hidden" name="role" value={role} />

      <div className="flex flex-wrap items-end gap-1.5">
        <label className="block"><span className="sub">Display name</span><input name="displayName" placeholder="name" className={`${inputCls} w-32`} required /></label>
        <label className="block"><span className="sub">Discord ID</span><input name="discordId" inputMode="numeric" pattern="\d{17,20}" placeholder="17-20 digits" className={`${inputCls} w-32`} required /></label>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="sub">Add as:</span>
        {toggle("member", "Roster member")}
        {toggle("sub", "Sub (covers someone)")}
      </div>

      {role === "member" ? (
        <div className="flex flex-wrap items-end gap-1.5">
          <label className="block"><span className="sub">Seed</span><input type="number" name="seed" min={1} placeholder="next" className={`${inputCls} w-16`} /></label>
          <label className="block"><span className="sub">From week</span><FormSelect name="effectiveWeek" size="sm" options={weekSel} defaultValue={defWeek} /></label>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-1.5">
          <label className="block"><span className="sub">Covers for</span><FormSelect name="coversPlayerId" size="sm" options={lineupOpts} placeholder="-- player --" /></label>
          <label className="block"><span className="sub">From week</span><FormSelect name="effectiveWeek" size="sm" options={weekSel} defaultValue={defWeek} /></label>
          <label className="block"><span className="sub">Until</span><FormSelect name="untilWeek" size="sm" options={weekSelOpt} placeholder="-- until --" /></label>
        </div>
      )}

      <div>
        <SubmitButton size="sm" variant="secondary" pendingText="..."><UserPlus className="size-3.5" /> Add to team</SubmitButton>
      </div>
      <p className="sub" style={{ margin: 0 }}>
        {role === "sub"
          ? "Creates the player and subs them in for the chosen member over that week window -- no signup."
          : "Creates the player and rosters them permanently -- no signup."}
      </p>
    </ActionFlashForm>
  );
}
