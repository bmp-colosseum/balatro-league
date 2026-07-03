import Link from "next/link";
import { ArrowLeft, Crown } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { getSeasonAdmin } from "@/lib/services/seasons";
import { listSignups, priorParticipation, SIGNUP_OPTIONS } from "@/lib/services/signups";
import { captainedTeamsByDiscord } from "@/lib/services/teams-admin";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { FormSelect } from "@/components/FormSelect";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmButton } from "@/components/ConfirmButton";
import { SelectAllCheckbox } from "@/components/SelectAllCheckbox";
import { TimezoneSelect } from "@/components/TimezoneSelect";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addSignupAction, setSignupStatusAction, bulkSignupStatusAction, removeSignupAction, makeCaptainAction } from "./actions";

export const dynamic = "force-dynamic";

const STATUS_COLOR: Record<string, string> = {
  PENDING: "var(--muted)",
  APPROVED: "var(--success)",
  REJECTED: "var(--danger)",
  WITHDRAWN: "var(--muted)",
};

// The review queue's views. Default = Pending (the actual work).
const TABS = [
  { key: "pending", label: "Pending", match: (st: string) => st === "PENDING" },
  { key: "approved", label: "Approved", match: (st: string) => st === "APPROVED" },
  { key: "out", label: "Rejected + withdrawn", match: (st: string) => st === "REJECTED" || st === "WITHDRAWN" },
  { key: "all", label: "All", match: () => true },
] as const;

