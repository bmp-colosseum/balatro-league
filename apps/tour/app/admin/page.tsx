import Link from "next/link";
import { Plus } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { NoAccess } from "@/components/NoAccess";
import { listSeasons } from "@/lib/services/seasons";
import { ImportUpload } from "@/components/ImportUpload";

export const dynamic = "force-dynamic";

// The shell only checks "has any access"; the dashboard itself is TO-only.
export default async function Admin() {
  if (!(await isAdmin())) return <NoAccess what="use the admin dashboard" />;
  const seasons = await listSeasons();
  return (
    <main>
      <h1>Dashboard</h1>
      <p className="sub flex items-center gap-1.5">
        <Link href="/admin/seasons/new" className="inline-flex items-center gap-1"><Plus className="size-3.5" /> New season</Link>
      </p>

      <div className="card">
        <div className="bracket-title">Import history</div>
        <p className="sub px-0.5">
          Upload a <strong>.zip</strong> of the per-season workbooks — <code>TT1.xlsx</code>, <code>TT2.xlsx</code>,
          <code>TT3.xlsx</code>, <code>TT4.xlsx</code> (+ any <code>TT*Signups.xlsx</code>), and optionally{" "}
          <code>league-players.csv</code> for identity linking. Everything (rosters, draft, seeds, regular + playoff results,
          bracket, champions, career stats) is read from the workbooks. Idempotent — safe to re-run.
        </p>
        <div className="px-0.5 py-1"><ImportUpload /></div>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Season</th>
              <th>Format</th>
              <th className="num">Teams</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {seasons.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link href={`/admin/seasons/${encodeURIComponent(s.name)}`}>{s.name}</Link>
                </td>
                <td className="sub">{s.format}</td>
                <td className="num">{s._count.teamSeasons}</td>
                <td className="sub">{s.state}</td>
              </tr>
            ))}
            {seasons.length === 0 && (
              <tr>
                <td colSpan={4} className="sub">
                  No seasons yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
