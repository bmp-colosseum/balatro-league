# Season lifecycle

End to end: signups open, divisions get built, the season starts, play happens,
the season ends. The Season tools page (`/admin/season-tools`) walks the same
order as this page, so the two should always agree.

Sources: [src/auto-signups.ts](../../src/auto-signups.ts),
[src/auto-signups-core.ts](../../src/auto-signups-core.ts),
[web/lib/open-signups.ts](../../web/lib/open-signups.ts),
[web/lib/build-season.ts](../../web/lib/build-season.ts),
[web/lib/build-season-continuity.ts](../../web/lib/build-season-continuity.ts),
[web/lib/owen-placement.ts](../../web/lib/owen-placement.ts),
[web/lib/placement-rules.ts](../../web/lib/placement-rules.ts),
[web/lib/season-activation.ts](../../web/lib/season-activation.ts),
[web/lib/lock-schedule.ts](../../web/lib/lock-schedule.ts),
[web/lib/season-discord-bootstrap.ts](../../web/lib/season-discord-bootstrap.ts),
[web/lib/end-season.ts](../../web/lib/end-season.ts),
[web/app/admin/season-tools/page.tsx](../../web/app/admin/season-tools/page.tsx).

## 1. Signups

### Automatic opening

- The bot runs an hourly job, `signup.auto-open-tick`, in
  `src/auto-signups.ts`. The decision is a pure function, `decideAutoSignups`,
  in `src/auto-signups-core.ts` (copied into `web/lib/` by the sync script; see
  [standings-and-tiebreaks.md](standings-and-tiebreaks.md#mirrored-files)).
- Setting: `signups_auto_open_days` (Config page). Default 7. Zero or negative
  turns the feature off.
- Due date: if the active season has a planned end (`scheduledEndAt`), signups
  open that many days before it. If no end date is set, the fallback is
  that many days AFTER the season started. Set the planned end date or the
  fallback will open signups a week into the season.
- What it does when due: creates Season N+1 if it does not exist (copying
  group sizes, scoring mode and tiebreak from the active season), then posts
  the signup embed with buttons to `signups_channel_id`, falling back to the
  channel of the last round.
- Guards: skipped if any signup round is already OPEN or the next season
  already had a round. Any stale OPEN round is closed before a new one is made.

### The one-week-left announcement

- Same due instant as auto-open, independent of whether signups were opened
  by hand. Posted to the announcements channel, pinging the League Player
  role when one exists.
- Wording (in `src/auto-signups.ts`): "One week left in {season}! The season
  ends <date> (<relative>). Get your remaining matches played before then --
  press Who do I play? in your division channel to see who is left."
- The words "One week" are fixed. If `signups_auto_open_days` is changed to
  14, the message still says one week. Change the text if you change the days.
- Sent once per season, recorded in the `week_left_reminder_season` config
  row before sending.

### Opening by hand

`/admin/seasons`, on the season card, open "Open signups for this season" and
press "Open signups". The button is disabled until a channel is configured.
Both the button and the automatic path run `openSignupsCore` in
`web/lib/open-signups.ts`: close any stale round, create the round, post the
embed, write an audit row, enqueue the "Are you in?" DM kickoff and a
`#league-info` refresh.

While the round is open, the website also names the season: the home page
banner/hero and the admin lifecycle strip all read "Season N sign-ups are
open" (plus the live signed-up count), derived once in
`web/lib/signup-season-label-core.ts`.

### Closing (always by hand)

`/admin/seasons`, season card, "Close signups". This flips the round from
OPEN to CLOSED, edits the Discord post to its closed state and queues MMR
snapshots. "Reopen" reverses it. Nothing closes signups automatically.

A built round shows "Finalize signups" instead; it only stamps `closedAt`,
because a built round keeps accepting late sign-ups.

### Late sign-ups

A late joiner is added on `/admin/signups/{roundId}` (`addSignupToRound`). An
unbuilt draft absorbs them automatically (`absorbSignupsIntoDraft` in
`build-season-continuity.ts`). A live or ended season is never touched; use
the roster tools in [scheduling-and-roster-changes.md](scheduling-and-roster-changes.md).

## 2. Building divisions

Season tools step 3: "Preview", then "Build" (`/admin/signups/{id}/build`),
then the button "Set up the season - place N players".

- `buildSeasonFromRound` (`web/lib/build-season.ts`) either creates the season
  with its tiers and divisions, or populates an existing empty one. Banned
  players are dropped. The season is left inactive.
- Ladder shape (`owenLadder` in `web/lib/season-plan.ts`): Legendary is one
  division; Rare, Uncommon and Common each get 5 divisions when there are 96
  or more sign-ups, 4 at 78 or more, otherwise 3.
- Placement with history (`build-season-continuity.ts` and
  `owen-placement.ts`): returning players keep the division they finished in,
  except those promoted or relegated by finishing position. New players are
  slotted by MMR against each division's average. If a division overflows,
  only new players are moved.
- Promotion and relegation counts are written onto each division at build
  time (`Division.promoteCount`, `Division.relegateCount`) using the
  `placement_rules` config JSON (`web/lib/placement-rules.ts`). Defaults:
  Legendary capped at 6 and always 1 up / 1 down at its boundary; every other
  boundary swaps `baseSwap` players, or `bigSwap` when both neighbouring
  divisions have at least `swapThreshold` (8) members. Both defaults are
  currently 2, so division size does not change the count unless the config
  is edited. End-of-season uses these stored counts; it does not recompute
  them.
- The organiser sets the final counts by hand per division after building
  (for example 1 up / 1 down in a small division), and those manual values
  are the source of truth. Each division's channel welcome and standings
  show its own stored counts, so players always see the real number. Do not
  "correct" stored counts to a size rule without asking the organiser.
- Building creates nothing in Discord. Channels and roles appear at
  activation.

## 3. Starting a season

`/admin/seasons`, "Start season", or set `Season.scheduledStartAt` and let the
bot's 60-second sweep activate it (`src/match-sweep.ts`).

`performSeasonActivation` (`web/lib/season-activation.ts`) does, in order:

1. Marks the previous active season ended and this one active; clears the
   scheduled start so the sweep cannot fire twice.
2. `lockDivisionSchedules` (`web/lib/lock-schedule.ts`): draws each
   division's opponent graph with `generateSchedule` and writes one PENDING
   0-0 `Match` row per pairing. Sets `Season.scheduleLocked`. Re-running never
   touches a row that already exists. This step sends no messages.
3. Unless `division_channels_disabled` is set, enqueues the Discord bootstrap
   (`season-discord-bootstrap.ts`): a season category, one channel and one
   role per division, and a "League Player - {season}" role. With channels
   disabled it posts the start announcement immediately instead.

When the last division's bootstrap job finishes, the bot
(`announceSeasonStartIfComplete` in `src/queue.ts`) claims
`startAnnouncedAt`, DMs every player their division and opponent list read
from the Match rows (`queueSeasonOnboardingDms`), pins the division welcome
in each channel, and posts to the announcements channel: "{season} is live!
Your matchups are in your DMs; if you need a reminder, click Who do I play?
under the quick actions in your division channel. Good luck."

So "matchups are DM'd" is true, but it is the bootstrap completion that sends
them, not the schedule lock.

## 4. During the season

Season tools, "During the season":

- Step 5 "Resolve": link to `/admin/matches?status=pending`.
- Step 6 "Standings preview": `/admin/standings-preview` (best-N preview,
  tiebreak switch, shootout clean-up).
- Step 7 "Play times": `/admin/play-times`.

Background work the bot does on its own: the match sweep every 60 seconds,
the standings channel refresh every 15 minutes, the shootout check whenever a
division completes all its matches (`src/shootout.ts`), the "still playing?"
roster check-in when an admin enqueues it, and the auto-open tick above.
Details in [matches-and-results.md](matches-and-results.md) and
[messages-and-dms.md](messages-and-dms.md).

## 5. Ending a season

Season tools, "End of season": step 8 "Season audit", step 9 "Winners", step
10 "End season". Then "After": step 11 "Hall of Fame", step 12 "Roles".

### Winners first

`/admin/seasons/{id}/winners` records each division's champion
(`Division.championPlayerId`). Champion Discord roles are a separate action,
"Award champion roles", on the public season page `/seasons/{id}`
(`awardSeasonChampionRoles` in `web/app/admin/seasons/bootstrap-actions.ts`).

### End season

`/admin/seasons/{id}/end` shows every division's old rank, new rank and
movement, warns about unplayed matches, and lists the three effects. The
button is "End season + apply ratings" with the confirm "End this season and
apply new ratings to every player? This rewrites all ratings and can't be
cleanly undone."

`endSeasonCore` (`web/lib/end-season.ts`) then:

1. Returns `already-ended` and does nothing if the season has an `endedAt`.
2. Loads standings through `loadDivisionStandingsFresh`, the same engine the
   public standings use, forced to recompute. Season 8 ranked from match rows
   alone, re-broke shootout ties alphabetically and told the wrong players
   they moved; the forced fresh read is the fix.
3. `computeRatingDeltas`: ranks everyone by tier, division and finish, then
   swaps the top `promoteCount` of each lower division with the bottom
   `relegateCount` of the division above. Produces a strict 1..N rating used
   to seed next season and a display rank that allows ties. Dropped players
   keep their old rating.
4. In one transaction writes `Player.rating`,
   `DivisionMember.finalGlobalRank`, and `Season.isActive=false, endedAt=now`.
5. `teardownSeasonDiscord`: deletes every division channel and role and the
   season category. Champion roles are kept. The shared League Player role is
   removed from members but not deleted. Failure here does not roll back the
   ratings.
6. Writes a `season.end` audit row and refreshes `#league-info`.
7. DMs every promoted or relegated player, plus the winner of the top
   division ("You won {division}!"), with a note that next season's divisions
   may be redrawn.

The same core backs `POST /api/admin/end-season` (bearer `ADMIN_TOKEN`).

End season does not build or open the next season. The auto-open tick and
the build steps above do that.

## Season tools page, in full

| Step | Heading | Links or buttons |
|---|---|---|
| 1 | Open signups | "Signups" (chip: round status, count) |
| 2 | Review signups | "Review" |
| 3 | Build divisions | "Preview", "Build", "View divisions" |
| 4 | Activate | "Seasons" (chip: active season) |
| - | New players | "Preview: DM the guide to me", "Send to all N new players" |
| 5 | Resolve | "Matches" |
| 6 | Standings preview | "Standings preview" |
| 7 | Play times | "Play times" |
| 8 | Season audit | `/admin/season-audit` |
| 9 | Winners | `/admin/seasons/{id}/winners` |
| 10 | End season | `/admin/seasons/{id}/end` |
| 11 | Hall of Fame | `/hall-of-fame` |
| 12 | Roles | `/admin/roles` |

## Things to know that are not obvious

- Promotion and relegation counts are frozen at build time. Changing
  `placement_rules` mid-season does not change what end-season will do.
- Two default sets exist: `placement-rules.ts` says `baseSwap` 2, while
  `buildOwenPlacement` in `owen-placement.ts` defaults to 1 when called with
  nothing. Production passes the config value, so the 2 wins today.
- The fallback "N days after start" for auto-open is a trap for a season
  without a planned end date.
