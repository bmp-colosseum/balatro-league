import Link from "next/link";
import { ArrowLeft, Crown } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { getSeasonAdmin } from "@/lib/services/seasons";
import { listSignups } from "@/lib/services/signups";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addSignupAction, setSignupStatusAction, removeSignupAction } from "./actions";

export const dynamic = "force-dynamic";

const STATUS_COLOR: Record<string, string> = {
  PENDING: "var(--muted)",
  APPROVED: "var(--success)",
  REJECTED: "var(--danger)",
  WITHDRAWN: "var(--muted)",
};

export default async function Signups({ params }: { params: Promise<{ name: string }> }) {
  if (!(await isAdmin())) {
    return (
      <main>
        <h1>Admin</h1>
        <Callout type="admin">Admins only — you don&apos;t have access.</Callout>
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
  const signups = await listSignups(seasonName);
  const enc = encodeURIComponent(seasonName);
  const approved = signups.filter((s) => s.status === "APPROVED").length;

  // One status-change button (a tiny server-action form).
  const StatusBtn = ({ id, status, label, variant }: { id: string; status: string; label: string; variant?: "default" | "secondary" }) => (
    <form action={setSignupStatusAction} className="inline">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="season" value={seasonName} />
      <input type="hidden" name="status" value={status} />
      <SubmitButton size="sm" variant={variant}>{label}</SubmitButton>
    </form>
  );

  return (
    <main>
      <p>
        <Link href={`/admin/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {seasonName}</Link>
      </p>
      <h1>Signups</h1>
      <p className="sub">{approved} approved · {signups.length} total in the pool. Approved signups become the draft pool.</p>

      <div className="card">
        <div className="bracket-title">Add to the pool</div>
        <ActionFlashForm action={addSignupAction}>
          <input type="hidden" name="season" value={seasonName} />
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="discordId">Discord ID *</Label>
              <Input id="discordId" name="discordId" required placeholder="e.g. 123456789012345678" className="w-56" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="displayName">Display name</Label>
              <Input id="displayName" name="displayName" placeholder="optional" className="w-44" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="timezone">Timezone</Label>
              <Input id="timezone" name="timezone" placeholder="America/New_York" className="w-44" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="bmpHandle">BMP handle</Label>
              <Input id="bmpHandle" name="bmpHandle" placeholder="optional" className="w-40" />
            </div>
            <label className="flex flex-row items-center gap-2 text-sm" style={{ color: "var(--text)" }}>
              <input type="checkbox" name="willingToCaptain" /> Captain
            </label>
            <SubmitButton pendingText="Adding…">Add</SubmitButton>
          </div>
        </ActionFlashForm>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th>Timezone</th>
              <th>BMP</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {signups.map((s) => (
              <tr key={s.id}>
                <td>
                  <span className="flex items-center gap-1.5">
                    {s.willingToCaptain && <Crown className="size-3.5 text-[var(--accent)]" aria-label="Willing to captain" />}
                    {s.displayName ?? <span className="muted">{s.discordId}</span>}
                  </span>
                  {s.displayName && <span className="discord-username">{s.discordId}</span>}
                </td>
                <td className="sub">{s.timezone ?? "—"}</td>
                <td className="sub">{s.bmpHandle ?? "—"}</td>
                <td>
                  <span className="pill" style={{ color: STATUS_COLOR[s.status], border: `1px solid ${STATUS_COLOR[s.status]}` }}>
                    {s.status}
                  </span>
                </td>
                <td>
                  <span className="flex flex-wrap gap-1.5">
                    {s.status !== "APPROVED" && <StatusBtn id={s.id} status="APPROVED" label="Approve" />}
                    {s.status !== "REJECTED" && <StatusBtn id={s.id} status="REJECTED" label="Reject" variant="secondary" />}
                    <form action={removeSignupAction} className="inline">
                      <input type="hidden" name="id" value={s.id} />
                      <input type="hidden" name="season" value={seasonName} />
                      <ConfirmButton message="Remove this signup?" variant="destructive" size="sm">Remove</ConfirmButton>
                    </form>
                  </span>
                </td>
              </tr>
            ))}
            {signups.length === 0 && (
              <tr><td colSpan={5} className="sub">No signups yet. Add players above (or, later, players self-serve via Discord).</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
