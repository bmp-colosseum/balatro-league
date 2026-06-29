import Link from "next/link";
import { ArrowLeft, Plus, Fingerprint, Activity } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { listSeasons } from "@/lib/services/seasons";
import { Callout } from "@/components/Callout";
import { ImportUpload } from "@/components/ImportUpload";

export const dynamic = "force-dynamic";

export default async function Admin() {
  if (!(await isAdmin())) {
    return (
      <main>
        <p>
          <Link href="/" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> home</Link>
        </p>
        <h1>Admin</h1>
        <Callout type="admin">Admins only — you don&apos;t have access.</Callout>
      </main>
    );
  }

  const seasons = await listSeasons();
  return (
    <main>
      <h1>Admin</h1>
      <p className="sub flex items-center gap-1.5">
        <Link href="/admin/seasons/new" className="inline-flex items-center gap-1"><Plus className="size-3.5" /> New season</Link>
        {" "}·{" "}
        <Link href="/admin/identity" className="inline-flex items-center gap-1"><Fingerprint className="size-3.5" /> Identity manager</Link>
        {" "}·{" "}
        <Link href="/admin/env-health" className="inline-flex items-center gap-1"><Activity className="size-3.5" /> Env health</Link>
      </p>

      <div className="card">
        <div className="bracket-title">Import history</div>
        <p className="sub px-0.5">
          Upload a <strong>.zip</strong> of the Google-Sheets exports (the folder with <code>Standings.html</code> +
          an <code>alltime/</code> subfolder). Imports the Swiss seasons and the conference season. Idempotent — safe to re-run.
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
