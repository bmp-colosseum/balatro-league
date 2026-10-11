# Admin guide

Task by task, as clicks on the current admin UI. Labels are quoted as
rendered, minus leading emoji. Admin pages require the ADMIN tier or above
(`web/lib/admin.ts`); the HELPER tier exists but is redirected away from every
admin page today.

Navigation (`web/lib/nav-links.ts`):

- "Inbox" = `/admin`, the dashboard with active-season counts.
- "Matches" dropdown: Matches, Divisions, Data Audit, Participation, At Stake.
- "Messages" = `/admin/messages`, with tabs including Inbox (player DMs),
  Sent, Failed, Transcripts.
- "Season tools" = `/admin/season-tools`.
- "Settings" dropdown: Settings (devops only), Config, Traits, Deck Bans,
  Avoided Pairs, Bans, Players, MMR.
- "System" dropdown: Activity, Play Times, Ops (devops only), Host, Role
  audit, Action log, Season Audit.

Division admin tools are on the public division page `/divisions/{id}` under
"Admin tools", visible to admins only. Roster tools are on `/seasons/{id}`
under "Roster tools". Neither is in the nav.

## Drop a player

1. Open `/divisions/{id}` and scroll to "Admin tools", Members table.
2. On the player's row press "Drop and refill" (opponents get replacement
   matches) or "Drop, no new matches" (opponents end one match short).
3. Confirm the dialog.
4. Result: unplayed matches against them are removed, played ones stand,
   affected players are DM'd, standings recompute. Their Discord role is not
   removed; do that by hand in Discord if needed.

The same two buttons exist on `/profile/{id}`. Details in
[scheduling-and-roster-changes.md](scheduling-and-roster-changes.md).

## Add a player mid-season

1. `/divisions/{id}`, "Admin tools", card "Add player by Discord ID".
2. Enter the Discord ID (optional display name) and press "Add to division".
3. The division is patched or redrawn (only redrawn if nothing has been
   played and the slate would be uneven). Affected players are DM'd.

To replace a departing player one-for-one before any result exists, use
"Replace" (same page or `/seasons/{id}`) and enter the newcomer's Discord ID;
the newcomer inherits the schedule and is DM'd it.

## Reinstate a dropped player

1. `/profile/{id}`, press "Reinstate".
2. The player becomes ACTIVE and the schedule is re-synced so they get
   matches. Avoid "Reactivate" on the division page; it skips the re-sync.

## Fix a result

1. `/admin/matches`, filter by division or search a name.
2. On the match row pick the correct result in the dropdown and press "Set".
3. To remove a result entirely press "Undo" and confirm ("Standings fall back
   to the next tiebreaker."). There is no undo of Undo.
4. For a disputed match, read "Recorded" vs "Disputer says", then "Accept
   proposed", "Keep original", or enter a result and "Apply".

A forfeit or void for one player: `/divisions/{id}`, "Admin tools", "DQ
(forfeit)" gives their opponents 2-0 and keeps the player active; "Void
player" cancels all their games and drops them. Many at once: Matches page,
"Select all shown", pick Void or a forfeit, "Preview", "Apply to N
match(es)".

## Resolve a tie

Check the season's tiebreak mode first (`/admin/standings-preview`, the
`tiebreak` control). Rules in [standings-and-tiebreaks.md](standings-and-tiebreaks.md).

- Lives mode: most ties resolve themselves. A two-way tie on a promotion or
  relegation line with no separating lives can be settled by a shootout; the
  bot DMs both players when the division completes. To record one by hand:
  `/divisions/{id}`, "Admin tools", "Shootouts", pick the two players and
  the winner, "Record shootout".
- Chain mode: `/divisions/{id}`, "Admin tools", "Resolve a tie (any size)",
  type a placement number per tied player (1 = winner), press "Resolve
  tie". Under lives this form is replaced by a note pointing to the
  standings preview.
- After switching a season to lives, run "Shootout clean-up" on
  `/admin/standings-preview` to delete admin-recorded showdowns that lives
  now decides the same way.

## End a season

1. `/admin/season-tools`, step 8 "Season audit": clear every finding
   (open matches, unresolved ties, missing champions).
2. Step 9 "Winners": set each division's champion on
   `/admin/seasons/{id}/winners`. Award champion roles from `/seasons/{id}`,
   "Award champion roles".
3. Step 10 "End season": review the movement preview on
   `/admin/seasons/{id}/end`, press "End season + apply ratings", confirm.
4. Afterwards: step 11 "Hall of Fame" to check the page, step 12 "Roles" for
   the role audit.

Effects and order in [season-lifecycle.md](season-lifecycle.md#5-ending-a-season).
Division channels and roles are deleted by this step.

## Open and close signups

- Open: `/admin/seasons`, season card, "Open signups for this season", then
  "Open signups". Or let the auto-open tick do it N days before the planned
  end (`signups_auto_open_days`, default 7).
- Close: same card, "Close signups". "Reopen" reverses. Nothing closes
  signups on its own.

## Build and start a season

1. Season tools step 3: "Preview", then "Build", then "Set up the season -
   place N players".
2. Check the divisions on `/admin/divisions`; adjust opponents per player or
   promote/relegate counts there if needed.
3. Step 4: `/admin/seasons`, "Start season". This locks schedules, creates
   channels and roles, and once bootstrap finishes DMs every player their
   matchups and posts the start announcement.

## Send the welcome guide

1. `/admin/season-tools`, "New players" card.
2. "Preview: DM the guide to me" to read the three DMs yourself.
3. "Send to all N new players", confirm. Players already sent it are skipped.

## Reply to a player's DM

1. `/admin/messages`, Inbox tab. Unread count shows on the nav badge.
2. Expand the conversation, type in the reply box, press Send. The reply
   quotes their latest unanswered message and marks the backlog replied.
3. "Mark all read", "Archive" and "Unarchive" per conversation. "New DM"
   sends an ad-hoc message from the bot.

## Change a setting

Two places:

- `/admin/config` (any admin): key-value `LeagueConfig` rows grouped as
  Categories, Channels and external, Mode (`signups_only_mode`,
  `division_channels_disabled`), Season (`season_length_days` default 14,
  `signups_auto_open_days` default 7), Community channels, Public/join, BMP
  (`bmp_current_season`, `dm_panels_enabled`, `tiebreak_buffer_days` default
  2). "Save" per row; "clear" asks "Clear this config value?". Role bindings
  (Discord role to tier) are at the bottom, owner only.
- `/admin/settings` (owner or devops): rules templates with
  `matchInviteExpiryMinutes` (5), `reportAutoConfirmSeconds` (120) and
  `firstPickMode` (LOSER_CHOOSES or ALTERNATE). "Save changes".

Both apply live. The bot caches settings for 30 seconds
(`web/lib/league-settings.ts`, `TTL_MS`). No restart.

Scoring points and the ban/pick counts are constants in code, not settings.

## Refresh the bot's posts

From Discord as an admin: `/league refresh-messages` re-renders the pinned
posts (`#league-info`, queue, "Start a match", challenges how-to, bot status,
quick-roll bar, division welcomes). See [messages-and-dms.md](messages-and-dms.md).

## Things to know that are not obvious

- "Inbox" in the nav is the dashboard. Player DMs are the Inbox tab inside
  Messages.
- The "Players" link under Settings points at `/admin/players`, which has no
  page and returns 404. Roster tools are on `/seasons/{id}`.
- "Remove" on the division page hard-deletes a membership and all its
  matches with no confirm dialog.
