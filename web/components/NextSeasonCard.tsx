// Shared "next season" opt-in card: 🔔 Notify (SeasonInterest, keyed by
// Discord id) + 🔁 Auto-sign-up (Player.autoSignup). Rendered on both the
// profile page (own-profile section) and /me (the not-linked view), so the
// two surfaces stay identical.
//
// autoSignup semantics:
//   boolean → the viewer has a Player record; show the on/off toggle.
//   null    → no Player record yet (e.g. an admin who never joined); enabling
//             creates one, so show a one-way "enable" button with that note.

import { Button } from "@/components/ui/button";
import {
  subscribeNextSeasonAction,
  unsubscribeNextSeasonAction,
  setAutoSignupAction,
} from "@/app/me/actions";

export function NextSeasonCard({
  interest,
  autoSignup,
}: {
  interest: { subscribedAt: Date } | null;
  autoSignup: boolean | null;
}) {
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <strong>Next season</strong>
      <p className="muted" style={{ fontSize: 11, marginTop: 2 }}>
        Two separate things: <strong>🔔 Notify</strong> just DMs you when signups open — you still
        click Sign up yourself. <strong>🔁 Auto-sign-up</strong> enters you automatically, no action
        needed{autoSignup === null ? " (and creates your player profile)" : ""}.
      </p>

      {interest ? (
        <>
          <p className="muted" style={{ fontSize: 12 }}>
            ✓ Subscribed (since {interest.subscribedAt.toISOString().slice(0, 10)}). The bot DMs you when the next season&apos;s signups open.
          </p>
          <form action={unsubscribeNextSeasonAction}>
            <Button type="submit" variant="secondary">Unsubscribe</Button>
          </form>
        </>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 12 }}>
            Get a Discord DM the moment a new season&apos;s signups open.
          </p>
          <form action={subscribeNextSeasonAction}>
            <Button type="submit">🔔 Notify me about the next season</Button>
          </form>
        </>
      )}

      <hr style={{ margin: "12px 0", border: "none", borderTop: "1px solid var(--border)" }} />

      {autoSignup === null ? (
        <>
          <p className="muted" style={{ fontSize: 12 }}>
            Auto-sign-up enters you into the next season automatically when signups open. Turning it
            on creates your player profile so you&apos;re ready to play.
          </p>
          <form action={setAutoSignupAction}>
            <input type="hidden" name="next" value="1" />
            <Button type="submit">🔁 Auto-sign me up next season</Button>
          </form>
        </>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 12 }}>
            {autoSignup
              ? "✓ Auto-sign-up is ON — you'll be entered into the next season's signups automatically the moment they open (you can still withdraw)."
              : "Auto-sign-up is off. Turn it on to be entered into the next season's signups automatically when they open."}
          </p>
          <form action={setAutoSignupAction}>
            <input type="hidden" name="next" value={autoSignup ? "0" : "1"} />
            <Button type="submit" variant={autoSignup ? "secondary" : "default"}>
              {autoSignup ? "Turn off auto-sign-up" : "🔁 Auto-sign me up next season"}
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
