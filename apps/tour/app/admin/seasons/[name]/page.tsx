import Link from "next/link";
import { ArrowLeft, Users, Shield, Shuffle, CalendarDays, UserCog, Trophy, Flag, Hash, ExternalLink } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { getSeasonAdmin } from "@/lib/services/seasons";
import { Callout } from "@/components/Callout";
import { FormSelect } from "@/components/FormSelect";
import { SubmitButton } from "@/components/SubmitButton";
import { updateSeasonStateAction } from "../../actions";

export const dynamic = "force-dynamic";

const STATES = ["SIGNUPS", "DRAFTING", "REGULAR", "PLAYOFFS", "DONE"] as const;

export default async function SeasonAdmin({ params }: { params: Promise<{ name: string }> }) {
  if (!(await isAdmin())) {
    return (
      <main>
        <h1>Admin</h1>
        <Callout type="admin">Admins only — you don&apos;t have access.in <code>apps/tour/.env</code>.</Callout>
      </main>
    );
  }

  const { name } = await params;
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

  const { season, signups } = data;
  const enc = encodeURIComponent(season.name);
  const stageIdx = STATES.indexOf(season.state);

  const stages = [
    { key: "signups", label: "Signups", icon: Users, href: `/admin/seasons/${enc}/signups`, count: `${signups.APPROVED} approved · ${signups.PENDING} pending`, ready: true },
    { key: "teams", label: "Teams", icon: Shield, href: `/admin/seasons/${enc}/teams`, count: `${season._count.teamSeasons} teams · ${season._count.conferences} conf`, ready: false },
    { key: "draft", label: "Draft", icon: Shuffle, href: `/admin/seasons/${enc}/draft`, count: season.draft ? season.draft.state : "not started", ready: true },
    { key: "schedule", label: "Schedule", icon: CalendarDays, href: `/admin/seasons/${enc}/schedule`, count: `${season._count.weeks} weeks`, ready: true },
    { key: "roster", label: "Roster ops", icon: UserCog, href: `/admin/seasons/${enc}/roster`, count: "subs · drops · DQs", ready: true },
    { key: "playoffs", label: "Playoffs", icon: Trophy, href: `/admin/seasons/${enc}/playoffs`, count: season.state === "PLAYOFFS" || season.state === "DONE" ? `bracket · ${season.state}` : `field of ${season.playoffTeams}`, ready: true },
    { key: "end", label: "Season end", icon: Flag, href: `/admin/seasons/${enc}/end`, count: season.state === "DONE" ? "crowned · awards" : "crown + awards", ready: true },
    { key: "discord", label: "Discord roles", icon: Hash, href: `/admin/seasons/${enc}/discord`, count: season.playerRoleId ? "synced" : "preview", ready: true },
  ];

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
                {s}
              </span>
              {i < STATES.length - 1 && <span className="text-[var(--border)]">→</span>}
            </span>
          ))}
        </div>
        <form action={updateSeasonStateAction} className="mt-3 flex items-end gap-2">
          <input type="hidden" name="name" value={season.name} />
          <FormSelect name="state" defaultValue={season.state} options={STATES.map((s) => ({ value: s, label: s }))} />
          <SubmitButton variant="secondary">Set state</SubmitButton>
        </form>
      </div>

      {/* Config */}
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