const fmtDate = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const fmtRel = (d: Date, now: number) => {
  const days = Math.floor((now - d.getTime()) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "1d ago" : `${days}d ago`;
};

// Small labeled role pill — replaces the old mystery icons.
function Pill({ children, color }: { children: string; color?: string }) {
  return (
    <span className="pill" style={{ fontSize: "0.72rem", color: color ?? "var(--muted)", border: `1px solid ${color ?? "var(--border)"}` }}>
      {children}
    </span>
  );
}

export default async function Signups({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  if (!(await isAdmin())) {
    return (
      <main>
        <h1>Admin</h1>
        <Callout type="admin">Admins only — you don&apos;t have access.</Callout>
      </main>
    );
  }

  const [{ name }, { tab: tabParam }] = await Promise.all([params, searchParams]);
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
  const signups = await listSignups(seasonName); // createdAt asc — signup order matters
  const prior = await priorParticipation(signups.map((s) => s.discordId));
  const captainOf = await captainedTeamsByDiscord(seasonName); // discordId → their team this season
  const enc = encodeURIComponent(seasonName);
  const now = Date.now();

  const tab = TABS.find((t) => t.key === tabParam) ?? TABS[0];
  const rows = signups.filter((s) => tab.match(s.status));
  const countOf = (t: (typeof TABS)[number]) => signups.filter((s) => t.match(s.status)).length;
  const approved = countOf(TABS[1]);

  // One status-change button (a tiny server-action form). Carries the active tab so the
  // post-action redirect keeps the queue view; feedback surfaces as a toast.
  const StatusBtn = ({ id, status, label, variant }: { id: string; status: string; label: string; variant?: "default" | "secondary" }) => (
    <form action={setSignupStatusAction} className="inline">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="season" value={seasonName} />
      <input type="hidden" name="tab" value={tab.key} />
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
              <Input id="discordId" name="discordId" required pattern="\d{17,20}" title="17-20 digits — right-click the user in Discord and Copy User ID (Developer Mode)" placeholder="e.g. 123456789012345678" className="w-56" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="displayName">Display name</Label>
              <Input id="displayName" name="displayName" placeholder="optional" className="w-44" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="timezone">Timezone</Label>
              <TimezoneSelect name="timezone" className="w-52 rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1" />
            </div>
            <div className="grid gap-1.5">
              <Label>Captain?</Label>
              <FormSelect name="captainInterest" placeholder="not asked" options={[{ value: "", label: "not asked" }, ...SIGNUP_OPTIONS.captainInterest.map((o) => ({ value: o, label: o }))]} triggerClassName="w-52" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="bmpHandle">BMP handle</Label>
              <Input id="bmpHandle" name="bmpHandle" placeholder="optional" className="w-40" />
            </div>
            <SubmitButton pendingText="Adding…">Add</SubmitButton>
          </div>
        </ActionFlashForm>
        <p className="sub" style={{ marginBottom: 0 }}>Numbers only for the Discord ID — enable Developer Mode in Discord, right-click the user, Copy User ID.</p>
      </div>

      {/* Tabs — the review queue defaults to Pending. */}
      <div className="flex flex-wrap items-center gap-2" style={{ margin: "0 0 10px" }}>
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/admin/seasons/${enc}/signups${t.key === "pending" ? "" : `?tab=${t.key}`}`}
            className="pill"
            style={{
              background: t.key === tab.key ? "var(--accent-2)" : "var(--surface-2)",
              color: t.key === tab.key ? "#fff" : "var(--muted)",
              border: "1px solid var(--border)",
            }}
          >
            {t.label} · {countOf(t)}
          </Link>
        ))}
      </div>

      {/* Bulk bar — row checkboxes join this form via form="bulk-signups". */}
      <ActionFlashForm action={bulkSignupStatusAction} id="bulk-signups" className="flex flex-wrap items-center gap-2" style={{ marginBottom: 10 }}>
        <input type="hidden" name="season" value={seasonName} />
        <span className="sub">With selected:</span>
        <SubmitButton size="sm" name="bulkStatus" value="APPROVED" pendingText="…">Approve</SubmitButton>
        <SubmitButton size="sm" variant="secondary" name="bulkStatus" value="REJECTED" pendingText="…">Reject</SubmitButton>
      </ActionFlashForm>

      <div className="card" style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th><SelectAllCheckbox boxName="ids" formId="bulk-signups" /></th>
              <th>Player</th>
              <th>Roles</th>
              <th>History</th>
              <th className="num">BMP</th>
              <th>Timezone</th>
              <th className="num">Discord activity</th>
              <th>Signed up</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const h = prior.get(s.discordId);
              const flags: string[] = [];
              if (s.upcomingBreaks && s.upcomingBreaks !== "No") flags.push(`breaks: ${s.upcomingBreaks.toLowerCase()}`);
              if (s.weeklyCommit && s.weeklyCommit !== "Yes") flags.push(`weekly: ${s.weeklyCommit.toLowerCase()}`);
              if (s.englishOk === false) flags.push("no english");
              const wantsCaptain = s.captainInterest === "Yes, I would love to!" || s.captainInterest === "I will if it is needed";
              return (
              <tr key={s.id}>
                <td><input type="checkbox" name="ids" value={s.id} form="bulk-signups" aria-label={`Select ${s.displayName ?? s.discordId}`} /></td>
                <td>
                  {s.displayName ?? <span className="muted">{s.discordId}</span>}
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
                <td>
                  <span className="flex flex-wrap gap-1">
                    {s.captainInterest === "Yes, I would love to!" && <Pill color="var(--accent)">Captain</Pill>}
                    {s.captainInterest === "I will if it is needed" && <Pill>Captain if needed</Pill>}
                    {s.helperInterest && <Pill color="var(--accent-2)">Helper</Pill>}
                    {s.coachWilling && <Pill>Coach</Pill>}
                    {s.coachWanted && <Pill>Wants coaching</Pill>}
                  </span>
                </td>
                <td className="sub">{h ? `${h.label} · ${h.seasons} ssn` : "new"}</td>
                <td className="num sub">{s.bmpTier ? `${s.bmpTier}${s.bmpMmr != null ? ` ${s.bmpMmr}` : ""}` : s.bmpHandle ?? "—"}</td>
                <td className="sub">{s.timezone ?? "—"}</td>
                <td className="num sub">{s.discordActivity != null ? `${s.discordActivity}/10` : "—"}</td>
                <td className="sub" title={s.createdAt.toISOString()}>{fmtDate(s.createdAt)} <span className="muted">· {fmtRel(s.createdAt, now)}</span></td>
                <td>
                  <span className="pill" style={{ color: STATUS_COLOR[s.status], border: `1px solid ${STATUS_COLOR[s.status]}` }}>
                    {s.status}
                  </span>
                </td>
                <td>
                  <span className="flex flex-wrap gap-1.5">
                    {s.status !== "APPROVED" && <StatusBtn id={s.id} status="APPROVED" label="Approve" />}
                    {s.status !== "REJECTED" && <StatusBtn id={s.id} status="REJECTED" label="Reject" variant="secondary" />}
                    {captainOf.has(s.discordId) ? (
                      <Link href={`/teams/${captainOf.get(s.discordId)!.teamSeasonId}`} className="pill inline-flex items-center gap-1" style={{ border: "1px solid var(--accent)", color: "var(--accent)" }}>
                        <Crown className="size-3" /> {captainOf.get(s.discordId)!.team}
                      </Link>
                    ) : (
                      s.status === "APPROVED" && wantsCaptain && (
                        <form action={makeCaptainAction} className="inline">
                          <input type="hidden" name="discordId" value={s.discordId} />
                          <input type="hidden" name="season" value={seasonName} />
                          <input type="hidden" name="tab" value={tab.key} />
                          <SubmitButton size="sm" variant="secondary" pendingText="…"><Crown className="size-3.5" /> Make captain</SubmitButton>
                        </form>
                      )
                    )}
                    <form action={removeSignupAction} className="inline">
                      <input type="hidden" name="id" value={s.id} />
                      <input type="hidden" name="season" value={seasonName} />
                      <input type="hidden" name="tab" value={tab.key} />
                      <ConfirmButton message="Remove this signup?" variant="destructive" size="sm">Remove</ConfirmButton>
                    </form>
                  </span>
                </td>
              </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={10} className="sub">
                {signups.length === 0
                  ? "No signups yet. Add players above (or players self-serve at /signup)."
                  : `Nothing ${tab.key === "pending" ? "pending — the queue is clear" : `in "${tab.label}"`}.`}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
