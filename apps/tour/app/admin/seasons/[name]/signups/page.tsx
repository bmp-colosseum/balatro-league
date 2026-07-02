import Link from "next/link";
import { ArrowLeft, Crown, Hand, GraduationCap } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { getSeasonAdmin } from "@/lib/services/seasons";
import { listSignups, priorParticipation } from "@/lib/services/signups";
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
  const prior = await priorParticipation(signups.map((s) => s.discordId));
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

      <div className="card" style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th>History</th>
              <th className="num">BMP</th>
              <th>Timezone</th>
              <th className="num" title="Discord activity (1-10)">Disc</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {signups.map((s) => {
              const h = prior.get(s.discordId);
              const flags: string[] = [];
              if (s.upcomingBreaks && s.upcomingBreaks !== "No") flags.push(`breaks: ${s.upcomingBreaks.toLowerCase()}`);
              if (s.weeklyCommit && s.weeklyCommit !== "Yes") flags.push(`weekly: ${s.weeklyCommit.toLowerCase()}`);
              if (s.englishOk === false) flags.push("no english");
              return (
              <tr key={s.id}>
                <td>
                  <span className="flex items-center gap-1.5">
                    {s.captainInterest === "Yes, I would love to!" && <Crown className="size-3.5 text-[var(--accent)]" aria-label="Wants to captain" />}
                    {s.captainInterest === "I will if it is needed" && <Crown className="size-3.5 text-[var(--muted)]" aria-label="Captain if needed" />}
                    {s.helperInterest && <Hand className="size-3.5 text-[var(--accent-2)]" aria-label="Helper/assistant TO" />}
                    {(s.coachWilling || s.coachWanted) && <GraduationCap className="size-3.5 text-[var(--muted)]" aria-label={s.coachWilling && s.coachWanted ? "Coach + coachee" : s.coachWilling ? "Will coach" : "Wants coaching"} />}
                    {s.displayName ?? <span className="muted">{s.discordId}</span>}
                  </span>
                  {s.displayName && <span className="discord-username">{s.discordId}</span>}
                  {(s.comments || s.availability || flags.length > 0) && (
                    <details>
                      <summary className="sub" style={{ cursor: "pointer" }}>details{flags.length ? ` · ${flags.join(" · ")}` : ""}</summary>
                      <div className="sub" style={{ maxWidth: 480, whiteSpace: "pre-wrap" }}>
                        {s.availability && <div><strong>Active:</strong> {s.availability}</div>}
                        {s.scheduleAgency && <div><strong>Schedule:</strong> {s.scheduleAgency}</div>}
                        {s.playFrequency && <div><strong>Plays:</strong> {s.playFrequency}</div>}
                        {s.teamActivity && <div><strong>Team activity:</strong> {s.teamActivity}</div>}
                        {s.coachingNote && <div><strong>Coaching:</strong> {s.coachingNote}</div>}
                        {s.asyncExp && <div><strong>Async exp:</strong> {s.asyncExp}</div>}
                        {s.twitchFollow && <div><strong>Twitch:</strong> {s.twitchFollow}</div>}
                        {s.comments && <div><strong>Intro:</strong> {s.comments}</div>}
                      </div>
                    </details>
                  )}
                </td>
                <td className="sub">{h ? `${h.label} · ${h.seasons} ssn` : "new"}</td>
                <td className="num sub">{s.bmpTier ? `${s.bmpTier}${s.bmpMmr != null ? ` ${s.bmpMmr}` : ""}` : s.bmpHandle ?? "—"}</td>
                <td className="sub">{s.timezone ?? "—"}</td>
                <td className="num sub">{s.discordActivity ?? "—"}</td>
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
              );
            })}
            {signups.length === 0 && (
              <tr><td colSpan={7} className="sub">No signups yet. Add players above (or players self-serve at /signup).</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
