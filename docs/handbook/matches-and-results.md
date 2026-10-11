# Matches and results

The guided match flow, plain reporting, what gets posted, the status model,
and the admin Matches page.

Sources: [src/commands/start-match.ts](../../src/commands/start-match.ts),
[src/match-session.ts](../../src/match-session.ts),
[src/commands/match-buttons.ts](../../src/commands/match-buttons.ts),
[src/match-render.ts](../../src/match-render.ts),
[src/match-write.ts](../../src/match-write.ts),
[src/match-sweep.ts](../../src/match-sweep.ts),
[src/announce.ts](../../src/announce.ts),
[src/report-flow.ts](../../src/report-flow.ts),
[src/result-message-core.ts](../../src/result-message-core.ts),
[src/commands/report.ts](../../src/commands/report.ts),
[src/report-auto-confirm.ts](../../src/report-auto-confirm.ts),
[src/dispute-thread.ts](../../src/dispute-thread.ts),
[web/lib/match-admin.ts](../../web/lib/match-admin.ts),
[web/app/admin/matches/page.tsx](../../web/app/admin/matches/page.tsx),
[prisma/schema.prisma](../../prisma/schema.prisma).

## Start a match (the guided flow)

- Entry: the "Start a match" button in a division channel or `#league-matches`,
  or `/start-match @opponent` from any channel. Mode is "League match (2
  games, default)" or "Shootout (1 game - for when you're tied with the
  opponent)". Both players must be ACTIVE members of the same division in the
  active season.
- The bot opens a private thread under `#league-matches` with an invite that
  has "Accept" and "Decline". The invite expires after
  `matchInviteExpiryMinutes` (default 5) and the sweep cancels it.
- Pick/ban per game (`src/match-session.ts`): a pool of 9 deck-and-stake
  combos is drawn (`src/match-pool.ts`, BMP-style caps: at most 4 per stake,
  3 per deck, at least one White stake). First player bans 1, second bans 3,
  first bans 3 more, second picks 1 of the remaining 2. The UI is a dropdown
  plus random-ban and random-pick buttons, "Reroll pool" (both must agree)
  and "Propose custom combo".
- Who bans first in game 2: the loser of game 1 presses "{name} bans first",
  unless the rules template sets `firstPickMode` to ALTERNATE, which skips the
  choice.
- Winner of a game: both players press "{name} won". The game advances only
  when the two votes agree; a disagreement marks the game disputed for an
  admin.
- Lives: after a winner is agreed the winner alone presses "1 life" to "4
  lives" ("how many lives did you have left? For the standings tiebreaker.").
  Stored as `Game.winnerLives`. Casual `/challenge` matches skip this.
- Disconnects: "Opponent DC'd", then the accused player presses "Confirm DC"
  or "Keep playing". Shootouts refuse in-flow DC reports and ask for an admin.
- Finish: the bot writes a `Match` row with `status: CONFIRMED`, format
  `LEAGUE_BO2` or `SHOOTOUT_BO1`, games won, winner, `hadDc`, plus one `Game`
  row per game (deck, stake, winner, lives, DC) and `GameDeck` rows for the
  pool and ban order. Casual matches write nothing to `Match`.
- The live thread uses classic embeds and buttons (`src/match-render.ts`),
  not Components V2.

## Reporting without the flow

- `/report @opponent result:2-0|1-1|0-2` creates a PENDING `Match` and posts
  to the results channel with "Confirm" and "Dispute" buttons
  (`src/report-flow.ts`). Only the two players may press them.
- Auto-confirm after `reportAutoConfirmSeconds` (default 120) through the
  `report.auto-confirm` job.
- Dispute opens a thread named "Dispute - {reporter} vs {opponent} - {id}"
  (`src/dispute-thread.ts`) with staff buttons "Close -- keep reported
  result", "Apply proposed result (staff)", "Set other result (staff)".
- `/report-shootout` records a one-game tiebreaker the same way.

## Result posts

- The confirmed-result announcement is the one Components V2 surface
  (`src/announce.ts`): a container with text blocks for the meta line, the
  header, the games line and the footer, a separator, and a "Dispute this
  result" button. Accent colour is the division's tier colour. Posted to the
  results channel (season override, then `results_channel_id` or webhook,
  then `RESULTS_CHANNEL_ID`). Always a new message; corrections post again,
  nothing is edited.
