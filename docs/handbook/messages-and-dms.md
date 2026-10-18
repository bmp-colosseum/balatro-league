# Messages and DMs

Every DM and channel post the bot sends (or the web app sends through the
bot's queue), when, and where the wording lives. If you change a message,
change it in the file named here, and update this table.

Sources: the files in the table, plus [src/dm-delivery.ts](../../src/dm-delivery.ts)
(delivery and the `DmDelivery` log), [src/queue.ts](../../src/queue.ts) (the
pg-boss workers), and `ENSURED_CHANNELS` in
[src/commands/league.ts](../../src/commands/league.ts) for the live channel
list. `docs/arch/channel-registry.md` is a proposal, not the live list.

## Inventory

| Message | Where | When | Wording lives in |
|---|---|---|---|
| Welcome guide (3 DMs) + public `/how-it-works` page | DM, web | first season for a player; Season tools "Preview" / "Send to all"; page is always public | `buildOnboardingGuideMessages` / `buildOnboardingGuideSections`, [src/onboarding-guide.ts](../../src/onboarding-guide.ts); sender `src/onboarding-dm.ts`; page `web/app/how-it-works/page.tsx` |
| Season-start matchups DM | DM | once every division channel is bootstrapped | `queueSeasonOnboardingDms`, `src/queue.ts` |
| Season-start post | `#league-announcements` | same moment | `announceSeasonStartIfComplete`, `src/queue.ts`; channels-disabled variant in `web/lib/season-activation.ts` |
| Division welcome (pinned) | division channel | bootstrap, `/league refresh-welcome`, `/league re-ping`, after a schedule regenerate | `renderDivisionWelcome`, `src/queue.ts` |
| Quick actions (sticky) | division channel | reposted on a gated tick | `buildStickyActionsMessage`, [src/sticky-actions.ts](../../src/sticky-actions.ts); buttons from [src/division-controls.ts](../../src/division-controls.ts) |
| Schedule change: changed / notice | DM | drop, add, replace, regenerate | [src/schedule-change-text.ts](../../src/schedule-change-text.ts); roles new / opponent / regenerated in `src/queue.ts` |
| One-week-left reminder | `#league-announcements` | N days before planned end | `postWeekLeftReminder`, [src/auto-signups.ts](../../src/auto-signups.ts) |
| Signup post (buttons) | signups channel | auto-open, "Open signups", `/league post-signup` | web: `buildSignupPayload`, [web/lib/signup-discord.ts](../../web/lib/signup-discord.ts); bot: `src/signup/signup.ts` |
| "Are you in?" ask, reminder, last call | DM | round opens; scheduled ticks | `askContent`, `src/signup/signup-reminders.ts` |
| Roster check-in ("still playing?") | DM | admin enqueues `roster.checkin` | [src/checkin-message.ts](../../src/checkin-message.ts); sender `src/roster-checkin.ts` |
| Match invite | private thread under `#league-matches` | Start a match | `renderMatch`, `src/match-render.ts`; posted by `src/league-match-invite.ts` |
| Match invite expired (DM the inviter) / match cancelled (thread post + DM both players) | DM; thread | invite past `matchInviteExpiryMinutes`; idle 24h; paused 7d | `buildExpiredInviteDm` / `buildMatchCancelledNotice`, [src/match-sweep.ts](../../src/match-sweep.ts) |
| Confirmed result + Report a problem | results channel or webhook | match CONFIRMED (`/report` and the web form record CONFIRMED immediately, no pending stage) | `buildConfirmedResultBlocks`; posted by [src/announce.ts](../../src/announce.ts); button wiring `src/report-problem-core.ts` |
| Report-a-problem ticket | staff ticket (same as `/support`) | "Report a problem" pressed | `buildProblemTicketIssue`, [src/report-problem-core.ts](../../src/report-problem-core.ts); opened via `src/commands/support.ts` |
| Shootout owed | DM + division channel | division completes with a 2-way tie on a line | `runShootoutCheck`, [src/shootout.ts](../../src/shootout.ts) |
| Season-end movement DMs | DM | End season | `endSeasonCore`, [web/lib/end-season.ts](../../web/lib/end-season.ts) |
| Casual challenge result | `#challenges` | `/challenge` series ends | `announceChallengeResult`, `src/announce.ts` |
| `#league-info` (pinned) | `#league-info` | bootstrap, signups open/close, season start/end, `/league refresh-messages` | `composeLeagueInfoContent`, [src/league-info-content.ts](../../src/league-info-content.ts); worker `league-info.refresh` |
| `#league-queue` post | `#league-queue` | join/leave, refresh | `renderQueueMessage`, `src/league-queue.ts` |
| "Start a match" post | `#league-matches` | bootstrap, refresh, health banner | `renderLeagueMatchesMessage`, `src/league-matches-message.ts` |
| Challenges how-to | `#challenges` | bootstrap, refresh | `src/challenge-info-content.ts` |
| Live standings | `#league-standings` | every 15 minutes and on demand | `composeStandingsEmbeds`, `src/standings-channel-content.ts` |
| Bot status embed | `#league-bot-status` | health tick, refresh | `src/bot-status-content.ts` |
| Degraded / recovered alerts | `#league-devops`, `#league-matches` banner, open match threads | health transitions | `src/health-broadcast.ts` |
| Queue stall, missing config | `#league-devops` | detected | `postDevopsAlert`, `src/devops-alert.ts` |
| Per-player DM panel | DM (edited in place) | season-start blast, hourly tick, if `dm_panels_enabled` | `buildDmPanel`, `src/dm-panel.ts` |
| DM panel finalize ("Season N is over. You finished #R of T in Division.") | DM (edits the stored panel, or sends fresh) | season end, every active (non-dropped) member | `buildDmPanelFinal` / `finalizeDmPanelsForSeason`, `src/dm-panel.ts`; enqueued by `endSeasonCore`, `web/lib/end-season.ts` via the `dm-panel.finalize` job |
| Staff reply to a player | DM | Messages page, Inbox tab | `formatStaffReply`, [web/lib/dm-format-core.ts](../../web/lib/dm-format-core.ts); enqueued by `web/app/admin/messages/actions.ts` |
| Ad-hoc staff DM | DM | Messages page, "New DM" | `sendBotDm`, `web/app/admin/messages/actions.ts` |
| Quick-roll bar | `#bot-commands` | tick or refresh | `buildBotCommandsStickyMessage`, `src/sticky-actions.ts` |

Inbound DMs from players are recorded by `src/inbound-dm.ts` and shown on the
Messages page; the bot does not auto-reply.

## The Discord buttons (`src/division-controls.ts`)

One row under the sticky quick actions in every division channel:

- "Start a match": opens the opponent picker (handled with the
  `#league-matches` button code).
- "Who do I play?": ephemeral schedule embed (`buildScheduleEmbed`).
- "My standings": ephemeral personal status card.
- "League standings": the division table.
- "Help": static help embed.
- "Schedule with Hammertime": a link button to hammertime.cyou.

Handlers for the middle four are in `src/commands/division-controls-buttons.ts`
and run the same core as the matching slash commands.

## `/league refresh-messages`

Re-renders, in order: the `#league-queue` post, the `#league-matches` "Start
a match" post and its permissions, `#league-info` (enqueued), the challenges
how-to, the bot status embed, the `#bot-commands` quick-roll bar, and every
active division's welcome (silent edit, no ping). Related: `/league
refresh-welcome` (edit, or `ping:true` to repost; `dry-run` previews),
`/league re-ping` (repost and ping every division), `/league bootstrap-server`.

## The welcome guide

Three DMs: the league, seasons, tiers and your schedule; playing a match,
results and standings; promotion and relegation, ties, scheduling, where to
get help. Content lives as 10 structured sections (`OnboardingGuideSection`
-- a plain heading + a body that may carry a sliver of Discord markdown,
`**bold**` / `<url>`) returned by `buildOnboardingGuideSections` in
`src/onboarding-guide.ts`; `buildOnboardingGuideMessages` assembles those
same sections into the three DMs. The file is copied to
`web/lib/onboarding-guide.ts` by the sync script, so both the admin preview
DM and the public `/how-it-works` page
(`web/app/how-it-works/page.tsx`, loader `web/lib/loaders/how-it-works.ts`)
render from the one source -- the page runs each section's body through
`web/lib/discord-markdown.ts` (a tiny `**bold**`/`<url>` -> HTML converter)
instead of re-typing the copy. Season label/dates come from the active
season the same way the DM derives them; with no active season, the shared
content falls back to its own evergreen wording (same fallback the DM uses
when `seasonWindowLines` is empty) -- there's no separate "public" copy to
keep in sync.

Season tools, "New players" card:

- "Preview: DM the guide to me" sends the three DMs to the admin, every time
  (`force: true`).
- "Send to all N new players" enqueues one `notify.onboarding-guide` job per
  newcomer. The worker skips anyone with a `DmDelivery` row of kind
  `onboarding-guide` in status `sent`, so a repeat press is safe.

## Copy rules

These are the house rules the messages follow. They are not written down
anywhere else yet; this section is the source.

- Plain language. Say what happened and what to do next. One idea per
  sentence.
- Buttons, not slash commands. Tell players to press "Who do I play?" or
  "Start a match"; mention a slash command only where no button exists (the
  `#league-matches` post says "no slash commands needed" on purpose).
- Singular and plural must agree. There is no shared helper; each call site
  handles it ("they left" vs "they have left" in `schedule-change-text.ts`,
  `pluralDays` in `web/lib/season-countdown-core.ts`, `new player{s}` on the
  Season tools page). Check both forms whenever a count is interpolated.
- Promotion and relegation wording comes from the shared `up()` / `down()`
  helpers duplicated in `src/onboarding-guide.ts` and `src/queue.ts` so the
  guide and the welcome never drift.
- The ties/tiebreak rule comes from the single `tiesText(tiebreak)` helper in
  [src/ties-text.ts](../../src/ties-text.ts) (mirrored to
  `web/lib/ties-text.ts` by the sync script) -- used by the division welcome,
  `#league-info`, the welcome guide, and the shootout-owed notices, so the
  four surfaces can't describe a different tiebreak order from each other or
  from `docs/handbook/standings-and-tiebreaks.md`.
- A match/pairing id shown to a player is the short `matchRef(id)` (last 6
  characters, uppercased -- [src/match-ref.ts](../../src/match-ref.ts)), e.g.
  "Match ref A1B2C3", never the full cuid. Staff still look up the full id in
  the admin web / `/admin` tooling.
- Player names follow "Player names in posts" below.
- Discord messages may use emoji; the website may not use emoji as icons
  (`design-system/MASTER.md`).
- Every DM is logged in `DmDelivery` with a kind and status, so "did they get
  it" is answerable from the Messages page.

## Player names in posts

Every player-controlled name (display name, username, nickname) goes through
[src/name-format-core.ts](../../src/name-format-core.ts) before it enters a
string sent to Discord. Never escape by hand at a call site.

- `nameMd(name)`: message content, embed descriptions and embed field values.
  Backslash-escapes markdown characters and a leading `#`, `>`, `-` or `1.`,
  so a name cannot restyle the post.
- `namePlain(name)`: embed titles, author names, footers, field names, thread
  and channel names, select-menu labels, autocomplete choices. No backslashes,
  because those surfaces render no markdown.
- Both modes defang `@everyone`, `@here`, `<@id>`, `<@&id>` and `<#id>` by
  swapping the `@` or `#` for its fullwidth twin, so a name never reads as a
  mention.
- `joinNames` and `fitLines` keep a list under the Discord limit (description
  4096, field value 1024) and end it with "and N more".
- The bot Client defaults to `allowedMentions: { parse: [] }`: nothing pings
  unless that send passes its own `allowedMentions` naming the users or roles
  it means to ping. A per-send value replaces the default.
- Stored names stay raw. Audit summaries and logs are not Discord posts.
- `src/name-format-guard.test.ts` fails on a raw name in a template literal;
  its allowlist needs a one-word reason per entry.
