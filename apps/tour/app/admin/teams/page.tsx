import Link from "next/link";
import { ArrowLeft, Trash2, AlertTriangle } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { listTeamsAdmin } from "@/lib/services/teams-admin";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { ConfirmButton } from "@/components/ConfirmButton";
import { deleteTeamAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminTeams() {
  if (!(await isAdmin())) {
    return (
      <main>
        <h1>Admin</h1>
        <Callout type="admin">Admins only — you don&apos;t have access.</Callout>
      </main>
    );
  }
  const rows = await listTeamsAdmin();
  const phantoms = rows.filter((r) => r.players === 0 && r.sets === 0);

  return (
    <main>
      <p><Link href="/admin" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> admin</Link></p>
      <h1>Teams</h1>
      <p className="sub">
        Every team-season and its footprint. Delete removes the team-season and all its data
        (sets, series, picks, roster) — and the team itself if it has no seasons left. Re-uploading
        the sheets also auto-prunes phantoms (0 players, 0 sets), so prefer that for a bulk clean.
      </p>
      {phantoms.length > 0 && (
        <Callout type="admin">
          <AlertTriangle className="size-3.5 inline" /> {phantoms.length} phantom team-season(s) with no players and no sets — safe to delete.
        </Callout>
      )}

      <div className="card" style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Team</th>
              <th>Season</th>
              <th className="num">Players</th>
              <th className="num">Sets</th>
              <th className="num">Series</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const phantom = r.players === 0 && r.sets === 0;
              return (
                <tr key={r.teamSeasonId} style={phantom ? { background: "color-mix(in srgb, var(--accent-2) 8%, transparent)" } : undefined}>
                  <td><Link href={`/teams/${r.teamSeasonId}`}>{r.team}</Link></td>
                  <td className="sub">{r.season}</td>
                  <td className="num">{r.players}</td>
                  <td className="num">{r.sets}</td>
                  <td className="num">{r.series}</td>
                  <td style={{ textAlign: "right" }}>
                    <ActionFlashForm action={deleteTeamAction}>
                      <input type="hidden" name="teamSeasonId" value={r.teamSeasonId} />
                      <ConfirmButton
                        size="sm"
                        variant="destructive"
                        message={`Delete "${r.team}" (${r.season})? This removes ${r.sets} set(s), ${r.series} series and its roster. This cannot be undone.`}
                      >
                        <Trash2 className="size-3.5" /> Delete
                      </ConfirmButton>
                    </ActionFlashForm>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