- The text itself is built by pure functions in `src/result-message-core.ts`:
  `buildConfirmedResultBlocks` for the announcement and
  `buildReportMessageBlocks` for the pending report, which `report-flow.ts`
  edits in place as the status moves PENDING, CONFIRMED, AUTO_CONFIRMED or
  DISPUTED.
- Site labels (`web/lib/result-labels.ts`): "{a} wins 2-0", "1-1 draw", "You
  beat {opponent} 2-0".

## Statuses

The Prisma model is `Match`; code and comments call a row a "pairing".

| Field | Values | Meaning |
|---|---|---|
| `status` (`PairingStatus`) | PENDING, CONFIRMED, DISPUTED, CANCELLED | PENDING 0-0 is an unplayed scheduled match |
| `format` | LEAGUE_BO2, SHOOTOUT_BO1 | |
| `forfeit` + `forfeitReason` | bool, text | a 2-0 awarded without play |
| dispute fields | `disputedById`, proposed games and lives, reason, thread id | |

Admin outcomes in `web/lib/match-admin.ts`:

- Forfeit (`forfeitResult`): CONFIRMED 2-0 to the named winner, `forfeit`
  true. Scores as a win.
- DQ no-show (`dqForfeitNoShow`): forfeits all of a player's unplayed matches
  to their opponents. The player stays ACTIVE and relegates on their own
  losses.
- Void game (`voidGame`): CONFIRMED 0-0. Counts as played, no points.
- Void player (`voidPlayerInDivision`): cancels all of the player's matches
  and drops them. Nobody is awarded anything.
- Undo (`undoResult`): deletes the match row outright. No guard.
- Shootouts: `recordShowdown` (one pair, allowed only for point-tied pairs
  under `lives`) and `resolveTieWithShowdowns` (a whole tie group; deletes
  earlier showdowns in that group first).
- "Uncounted" is a display flag only (`src/uncounted-core.ts`); it does not
  change the maths.

Players move a match PENDING to CONFIRMED or DISPUTED. Only admins (web, or
`isMatchAdmin` in Discord) forfeit, void, DQ, undo or override.

## Admin Matches page (`/admin/matches`)

Filters: season, division, status ("All", "Pending", "Disputed", "Unplayed",
"Recorded"), older than N days, name search, "Involves a dropped player".
Sections: Disputed, Pending, Unplayed, Recorded. The old `/admin/results`,
`/admin/disputes` and `/admin/resolve` routes redirect here.

Per match:

- Result dropdown and "Set" to record or override.
- "Undo" (red), confirm: "Remove the {A} vs {B} result? Standings fall back
  to the next tiebreaker."
- Disputed rows show recorded vs proposed with "Accept proposed", "Keep
  original", or a custom result and "Apply", each with its own confirm.
- Shootout card: "Record shootout"; undo asks "Undo this shootout?".

Bulk resolve: tick "Select all shown", choose "Void", "Forfeit for player A",
"Forfeit for player B" or "Double forfeit", add a reason, "Preview", then
"Apply to N match(es)". Disputed matches only accept Void. Bulk actions post
nothing to Discord.

DQ and void-player live on the division page's Admin tools, not here (see
[admin-guide.md](admin-guide.md)).

## The sweep

`src/match-sweep.ts` runs at boot and every 60 seconds:

1. Invites older than 5 minutes: cancel, delete thread.
2. In-progress matches idle 3 hours: auto-pause and post "this match was
   auto-paused ... hit Resume ... stay paused for up to 7 days."
3. Any non-terminal session older than 24 hours: cancel.
4. Paused more than 7 days: cancel.
5. Retry deleting leaked threads.
6. Seasons past `scheduledStartAt`: activate and post the "is now live"
   announcement.

`/admin/config` has "Run match-thread sweep now" (`web/lib/match-sweep.ts`),
which does the expired, idle and leaked-thread checks plus an optional scan
for untracked match threads. It does not auto-pause or activate seasons.

## Things to know that are not obvious

- Only the announcement is Components V2. The live thread is classic embeds.
- The guided flow has no Confirm/Dispute buttons; agreement is the two
  "won" votes, and disagreement goes to an admin, not to a dispute thread.
- Undo has no precondition and leaves no row behind.
