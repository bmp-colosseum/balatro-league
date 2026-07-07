import Link from "next/link";
import { ArrowLeft, Crown } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { getSeasonAdmin, listConferences } from "@/lib/services/seasons";
import { captainPool, listSeasonTeams } from "@/lib/services/teams-admin";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { FormSelect } from "@/components/FormSelect";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createTeamAction, updateTeamRowAction, deleteTeamAction } from "./actions";

export const dynamic = "force-dynamic";

// Manual team building — the committee window (but teams CAN form during signups too;
// they park in "Unassigned" until the conference structure is decided).
export default async function TeamsAdmin({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ captain?: string }>;
}) {
  if (!(await isAdmin())) {
    return (
      <main>
        <h1>Admin</h1>
        <Callout type="admin">Admins only — you don&apos;t have access.</Callout>
      </main>
    );
  }

  const { name } = await params;
  const { captain: prefillCaptain } = await searchParams;
  const seasonName = decodeURIComponent(name);
  const data = await getSeasonAdmin(seasonName);
  if (!data) {
    return (
      <main>
        <p><Link href="/admin" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> admin</Link></p>
        <h1>Season not found</h1>
      </main>
    );
  }
  const { season } = data;
  const enc = encodeURIComponent(seasonName);
  const [pool, teams, allConfs] = await Promise.all([
    captainPool(seasonName),
    listSeasonTeams(seasonName),
    listConferences(seasonName),
  ]);
  const conferences = allConfs.filter((c) => c.name !== "Unassigned");
  const structureLocked = !!season.draft;

  const interestTag = (ci: string | null) =>
    ci === "Yes, I would love to!" ? " · wants to captain" : ci === "I will if it is needed" ? " · captain if needed" : "";
  const captainOptions = pool.map((p) => ({
    value: p.discordId,
    label: `${p.name}${interestTag(p.captainInterest)}${p.alreadyCaptain ? " · already captains" : ""}`,
    disabled: p.alreadyCaptain,
  }));
  const confOptions = (current?: string | null) =>
    conferences.map((c) => ({ value: c.id, label: c.name, disabled: c.id === current }));

  // Per-team captain dropdown: the whole approved pool, with the current captain selectable and
  // anyone captaining ANOTHER team disabled. If the current captain somehow isn't in the approved
  // pool (e.g. their signup was un-approved after assignment), surface them as an explicit option
  // so the select still shows who's captain.
  const captainCellOptions = (t: (typeof teams)[number]) => {
    const opts = pool.map((p) => ({
      value: p.discordId,
      label: `${p.name}${interestTag(p.captainInterest)}${p.alreadyCaptain && p.discordId !== t.captainDiscordId ? " · captains another team" : ""}`,
      disabled: p.alreadyCaptain && p.discordId !== t.captainDiscordId,
    }));
    if (t.captainDiscordId && !pool.some((p) => p.discordId === t.captainDiscordId)) {
      opts.unshift({ value: t.captainDiscordId, label: `${t.captain} (current)`, disabled: false });
    }
    return opts;
  };

  return (
    <main>
      <p>
        <Link href={`/admin/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {seasonName}</Link>
      </p>
      <h1>Teams</h1>
      <p className="sub">
        {teams.length} team(s). Create a team by picking its captain from the approved pool — it starts as
        &quot;Team {"{captain}"}&quot; and the captain can rename it from their /me page. Change a team&apos;s captain
        anytime before the draft with the dropdown in the Captain column. Seed order = creation order (draft order).
      </p>
      {structureLocked && (
        <Callout type="admin">
          The draft exists — teams are baked in. To change a captain now, use <Link href={`/admin/seasons/${enc}/roster`}>Roster ops</Link> (a mid-season change with an effective week).
        </Callout>
      )}

      <div className="card">
        <div className="bracket-title">Create a team</div>
        {pool.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            No approved signups yet — approve players in <Link href={`/admin/seasons/${enc}/signups`}>Signups</Link> first.
          </p>
        ) : (
          <ActionFlashForm action={createTeamAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="season" value={seasonName} />
            <div className="grid gap-1.5">
              <Label>Captain *</Label>
              <FormSelect
                name="captainDiscordId"
                required
                placeholder="Pick from approved signups"
                defaultValue={prefillCaptain && pool.some((p) => p.discordId === prefillCaptain && !p.alreadyCaptain) ? prefillCaptain : ""}
                options={captainOptions}
                triggerClassName="w-72"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="teamName">Team name</Label>
              <Input id="teamName" name="teamName" placeholder={'optional — defaults to "Team {captain}"'} maxLength={48} className="w-64" />
            </div>
            {conferences.length > 0 && (
              <div className="grid gap-1.5">
                <Label>Conference</Label>
                <FormSelect
                  name="conferenceId"
                  placeholder="auto"
                  options={[{ value: "", label: conferences.length === 1 ? conferences[0].name : "decide later (Unassigned)" }, ...conferences.map((c) => ({ value: c.id, label: c.name }))]}
                  triggerClassName="w-56"
                />
              </div>
            )}
            <SubmitButton pendingText="Creating…">Create team</SubmitButton>
          </ActionFlashForm>
        )}
        {conferences.length === 0 && (
          <p className="sub" style={{ marginBottom: 0 }}>
            No conferences defined yet — new teams park in &quot;Unassigned&quot;. Add conferences in Season settings when the structure is decided.
          </p>
        )}
      </div>

      <div className="card">
        {teams.map((t) => (
          <div key={t.teamSeasonId} style={{ borderTop: "1px solid var(--border)", padding: "0.5rem 0" }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="sub">#{t.seed}</span>
                <span style={{ fontWeight: 600 }}>{t.name}</span>
                <span className="sub inline-flex items-center gap-1">
                  <Crown className="size-3.5 text-[var(--accent)]" aria-hidden /> {t.captain}
                </span>
                {conferences.length > 0 && <span className="pill">{t.conference}</span>}
              </div>
              <span className="flex flex-wrap items-center gap-1.5">
                <Link href={`/admin/seasons/${enc}/roster`} className="text-sm">roster ops</Link>
                <form action={deleteTeamAction} className="inline">
                  <input type="hidden" name="season" value={seasonName} />
                  <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
                  <ConfirmButton message={`Delete ${t.name}? This removes the team-season and everything on it (roster, sets, picks).`} variant="destructive" size="sm">
                    Delete
                  </ConfirmButton>
                </form>
              </span>
            </div>
            <details className="mt-1">
              <summary className="sub" style={{ cursor: "pointer" }}>Edit</summary>
              <ActionFlashForm action={updateTeamRowAction} className="flex flex-wrap items-end gap-3 mt-2">
                <input type="hidden" name="season" value={seasonName} />
                <input type="hidden" name="teamSeasonId" value={t.teamSeasonId} />
                <div className="grid gap-1.5">
                  <Label htmlFor={`teamName-${t.teamSeasonId}`}>Team name</Label>
                  <Input id={`teamName-${t.teamSeasonId}`} name="teamName" defaultValue={t.name} required maxLength={48} className="w-56" />
                </div>
                <div className="grid gap-1.5">
                  <Label>Captain</Label>
                  {structureLocked ? (
                    <span className="inline-flex items-center gap-1.5 sub" style={{ height: "2.25rem" }}>
                      <Crown className="size-3.5 text-[var(--accent)]" aria-hidden /> {t.captain}
                    </span>
                  ) : (
                    <FormSelect name="captainDiscordId" defaultValue={t.captainDiscordId ?? ""} options={captainCellOptions(t)} size="sm" triggerClassName="w-52" />
                  )}
                </div>
                {conferences.length > 0 && (
                  <div className="grid gap-1.5">
                    <Label>Conference</Label>
                    <FormSelect name="conferenceId" defaultValue={t.conference === "Unassigned" ? "" : t.conferenceId} placeholder="Unassigned" options={confOptions()} size="sm" triggerClassName="w-40" />
                  </div>
                )}
                <SubmitButton variant="secondary" size="sm">Save</SubmitButton>
              </ActionFlashForm>
            </details>
          </div>
        ))}
        {teams.length === 0 && <p className="sub" style={{ margin: 0 }}>No teams yet - create the first one above.</p>}
      </div>
    </main>
  );
}
