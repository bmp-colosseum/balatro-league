import Link from "next/link";
import { ArrowLeft, KeyRound, Trash2, Crown } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { listGrants, grantablePlayers, seasonOptions, accessOverview } from "@/lib/services/access";
import { CAPABILITIES } from "@/lib/permissions";
import { NoAccess } from "@/components/NoAccess";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmButton } from "@/components/ConfirmButton";
import { FormSelect } from "@/components/FormSelect";
import { fieldInput as inputCls } from "@/components/admin/Field";
import { grantAction, revokeAction } from "./actions";

export const dynamic = "force-dynamic";
const CAP_LABEL: Record<string, string> = { NEWS: "News", RANKINGS: "Rankings", ROSTERS: "Rosters", DRAFT: "Draft", SCHEDULE: "Schedule" };

function CapChecks() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {CAPABILITIES.map((c) => (
        <label key={c} className="inline-flex items-center gap-1.5 text-sm">
          <input type="checkbox" name="capability" value={c} /> {CAP_LABEL[c]}
        </label>
      ))}
    </div>
  );
}

export default async function AccessAdmin() {
  if (!(await isAdmin())) return <NoAccess what="manage access" />;
  const [grants, players, seasons, overview] = await Promise.all([listGrants(), grantablePlayers(), seasonOptions(), accessOverview()]);
  const seasonOpts = [{ value: "", label: "All seasons" }, ...seasons.map((s) => ({ value: s.id, label: s.name }))];

  return (
    <main>
      <p><Link href="/admin" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> admin</Link></p>
      <h1 className="flex items-center gap-2"><KeyRound className="size-5" /> Access</h1>
      <p className="sub">Delegate capabilities to a person or a Discord role. OWNER/TO always have everything; captains automatically manage their own team.</p>

      {/* Grant to a player */}
      <div className="card">
        <div className="bracket-title">Grant to a player</div>
        <ActionFlashForm action={grantAction}>
          <input type="hidden" name="subjectType" value="USER" />
          <div className="flex flex-wrap items-end gap-2 mb-2">
            <label className="block"><span className="sub">Player</span><FormSelect name="subjectId" options={[{ value: "", label: "— select —" }, ...players.map((p) => ({ value: p.discordId, label: p.name }))]} /></label>
            <label className="block"><span className="sub">Scope</span><FormSelect name="seasonId" options={seasonOpts} /></label>
          </div>
          <div className="mb-2"><span className="sub">Capabilities</span><CapChecks /></div>
          <SubmitButton pendingText="Granting…">Grant</SubmitButton>
        </ActionFlashForm>
      </div>

      {/* Grant to a Discord role */}
      <div className="card">
        <div className="bracket-title">Grant to a Discord role</div>
        <ActionFlashForm action={grantAction}>
          <input type="hidden" name="subjectType" value="ROLE" />
          <div className="flex flex-wrap items-end gap-2 mb-2">
            <label className="block"><span className="sub">Role ID</span><input name="subjectId" placeholder="e.g. 123456789012345678" className={`${inputCls} w-56`} /></label>
            <label className="block"><span className="sub">Role name (label)</span><input name="label" placeholder="e.g. Casters" className={`${inputCls} w-40`} /></label>
            <label className="block"><span className="sub">Scope</span><FormSelect name="seasonId" options={seasonOpts} /></label>
          </div>
          <div className="mb-2"><span className="sub">Capabilities</span><CapChecks /></div>
          <SubmitButton pendingText="Granting…">Grant</SubmitButton>
        </ActionFlashForm>
      </div>

      {/* Current grants */}
      <h2 style={{ fontSize: "1.1rem", margin: "1.5rem 0 0.5rem" }}>Mod grants</h2>
      {grants.length === 0 ? (
        <div className="card"><p className="sub">No delegated capabilities yet.</p></div>
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Subject</th><th>Type</th><th>Capability</th><th>Scope</th><th></th></tr></thead>
            <tbody>
              {grants.map((g) => (
                <tr key={g.id}>
                  <td className="font-semibold">{g.label ?? g.subjectId}{g.label ? <span className="sub"> · {g.subjectId}</span> : null}</td>
                  <td className="sub">{g.subjectType === "USER" ? "Player" : "Role"}</td>
                  <td>{CAP_LABEL[g.capability] ?? g.capability}</td>
                  <td className="sub">{g.seasonName ?? "All seasons"}</td>
                  <td style={{ textAlign: "right" }}>
                    <form action={revokeAction}>
                      <input type="hidden" name="id" value={g.id} />
                      <ConfirmButton message={`Revoke ${CAP_LABEL[g.capability]} from ${g.label ?? g.subjectId}?`} variant="destructive" size="sm"><Trash2 className="size-3.5" /></ConfirmButton>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Roles at a glance */}
      <h2 style={{ fontSize: "1.1rem", margin: "1.5rem 0 0.5rem" }}>Roles at a glance</h2>
      <div className="card">
        <div className="bracket-title">TO / Owner roles</div>
        {overview.toBindings.length === 0 ? (
          <p className="sub">No Discord roles bound to OWNER/TO (env-pinned owners still apply).</p>
        ) : (
          <ul className="list-none p-0" style={{ margin: 0 }}>
            {overview.toBindings.map((b) => (
              <li key={b.discordRoleId} className="py-0.5 text-sm"><span className="badge">{b.tier}</span> <span className="sub">role {b.discordRoleId}</span></li>
            ))}
          </ul>
        )}
      </div>
      {overview.captainsBySeason.map((s) => (
        <div className="card" key={s.season}>
          <div className="bracket-title flex items-center gap-1.5"><Crown className="size-3.5 text-[var(--accent)]" /> Captains · {s.season}</div>
          <div className="grid gap-x-6 gap-y-1" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
            {s.rows.map((r) => (
              <div key={r.teamSeasonId} className="text-sm"><Link href={`/teams/${r.teamSeasonId}`}>{r.team}</Link> <span className="sub">· {r.captain}</span></div>
            ))}
          </div>
        </div>
      ))}
    </main>
  );
}
