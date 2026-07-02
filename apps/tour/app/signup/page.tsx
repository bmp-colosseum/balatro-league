import Link from "next/link";
import { LogIn } from "lucide-react";
import { getViewer } from "@/lib/auth";
import { getOpenSignupSeason, getMySignup, priorParticipation, SIGNUP_OPTIONS } from "@/lib/services/signups";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { TimezoneSelect } from "@/components/TimezoneSelect";
import { submitSignupAction, withdrawSignupAction } from "./actions";

export const dynamic = "force-dynamic";

const field = "w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1";
const STATUS: Record<string, { label: string; color: string }> = {
  PENDING: { label: "Pending review", color: "var(--accent-2)" },
  APPROVED: { label: "Approved — you're in the pool", color: "var(--success)" },
  REJECTED: { label: "Not admitted this season", color: "var(--danger)" },
  WITHDRAWN: { label: "Withdrawn", color: "var(--muted)" },
};

// A labeled native select (posts with the form; keeps the historical option wording).
function Opt({ name, label, options, value, allowEmpty = true }: { name: string; label: string; options: readonly string[]; value?: string | null; allowEmpty?: boolean }) {
  return (
    <label className="block">
      <span className="sub">{label}</span>
      <select name={name} defaultValue={value ?? ""} className={field}>
        {allowEmpty && <option value="">— select —</option>}
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}

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
        <p className="sub">Signups are open. Sign in with Discord to register — it takes about a minute.</p>
        <Link href="/auth/signin" className="inline-flex items-center gap-1.5">
          <LogIn className="size-4" /> Sign in with Discord
        </Link>
      </main>
    );
  }

  const [mine, prior] = await Promise.all([
    getMySignup(season.id, viewer.discordId),
    priorParticipation([viewer.discordId]),
  ]);
  const history = prior.get(viewer.discordId) ?? null;
  const status = mine ? STATUS[mine.status] : null;
  const active = mine && (mine.status === "PENDING" || mine.status === "APPROVED");

  return (
    <main>
      <h1>Sign up — {season.name}</h1>
      <p className="sub">
        Signed in as <strong>{viewer.name ?? viewer.discordId}</strong>
        {history ? <> · returning {history.label} ({history.seasons} season{history.seasons === 1 ? "" : "s"}) — we already know your history</> : <> · first Team Tour — welcome!</>}
        . {mine ? "Update your entry below." : "Your name, Discord, rank, and history are handled automatically — just answer the questions."}
      </p>

      {status && (
        <Callout type={mine!.status === "APPROVED" ? "success" : mine!.status === "REJECTED" ? "danger" : "info"}>
          Status: <strong style={{ color: status.color }}>{status.label}</strong>
          {mine?.bmpTier ? <> · BMP rank pulled: <strong>{mine.bmpTier}{mine.bmpMmr != null ? ` (${mine.bmpMmr} MMR)` : ""}</strong></> : null}
        </Callout>
      )}

      <div className="card">
        <ActionFlashForm action={submitSignupAction}>
          <input type="hidden" name="season" value={season.name} />

          <div className="bracket-title">Schedule</div>
          <div className="grid grid-2" style={{ gap: "0.75rem" }}>
            <label className="block">
              <span className="sub">Timezone</span>
              <TimezoneSelect name="timezone" defaultValue={mine?.timezone} className={field} />
            </label>
            <label className="block">
              <span className="sub">When are you usually active?</span>
              <input name="availability" defaultValue={mine?.availability ?? ""} placeholder="e.g. weekday evenings, most of the weekend" className={field} />
            </label>
            <Opt name="scheduleAgency" label="Do you have control over your own schedule?" options={SIGNUP_OPTIONS.scheduleAgency} value={mine?.scheduleAgency} />
            <Opt name="upcomingBreaks" label="Any week-plus breaks coming up?" options={SIGNUP_OPTIONS.upcomingBreaks} value={mine?.upcomingBreaks} />
          </div>

          <div className="bracket-title" style={{ marginTop: "1rem" }}>You + your team</div>
          <div className="grid grid-2" style={{ gap: "0.75rem" }}>
            <label className="block">
              <span className="sub">How often do you play Balatro, and how? (single player, ranked…)</span>
              <input name="playFrequency" defaultValue={mine?.playFrequency ?? ""} className={field} />
            </label>
            <label className="block">
              <span className="sub">How active will you be with your team? (messaging, practice, voice)</span>
              <input name="teamActivity" defaultValue={mine?.teamActivity ?? ""} className={field} />
            </label>
            <Opt name="captainInterest" label="Would you like to be a captain? (drafting, weekly matchups, keeping players playing)" options={SIGNUP_OPTIONS.captainInterest} value={mine?.captainInterest} />
            <label className="block">
              <span className="sub">How often are you on Discord? (1-10 · once per day = 6)</span>
              <input type="number" name="discordActivity" min={1} max={10} defaultValue={mine?.discordActivity ?? undefined} className={field} />
            </label>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
            <label className="flex items-center gap-2"><input type="checkbox" name="coachWilling" defaultChecked={mine?.coachWilling ?? false} /> <span>I&apos;m willing to coach</span></label>
            <label className="flex items-center gap-2"><input type="checkbox" name="coachWanted" defaultChecked={mine?.coachWanted ?? false} /> <span>I&apos;d like to be coached</span></label>
            <label className="flex items-center gap-2"><input type="checkbox" name="helperInterest" defaultChecked={mine?.helperInterest ?? false} /> <span>I&apos;d help as an assistant TO</span></label>
            <label className="flex items-center gap-2"><input type="checkbox" name="englishOk" defaultChecked={mine?.englishOk ?? true} /> <span>I can communicate in English</span></label>
          </div>
          <label className="mt-2 block">
            <span className="sub">Voice calls / mic / how much coaching? (optional)</span>
            <input name="coachingNote" defaultValue={mine?.coachingNote ?? ""} className={field} />
          </label>

          <div className="bracket-title" style={{ marginTop: "1rem" }}>The commitments</div>
          <div className="grid grid-2" style={{ gap: "0.75rem" }}>
            <Opt name="weeklyCommit" label="Can you play + schedule one Bo3 set (2-3 hrs) per week for 7-10 weeks?" options={SIGNUP_OPTIONS.yesMaybeNo} value={mine?.weeklyCommit} />
            <Opt name="outreach" label="Will you reach out to your opponents each week?" options={SIGNUP_OPTIONS.yesMaybeNo} value={mine?.outreach} />
            <Opt name="modCheck" label="Will you check mod versions before each set?" options={SIGNUP_OPTIONS.yesMaybeNo} value={mine?.modCheck} />
            <Opt name="respectPledge" label="Will you treat opponents, teammates, and TOs with respect?" options={SIGNUP_OPTIONS.yesMaybeNo} value={mine?.respectPledge} />
            <Opt name="asyncExp" label="Experience scheduling gaming sets asynchronously?" options={SIGNUP_OPTIONS.asyncExp} value={mine?.asyncExp} />
            <Opt name="twitchFollow" label="Will you follow PizzaPower55 on Twitch?" options={SIGNUP_OPTIONS.twitchFollow} value={mine?.twitchFollow} />
          </div>

          <div className="bracket-title" style={{ marginTop: "1rem" }}>Introduce yourself</div>
          <label className="block">
            <span className="sub">Anything captains and TOs should know — introduce yourself! Include self nerfs here. (This becomes the flavor text on your player card 🍕)</span>
            <textarea name="comments" defaultValue={mine?.comments ?? ""} rows={4} className={field} />
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
