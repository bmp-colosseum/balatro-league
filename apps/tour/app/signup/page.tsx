import Link from "next/link";
import { LogIn } from "lucide-react";
import { getViewer } from "@/lib/auth";
import { getOpenSignupSeason, getMySignup } from "@/lib/services/signups";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { submitSignupAction, withdrawSignupAction } from "./actions";

export const dynamic = "force-dynamic";

const field = "w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1";
const STATUS: Record<string, { label: string; color: string }> = {
  PENDING: { label: "Pending review", color: "var(--accent-2)" },
  APPROVED: { label: "Approved — you're in the pool", color: "var(--success)" },
  REJECTED: { label: "Not admitted this season", color: "var(--danger)" },
  WITHDRAWN: { label: "Withdrawn", color: "var(--muted)" },
};

export default async function SignupPage() {
  const [viewer, season] = await Promise.all([getViewer(), getOpenSignupSeason()]);

  if (!season) {
    return (
      <main>
        <h1>Sign up</h1>
        <Callout type="info">No season is open for signups right now. Check back when the next Team Tour opens.</Callout>
      </main>
    );
  }

  if (!viewer.discordId) {
    return (
      <main>
        <h1>Sign up — {season.name}</h1>
        <p className="sub">Signups are open. Sign in with Discord to register.</p>
        <Link href="/auth/signin" className="inline-flex items-center gap-1.5">
          <LogIn className="size-4" /> Sign in with Discord
        </Link>
      </main>
    );
  }

  const mine = await getMySignup(season.id, viewer.discordId);
  const status = mine ? STATUS[mine.status] : null;
  const active = mine && (mine.status === "PENDING" || mine.status === "APPROVED");

  return (
    <main>
      <h1>Sign up — {season.name}</h1>
      <p className="sub">Signed in as <strong>{viewer.name ?? viewer.discordId}</strong>. {mine ? "Update your entry below." : "Fill in your details to register."}</p>

      {status && (
        <Callout type={mine!.status === "APPROVED" ? "success" : mine!.status === "REJECTED" ? "danger" : "info"}>
          Status: <strong style={{ color: status.color }}>{status.label}</strong>
        </Callout>
      )}

      <div className="card">
        <ActionFlashForm action={submitSignupAction}>
          <input type="hidden" name="season" value={season.name} />
          <div className="grid grid-2" style={{ gap: "0.75rem" }}>
            <label className="block">
              <span className="sub">Timezone</span>
              <input name="timezone" defaultValue={mine?.timezone ?? ""} placeholder="e.g. America/New_York" className={field} />
            </label>
            <label className="block">
              <span className="sub">Balatro MP handle (optional)</span>
              <input name="bmpHandle" defaultValue={mine?.bmpHandle ?? ""} placeholder="for your scraped rank" className={field} />
            </label>
          </div>
          <label className="mt-3 block">
            <span className="sub">General availability</span>
            <textarea name="availability" defaultValue={mine?.availability ?? ""} rows={3} placeholder="When you can usually play — a hint for scheduling, not a hard schedule." className={field} />
          </label>
          <label className="mt-3 flex items-center gap-2">
            <input type="checkbox" name="willingToCaptain" defaultChecked={mine?.willingToCaptain ?? false} />
            <span>I&apos;m willing to captain a team</span>
          </label>
          <div className="mt-3">
            <SubmitButton pendingText="Saving…">{mine ? "Update my signup" : "Sign up"}</SubmitButton>
          </div>
        </ActionFlashForm>
      </div>

      {active && (
        <form action={withdrawSignupAction} className="mt-2">
          <input type="hidden" name="season" value={season.name} />
          <SubmitButton variant="secondary" size="sm" pendingText="…">Withdraw from this season</SubmitButton>
        </form>
      )}
    </main>
  );
}
