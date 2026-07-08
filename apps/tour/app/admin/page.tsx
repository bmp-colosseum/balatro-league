import Link from "next/link";
import { Plus, Inbox, Users, CalendarDays, Trophy, ClipboardList, Shuffle, ListChecks } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { NoAccess } from "@/components/NoAccess";
import { listSeasons } from "@/lib/services/seasons";
import { pendingRequestCount } from "@/lib/services/roster-requests";
import { ImportUpload } from "@/components/ImportUpload";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { Section } from "@/components/admin/Section";

export const dynamic = "force-dynamic";

const STATE_LABEL: Record<string, string> = {
  SIGNUPS: "Signups open",
  SIGNUPS_CLOSED: "Signups closed",
  DRAFTING: "Drafting",
  REGULAR: "Regular season",
  PLAYOFFS: "Playoffs",
  DONE: "Done",
};

// Primary operational sections, in workflow order. The season name links to the full hub
// (which carries every section incl. News/Rankings/Fantasy/Discord + settings).
const sections = (enc: string) => [
  { href: `/admin/seasons/${enc}/signups`, label: "Signups", icon: ClipboardList },
  { href: `/admin/seasons/${enc}/teams`, label: "Teams", icon: Users },
  { href: `/admin/seasons/${enc}/draft`, label: "Draft", icon: Shuffle },
  { href: `/admin/seasons/${enc}/schedule`, label: "Schedule", icon: CalendarDays },
  { href: `/admin/seasons/${enc}/roster`, label: "Roster", icon: ListChecks },
  { href: `/admin/seasons/${enc}/playoffs`, label: "Playoffs", icon: Trophy },
];

// The admin shell only checks "has any access"; this dashboard is TO-only.
export default async function Admin() {
  if (!(await isAdmin())) return <NoAccess what="use the admin dashboard" />;
  const seasons = await listSeasons();
  const active = seasons.filter((s) => s.state !== "DONE");
  const archived = seasons.filter((s) => s.state === "DONE");
  const pending = new Map<string, number>(
    await Promise.all(active.map(async (s) => [s.id, await pendingRequestCount(s.id)] as const)),
  );

  return (
    <main>
      <AdminPageHeader
        title="Dashboard"
        actions={<Link href="/admin/seasons/new" className="pill inline-flex items-center gap-1 hover:no-underline"><Plus className="size-3.5" /> New season</Link>}
        sub="Jump straight to any section of the active season, or open its hub for the rest."
      />

      {active.length === 0 ? (
        <Section><p className="sub">No active season. <Link href="/admin/seasons/new">Create one</Link> to get going.</p></Section>
      ) : (
        <div className="grid grid-2">
          {active.map((s) => {
            const enc = encodeURIComponent(s.name);
            const pend = pending.get(s.id) ?? 0;
            return (
              <div className="card" key={s.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/admin/seasons/${enc}`} className="text-[1.05rem] font-semibold hover:no-underline">{s.name}</Link>
                  <span className="badge">{STATE_LABEL[s.state] ?? s.state}</span>
                </div>
                <p className="sub" style={{ margin: "2px 0 10px" }}>
                  {s._count.teamSeasons} teams
                  {pend > 0 && (
                    <>
                      {" · "}
                      <Link href={`/admin/seasons/${enc}/roster/requests`} style={{ color: "var(--accent-2)" }} className="hover:no-underline">
                        <Inbox className="inline size-3.5 align-text-bottom" /> {pend} pending request{pend === 1 ? "" : "s"}
                      </Link>
                    </>
                  )}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {sections(enc).map(({ href, label, icon: Icon }) => (
                    <Link key={href} href={href} className="pill inline-flex items-center gap-1 hover:no-underline">
                      <Icon className="size-3.5" /> {label}
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <details style={{ marginTop: "1rem" }}>
        <summary className="sub" style={{ cursor: "pointer" }}>Season setup &amp; import</summary>
        <div className="card" style={{ marginTop: "0.5rem" }}>
          <div className="bracket-title">Import history</div>
          <p className="sub px-0.5">
            Upload a <strong>.zip</strong> of the per-season workbooks -- <code>TT1.xlsx</code>, <code>TT2.xlsx</code>,{" "}
            <code>TT3.xlsx</code>, <code>TT4.xlsx</code> (+ any <code>TT*Signups.xlsx</code>), and optionally{" "}
            <code>league-players.csv</code> for identity linking. Everything (rosters, draft, seeds, regular + playoff
            results, bracket, champions, career stats) is read from the workbooks. Idempotent -- safe to re-run.
          </p>
          <div className="px-0.5 py-1"><ImportUpload /></div>
        </div>
      </details>

      {archived.length > 0 && (
        <Section title={`Archive (${archived.length})`} className="mt-4">
          <table>
            <thead>
              <tr><th>Season</th><th>Format</th><th className="num">Teams</th><th>State</th></tr>
            </thead>
            <tbody>
              {archived.map((s) => (
                <tr key={s.id}>
                  <td><Link href={`/admin/seasons/${encodeURIComponent(s.name)}`}>{s.name}</Link></td>
                  <td className="sub">{s.format}</td>
                  <td className="num">{s._count.teamSeasons}</td>
                  <td className="sub">{STATE_LABEL[s.state] ?? s.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </main>
  );
}
