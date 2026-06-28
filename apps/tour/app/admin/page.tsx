import Link from "next/link";
import { ArrowLeft, Download, Database, Plus, Fingerprint, Activity } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { listSeasons } from "@/lib/services/seasons";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { importHistoricalAction, importTT10Action } from "./actions";

export const dynamic = "force-dynamic";

export default async function Admin() {
  if (!(await isAdmin())) {
    return (
      <main>
        <p>
          <Link href="/" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> home</Link>
        </p>
        <h1>Admin</h1>
        <Callout type="admin">
          Not authorized. Set <code>TOUR_DEV_ADMIN=1</code> in <code>apps/tour/.env</code> for local dev (real auth =
          Discord OAuth + role tiers, wired when the Tour Discord app exists).
        </Callout>
      </main>
    );
  }

  const seasons = await listSeasons();
  return (
    <main>
      <h1>Admin</h1>
      <p className="sub flex items-center gap-1.5">
        Dev-admin mode ·{" "}
        <Link href="/admin/seasons/new" className="inline-flex items-center gap-1"><Plus className="size-3.5" /> New season</Link>
        {" "}·{" "}
        <Link href="/admin/identity" className="inline-flex items-center gap-1"><Fingerprint className="size-3.5" /> Identity manager</Link>
        {" "}·{" "}
        <Link href="/admin/env-health" className="inline-flex items-center gap-1"><Activity className="size-3.5" /> Env health</Link>
      </p>

      <div className="card">
        <div className="bracket-title">Data import (from the sheets)</div>
        <div className="flex flex-wrap items-start gap-3 px-0.5 py-1">
          <ActionFlashForm action={importHistoricalAction}>
            <SubmitButton pendingText="Importing…"><Download /> Import alltime (S1–3)</SubmitButton>
          </ActionFlashForm>
          <ActionFlashForm action={importTT10Action}>
            <SubmitButton variant="secondary" pendingText="Importing…"><Database /> Import TT10 (Pluto/Eris)</SubmitButton>
          </ActionFlashForm>
        </div>
        <p className="sub px-0.5 pb-1">
          Idempotent. Reads <code>TOUR_SHEETS_DIR</code> (default <code>D:/STuffinside</code>).
        </p>
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
