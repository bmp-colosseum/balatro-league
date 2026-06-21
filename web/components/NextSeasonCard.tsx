// Single "season reminders" toggle. Replaces the old 🔔 Notify + 🔁 Auto-sign-up
// pair — auto-enroll was removed in favor of an interactive ask. When ON, the
// bot DMs you a quick "you in?" (with join / pass / snooze buttons) the moment a
// new season's signups open. Rendered on both /me and your own profile so the
// two surfaces stay identical.

import { Button } from "@/components/ui/button";
import { setSeasonRemindersAction } from "@/app/me/actions";

export function NextSeasonCard({ remindersOn }: { remindersOn: boolean }) {
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <strong>Season reminders</strong>
      <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        {remindersOn
          ? "✓ You're on the list. When a new season's signups open, the bot DMs you to ask if you're in — one tap to join, pass, or snooze."
          : "When a new season's signups open, the bot can DM you to ask if you're in, so you don't miss it. One tap to join, pass, or snooze."}
      </p>
      <form action={setSeasonRemindersAction}>
        <input type="hidden" name="next" value={remindersOn ? "0" : "1"} />
        <Button type="submit" variant={remindersOn ? "secondary" : "default"}>
          {remindersOn ? "🔕 Stop season reminders" : "🔔 Remind me about new seasons"}
        </Button>
      </form>
    </div>
  );
}
