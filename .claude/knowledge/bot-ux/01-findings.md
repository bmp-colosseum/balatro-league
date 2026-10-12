---
date: 2026-10-12
sources:
  - docs/handbook/messages-and-dms.md
  - src/queue.ts (renderDivisionWelcome, announceSeasonStartIfComplete, queueSeasonOnboardingDms, notify.schedule-change worker)
  - src/dm-panel.ts, src/onboarding-guide.ts, src/league-info-content.ts
  - src/division-controls.ts, src/sticky-actions.ts, src/league-matches-message.ts
  - src/match-render.ts, src/commands/match-buttons.ts, src/league-match-invite.ts, src/commands/league-matches-buttons.ts
  - src/report-flow.ts, src/announce.ts, src/result-message-core.ts, src/commands/report.ts, src/report-problem-core.ts
  - src/schedule-change-text.ts, src/checkin-message.ts, src/match-sweep.ts, src/shootout.ts
  - src/commands/support.ts, src/commands/standings.ts, src/commands/status.ts, src/commands/help.ts, src/schedule-embed.ts, src/standings.ts
  - src/auto-signups.ts, src/signup/signup.ts, src/signup/signup-reminders.ts, src/commands/signup-buttons.ts, src/commands/signup-ask-buttons.ts
  - src/season-timing.ts, src/league-queue.ts, src/bans.ts, web/lib/end-season.ts
  - docs/handbook/standings-and-tiebreaks.md (the real tiebreak order)
confidence: high for wording and button labels (read from source); medium for phone line counts (estimated at ~40 characters per wrapped line, no device screenshots)
---

# Bot UX audit: every player-facing message

Read-only audit of the Discord bot's wording, judged as a brand-new player on a
phone and as a veteran. No code was changed. Emoji in the renderings below are
written as [name] because this file is ASCII only.

Organiser rules checked against: buttons not slash commands unless no button
exists; plain language; the lives tiebreak rule; results count straight away
with a Report a problem button; nobody plays an extra match after a dropout.

## The real buttons (so every instruction can be checked against them)

Division channel, DM panel and sticky (src/division-controls.ts:8-25):
`Start a match` (green) | `Who do I play?` | `My standings` | `League standings` | `Help`
second row: `Schedule with Hammertime` (link)

#league-matches post (src/league-matches-message.ts:34-37):
`Start a match` | `Start shootout`

Match thread (src/match-render.ts):
- invite: `Accept` | `Decline` (:307-310)
- choose first: `<A> bans first` | `<B> bans first` (:331-340)
- ban phase: select menu placeholder `<A>: pick N to ban`; `[dice] Random ban(s)` | `Reroll pool` / `Confirm reroll` | `Propose custom combo` (:427-466)
- pick phase: select `<B>: pick your deck`; `[dice] Random pick` (:508-534)
- playing: `<A> won` | `<B> won`; second row `Opponent DC'd` (:617-635)
- DC pending: `[check] Confirm DC` | `[play] Keep playing` (:581-590)
- lives: `1 life` | `2 lives` | `3 lives` | `4 lives` (:554-561, MAX_GAME_LIVES = 4)
- helper row on every live state: `[stop] Cancel match` / `[stop] Confirm cancel (1/2)` | `[pause] Pause` / `[pause] Pause (1/2)` (game 2+) | `[sos] Call helper` (:240-282)
- paused: `[play] Resume` / `[play] Resume (1/2)` (:708-713)
- custom combo: `Submit proposal` / `Pick deck + stake to submit` | `Cancel`; public: `Accept` | `Counter` | `Cancel` (:787-846)

Results channel post (src/announce.ts:137-142): `Report a problem`
Signup post (src/signup/signup.ts:101-112): `Sign Up` | `Withdraw`
"Are you in?" DM (src/signup/signup-reminders.ts:75-82): `[check] Sign me up` | `[x] Not this season` | `[zzz] Remind me later` | `[bell-off] Stop asking`
Roster check-in DM (src/roster-checkin.ts:44): `Still playing`
#league-queue (src/league-queue.ts:48-52): `Queue up` | `Leave queue` | `Status`
Support ticket (src/support-ticket.ts:30): `Close ticket`
Dead (no live sender): `Confirm` | `Dispute` on the pending report (src/report-flow.ts:104-115)

There is NO `Dispute` button on a match thread and NO support button anywhere.

## (a) Inventory of every player-facing message

Length = approximate wrapped lines on a phone (about 40 characters per line).
"6+" means it exceeds the six lines Discord shows before "read more" in the
notification/preview and the reader must scroll.

| # | Message | Trigger | Where | Length | Buttons | Wording lives at |
|---|---------|---------|-------|--------|---------|------------------|
| 1 | "Are you in?" ask (initial / reminder / last call) | signups open; mid-window; 36h before close | DM (previous ask deleted, fresh one posted) | ~9 | Sign me up, Not this season, Remind me later, Stop asking | src/signup/signup-reminders.ts:55-82 |
| 2 | Ask button replies (5 variants) | pressing an ask button | DM (edit in place) | 1-3 | none, or Sign Up pointer | src/commands/signup-ask-buttons.ts:50-116 |
| 3 | Signup post (embed) | auto-open / Open signups | signups channel | ~8 | Sign Up, Withdraw | src/signup/signup.ts:46-113 |
| 4 | Signup button replies (signed up, withdrew, closed, already) | Sign Up / Withdraw | ephemeral | 1-2 | none | src/commands/signup-buttons.ts:70-161 |
| 5 | Season-start announcement (two variants, different wording) | all divisions bootstrapped; scheduled auto-start | #league-announcements | 3-4 | none | src/queue.ts:1384; src/match-sweep.ts:463 |
| 6 | DM panel (also THE season-start DM when panels are on) | season start, then edited hourly | DM (edit in place) | 12-20 (6+) | the 5 controls + Hammertime | src/dm-panel.ts:139-173 |
| 7 | Season-start fallback DM (panels off) | season start | DM | ~10 (6+) | none | src/queue.ts:1440-1452 |
| 8 | Welcome guide, 3 DMs (new players; admin-triggered) | Season tools "Send to all" | DM x3 | ~22 / ~14 / ~26 (all 6+) | none | src/onboarding-guide.ts:60-176 |
| 9 | Division welcome (pinned, pings @division) | bootstrap, refresh-welcome, re-ping, regenerate | division channel | ~35 (6+) | the 5 controls + Hammertime | src/queue.ts:1048-1135 |
| 10 | Quick actions sticky | gated tick | division channel | 3-5 | the 5 controls + Hammertime | src/sticky-actions.ts:149-155 |
| 11 | #league-info pinned | bootstrap, signups, season start/end | #league-info | ~45 (6+) | none | src/league-info-content.ts:19-35, 79-165 |
| 12 | "Start a League Match" pinned | bootstrap, refresh, health banner | #league-matches | ~10 (6+) | Start a match, Start shootout | src/league-matches-message.ts:23-39 |
| 13 | #league-queue pinned + "opponent joined the queue" DM | join/leave; opt-in | #league-queue; DM | ~9; ~4 | Queue up, Leave queue, Status; Queue up | src/league-queue.ts:38-53, 403-406 |
| 14 | Opponent picker | Start a match pressed | ephemeral | 2 + dropdown | select "Pick who you want to play" | src/commands/league-matches-buttons.ts:98-111 |
| 15 | "Match invite sent to X" | opponent chosen | ephemeral | 3 | none (link) | src/commands/league-matches-buttons.ts:164-166 |
| 16 | Invite gate errors (banned, already played, not on schedule, in progress, no preset) | opponent chosen | ephemeral | 1-2 | none | src/league-match-invite.ts:75-138 |
| 17 | Match invite ping + embed | invite created | private thread | 1 + ~11 (6+) | Accept, Decline, Call helper | src/match-render.ts:128, 288-312 |
| 18 | "Match started" pointer | accept, when the invite was in a channel | original invite message | 2 | none | src/commands/match-buttons.ts:1053-1057 |
| 19 | Game N ban embed + turn ping | ban phase | thread | 1 + ~12 (6+) | select, Random ban(s), Reroll pool, Propose custom combo, Cancel match, (Pause), Call helper | src/match-render.ts:175, 395-471 |
| 20 | Game N choose-first embed + ping | game 2+ start | thread | 1 + ~7 (6+) | A bans first, B bans first + helper row | src/match-render.ts:147-150, 314-342 |
| 21 | Pick embed + ping | bans done | thread | 1 + ~9 (6+) | select, Random pick + helper row | src/match-render.ts:183, 473-542 |
| 22 | Playing / vote embed + pings (go play, one voted, disputed) | deck picked | thread | 1 + 3-6 | A won, B won, Opponent DC'd + helper row | src/match-render.ts:200-213, 565-637 |
| 23 | DC pending embed + ping | Opponent DC'd pressed | thread | 1 + ~7 (6+) | Confirm DC, Keep playing + helper row | src/match-render.ts:125, 570-592 |
| 24 | Lives embed + ping | both votes agree | thread | 1 + 4 | 1 life ... 4 lives + helper row | src/match-render.ts:194, 544-563 |
| 25 | Custom combo builder (ephemeral) + public proposal | Propose custom combo | ephemeral; thread | ~8; ~6 | deck/stake selects, Submit, Cancel; Accept, Counter, Cancel | src/match-render.ts:732-849 |
| 26 | Pause / cancel / reroll vote pings and replies | votes | thread + ephemeral | 1-2 | Pause (1/2), Confirm cancel (1/2), Confirm reroll | src/match-render.ts:112-119, 170; src/commands/match-buttons.ts:1497-1567, 2152-2187 |
| 27 | Paused embed + auto-pause notice | both pause, or 3h idle | thread | ~6; ~5 | Resume | src/match-render.ts:691-715; src/match-sweep.ts:147-152 |
| 28 | Match cancelled embed | cancel vote / timeout | thread | 2 | none | src/match-render.ts:682-689 |
| 29 | Match complete embed + "thread closes in a minute" | game 2 lives recorded | thread | ~8 (6+) + 1 | none | src/match-render.ts:648-680; src/commands/match-buttons.ts:839 |
| 30 | Call helper modal + summon post | Call helper pressed | modal; thread | 1 field; 2 | n/a | src/commands/match-buttons.ts:1407-1417; src/commands/helper.ts:69 |
| 31 | ~80 ephemeral guard replies ("It's not your turn", "Game state missing", ...) | wrong click | ephemeral | 1 | none | src/commands/match-buttons.ts:335-2249 |
| 32 | Confirmed result post | match CONFIRMED | results channel (or webhook, no button) | 4-7 (6+ with 2 games) | Report a problem | src/result-message-core.ts:58-119; src/announce.ts:106-142 |
| 33 | /report reply | /report | ephemeral | 2 | none | src/commands/report.ts:102-104 |
| 34 | Report a problem modal, ticket opened reply, ticket embed, recording notice | Report a problem pressed | modal; ephemeral; private thread | 1 field; 1; ~5; 2 | Close ticket | src/commands/report.ts:191-198; src/commands/support.ts:134; src/support-ticket.ts:11-30; src/mod-log.ts:23-24 |
| 35 | Schedule change DM (new / changed / notice / opponent / regenerated) + schedule embed | drop, add, replace, regenerate | DM | 3-6 + embed | none | src/queue.ts:376-386; src/schedule-change-text.ts:21-56 |
| 36 | Roster check-in | admin enqueue | DM | ~10 (6+) | Still playing | src/checkin-message.ts:20-44 |
| 37 | One-week-left reminder | N days before end | #league-announcements (pings @League Player) | ~4 | none | src/auto-signups.ts:194-196 |
| 38 | Shootout owed DM + division ping | division complete, 2-way tie on a line | DM; division channel | ~5; ~5 | none | src/shootout.ts:128-150 |
| 39 | Shootout picker and "no shootout" reply | Start shootout | ephemeral | 2-4 | select | src/commands/league-matches-buttons.ts:76-92, 215-217 |
| 40 | Season-end DMs (champion / promoted / relegated) | End season | DM | 2-4 | none | web/lib/end-season.ts:418-437 |
| 41 | "Who do I play?" schedule embed | button | ephemeral | ~10-15 (6+) | none | src/schedule-embed.ts:100-121 |
| 42 | "My standings" status embed | button or /status | ephemeral | ~8 (6+) | none | src/commands/status.ts:152-162 |
| 43 | "League standings" code-block table (+ own schedule embed) | button or /standings | ephemeral | 1 line per player, 45 chars wide | none | src/standings.ts:527-545; src/commands/standings.ts:127-129 |
| 44 | Help embed (list of slash commands) | Help button or /help | ephemeral | ~12 (6+) | none | src/commands/help.ts:16-50 |
| 45 | Live standings | every 15 min | #league-standings | one embed per division | none | src/standings-channel-content.ts:39-62 |
| 46 | Casual challenge result | /challenge series ends | #challenges | ~6 | none | src/announce.ts:209-243 |
| 47 | Challenges how-to | bootstrap | #challenges | ~20 (6+) | none | src/challenge-info-content.ts:8-25 |
| 48 | Banned reply | any gated action | ephemeral | 2 | none | src/bans.ts:13-14 |

Not player-facing (skipped): bot status embed, degraded/recovered alerts in
#league-devops (the #league-matches banner and in-thread health notices are
player-facing but transient), queue stall, staff replies, ad-hoc staff DMs.

### DMs a player receives in one season

Returning player, DM panels on, no roster change:

| When | DM | Count |
|------|----|-------|
| signups open | "Are you in?" ask, then up to 2 reminders (each deletes the previous, so one live message) | 1 (up to 3 notifications) |
| season start | DM panel (then silent hourly edits) | 1 |
| during | schedule change (only on a drop/replace in your division) | 0-n |
| during | queue "opponent joined" nudge (opt-in only, cooldown) | 0-n |
| during | roster check-in (admin-triggered, inactive players only) | 0-1 |
| division done | shootout owed | 0-1 |
| season end | champion / promoted / relegated | 0-1 (mid-table gets nothing) |

A brand-new player also gets the 3-DM welcome guide when staff press "Send to
all", so a newcomer's first week is 1 ask + 3 guide + 1 panel = 5 DMs, three of
them long paragraphs. Match turn pings are in the thread, not DMs.

Merge / redundancy verdicts:
- Guide (3 DMs) + panel (1 DM) + welcome (pinned) + #league-info all restate
  the same rules (format, lives, ties, Hammertime). One home for the rules
  (the public /how-it-works page, already built from the same sections) plus
  a one-DM guide that links to it would cut the newcomer to 3 DMs. Needs a
  decision.
- Panel vs fallback season-start DM are already exclusive (good).
- The season-end DM and the panel overlap: the panel is never finalised (see
  finding 10), so the only closure a mid-table player gets is nothing.
- Ask reminders are already de-duplicated (delete + repost). Keep.

## (b) Ten headline findings

1. **The Help button teaches slash commands.** `Help` (one of the five
   controls the organiser chose instead of slash commands) opens "League
   commands": eight `/commands` including `/start-match`, `/schedule` and
   `/standings`, all of which have a button. A new player who presses Help
   is told to type. src/commands/help.ts:16-50, used by
   src/commands/division-controls-buttons.ts:20.

2. **Ties are described three different ways, and none matches the default
   code path.** Division welcome and #league-info: "shootout, otherwise net
   lives". Welcome guide: "shootout, else the 2-0 head-to-head, else the lives
   from that match, else total net lives". The code (src/standings.ts:223-260,
   docs/handbook/standings-and-tiebreaks.md:50-69) has two modes: `chain`
   (default: points, head-to-head, recorded shootout, wins, draws; net lives
   never used) and `lives` (shootout, 2-0 head-to-head, head-to-head lives,
   net lives). The guide describes `lives`; the welcome describes neither.
   src/queue.ts:1119, src/league-info-content.ts:30,
   src/onboarding-guide.ts:111, src/shootout.ts:109-150.

3. **Three unhappy paths end in a silent deletion.** An expired invite
   (configurable minutes, embed hardcodes "5 minutes"), a match idle for 24h,
   and a match paused for 7 days are all cancelled and the thread deleted with
   no message to either player. The inviter's only trace is an ephemeral reply
   that has since vanished. src/match-sweep.ts:75-118, 210-260, 325-366.
   The auto-pause at 3h does post a notice (src/match-sweep.ts:147-152), so the
   pattern exists.

4. **Game 1's ban screen never explains the game.** The 1-3-3 ban order and
   "whoever bans first does not pick" are only explained on the game-2
   choose-first screen (src/match-render.ts:326-329), after the newcomer has
   already banned blind in game 1. The ban screen says "**A** is banning, pick
   **1**", with a dropdown placeholder "A: pick 1 to ban" and a "Pool (8
   left)"; "pool", "combo", "reroll" and "custom combo" are all undefined
   jargon on the first screen a new player sees. src/match-render.ts:415-466.

5. **One thing, four names.** The two-game pairing is a "match" (invite,
   results, schedule embed), a "matchup" (welcome, DM panel, #league-info,
   schedule-change text) and a "set" in code comments; a single run is a
   "game" but the go-play ping says "play the match, then vote for the winner"
   while game 1 of 2 is on screen (src/match-render.ts:213). Player docs
   (docs/player/faq.md:27) call the tiebreak a "showdown"; every bot message
   says "shootout"; admin.ts and audit summaries say "showdown". The ban/pick
   phase is "pick/ban" in the welcome, guide and #league-info but the flow is
   ban then pick.

6. **The result path contradicts itself.** The match-complete embed says "If
   something looks wrong, ask an admin to override" (src/match-render.ts:658);
   the results post has `Report a problem` (the organiser's rule); the /report
   reply says "press Report a problem on that post (or run /support)"
   (src/commands/report.ts:103). The DC flow tells the opponent to "Confirm or
   **Dispute**" (src/commands/match-buttons.ts:1613, 1620) but the buttons are
   `Confirm DC` and `Keep playing`. The disputed-vote embed says "ask an admin
   to step in" while its ping says "use Call helper" (src/match-render.ts:607
   vs :200).

7. **Plural bugs.** The results post prints "(1 lives left)" because
   confirmedGameLine never singularises (src/result-message-core.ts:94;
   renderComplete at src/match-render.ts:672 gets it right). The welcome says
   "You play **1 other people**" when the schedule gives one opponent
   (src/queue.ts:1072). Turn ping "ban 1 combo(s)" (src/match-render.ts:175).
   Status card "(top 1 promote, bottom 1 relegate)" (src/commands/status.ts:64-66).

8. **Internal IDs on every screen.** Every match embed footer is "Match
   cmg3k7x2q000..." (26-char cuid), every result post ends "-# Match <cuid>",
   the signup embed footer is "Round <cuid>". On a phone the cuid is the
   longest line in the message. Support tickets already use the last 6 chars
   (src/commands/support.ts:95); nothing else does. src/match-render.ts:306,
   378, 663, 687, 707; src/result-message-core.ts:109; src/signup/signup.ts:91.

9. **Six words for the people who help.** "ask an admin" (match complete,
   disputed vote, invite gate), "a mod" (DC embed, via `/helper`), "a
   moderator" (shootout DC, banned reply), "a helper" (Call helper button,
   /report reply, signup closed), "staff" (ticket notice), and "DM **Chrono**"
   (guide). The button is `Call helper`; everything else should say helper.

10. **Length and staleness on a phone.** The division welcome is ~35 wrapped
    lines before the buttons and repeats #league-info (~45 lines) and the
    guide. The match invite embed repeats the welcome's two rules bullets
    (src/match-render.ts:294-296) so the newcomer reads "the winner records
    their leftover lives" four times before game 1. The DM panel opens with a
    bold title, a sentence, then an H2 "Finish all your games by..." that
    renders huge on mobile (src/dm-panel.ts:140-143, src/season-timing.ts:45),
    and because refreshAllDmPanels returns early with no active season
    (src/dm-panel.ts:322-323) the panel freezes after season end showing
    "Finish all your games by <date> (3 days ago)" and a stale matchups list
    forever. Two different "season is live" announcements exist
    (src/queue.ts:1384 and src/match-sweep.ts:463).

Smaller notes, not headline:
- Emoji: two different card emoji ([joker] and [flower-cards]) stand for "the
  league"; some button labels embed emoji in the text ("[stop] Cancel match",
  "[sos] Call helper", "[dice] Random ban") while the ask buttons use
  setEmoji; every turn ping opens with a different emoji. Allowed by the copy
  rules, but a one-emoji-per-message, none-in-labels policy would read calmer.
- "sign-ups" / "signups" / "Sign Up" / "Sign me up" all appear.
- "facilitates the pick/ban phase" (welcome, #league-info, fallback DM) vs
  "runs" (guide). Use "runs".
- Schedule-change "if you had a time arranged it no longer counts" reads as if
  the time was a result (src/schedule-change-text.ts:40).
- "Who do I play?" still has "Awaiting your confirmation", "Waiting on
  opponent" and "Disputed" sections (src/schedule-embed.ts:105-108) and
  standings has "awaiting confirm" (src/commands/standings.ts:116); those
  states cannot occur any more (no pending stage). src/report-flow.ts and
  src/dispute-thread.ts have no live caller (grep: enqueueReportPostPending is
  defined in src/queue.ts:898 and web/lib/queue.ts:125 and called nowhere).
- The invite embed hardcodes "accept within 5 minutes"
  (src/match-render.ts:303) while the expiry is a setting
  (src/league-match-invite.ts:161, matchInviteExpiryMinutes).
- The `League standings` table is a 45-character code block; a phone shows
  about 35 monospace characters, so it scrolls sideways.
- "Start a match" on the DM panel: the handler resolves the guild from the
  interaction (src/commands/league-matches-buttons.ts:69); verify it works
  when pressed inside a DM before relying on the panel as the main entry.
- Dropouts: the "changed" DM under best-N scoring says the replacement match
  is optional and nobody is marked down (src/schedule-change-text.ts:46-50),
  which honours "nobody plays an extra match after a dropout". Without best-N
  it says "You now play X instead", which is a replacement, not an extra.
  Fine, but the "regenerated" variant ("the division's schedule was rebuilt,
  so your opponents changed", src/queue.ts:386) gives no reason and no count.

### Start a match, step by step, as a newcomer sees it

1. Press `Start a match`. Ephemeral: "**Who do you want to play?** Pick an
   opponent and I'll send them an invite to accept." + dropdown. Clear.
2. Pick a name. Ephemeral: "Match invite sent to **Bob** - it's in a private
   thread and they need to accept. Expires in 5 min if not accepted." + link.
   Clear. Unclear: what happens if Bob is offline (answer: thread silently
   deleted, see finding 3).
3. Thread opens. Ping: "@Bob (@bob) [cards] match invite from @Alice (@alice)
   - accept or decline." Embed "Match invite": "Alice wants to play Bob.
   League match (2 games) - counts toward standings. [clipboard] You'll be
   walked through **2 games**: each game draws a **fresh pool**... the
   **winner records their leftover lives**... Bob, accept within 5 minutes to
   start." Buttons `Accept` `Decline`. Clear but long; "pool" undefined.
4. Game 1 ban. Ping "@Alice [target] your turn - ban 1 combo(s)." Embed
   "[cards] Game 1 - League / [target] **Alice** is banning - pick **1**. /
   **Pool (8 left):** 1. Red Deck / White ... 8. ..." Dropdown "Alice: pick 1
   to ban", buttons `Random ban` `Reroll pool` `Propose custom combo`, row
   `Cancel match` `Call helper`. NOT self-explanatory: nothing says there are
   three ban rounds (1, 3, 3), that Bob picks at the end, or what "combo",
   "pool", "reroll", "custom combo" mean. "pick 1 to ban" uses "pick" for the
   wrong action.
5. Bob bans 3, Alice bans 3 (same screen, counts change). Fine once step 4 is
   understood.
6. Pick. Ping "@Bob [target] your turn - pick the deck/stake." Embed "Bans
   done. **Bob** picks the deck for this game from the 2 remaining." + both
   options with deck and stake descriptions. Dropdown, `Random pick`. Clear.
7. Playing. Ping "@Alice @Bob [cards] play the match, then vote for the
   winner." Embed "[deck] Playing: **Red Deck / White stake** / Both players
   vote: click who won. Match advances when you agree." Buttons `Alice won`
   `Bob won`, `Opponent DC'd`. Mostly clear; "play the match" should be "play
   game 1"; nothing says how or where to actually play (lobby, who hosts).
8. Lives. Ping "@Alice [trophy] you won the game - record your remaining
   lives to wrap it up." Embed "**Alice** won game 1! **Alice** - how many
   lives did you have left? (For the standings tiebreaker. Only you can set
   this.)" Buttons `1 life` ... `4 lives`. Clear. Good.
9. Game 2 choose-first. Ping "@Bob [target] you lost game 1 - pick who bans
   first in game 2." Embed explains the 1-3-3 order and that first-banner
   does not pick. Buttons `Alice bans first` `Bob bans first`. Clear, but
   this explanation belongs in step 4.
10. Repeat 4-8 for game 2.
11. Complete. Embed "[check] Match complete / [trophy] Alice 2-0 Bob / Result
    recorded. If something looks wrong, ask an admin to override. / Games:
    Game 1: ... - **Alice** (3 lives left)". Then "**Match complete!** This
    thread will close in about a minute." Then the results post appears in
    the results channel with `Report a problem`. The thread (and its
    breakdown) is gone a minute later; the player is never told where the
    result went. Contradiction in finding 6.

Verdict: steps 1-3, 6, 8 and 9 are good. Step 4 is the one screen that needs
a sentence of orientation; steps 7 and 11 need their pointers fixed.

### Every player-facing slash-command mention

| File:line | Text | Button that exists |
|-----------|------|--------------------|
| src/commands/help.ts:16-25 | /standings, /profile, /schedule, /start-match, /challenge, /helper, /pool, /random | League standings, (none), Who do I play?, Start a match, (none), Call helper, (none), (none) |
| src/league-info-content.ts:28 | "`/standings` shows who is in a promotion or relegation spot" | My standings |
| src/commands/status.ts:95 | "Once you're placed, `/schedule` shows your matches." | Who do I play? |
| src/commands/standings.ts:129 | footer "use /start-match @opponent to play" | Start a match |
| src/commands/standings.ts:283 | "_/standings division:X for the full table_" | League standings (own division) |
| src/shootout.ts:131, 150 | "or run `/start-match mode:shootout`" | Start shootout |
| src/match-render.ts:577 | "use `/helper` to get a mod" | Call helper (same message) |
| src/commands/match-buttons.ts:1620, 1655 | "use `/helper`" | Call helper |
| src/checkin-message.ts:36 | "open a ticket with `/support`" | none (acceptable) |
| src/commands/report.ts:103 | "(or run /support)" | Report a problem is on the post already |
| src/challenge-info-content.ts:9-24 | /challenge and its options | none (acceptable) |
| src/commands/match-buttons.ts:937 | "`/admin/deck-bans`" (a web admin path shown to a player) | n/a, should say "ask a helper" |

## (c) Rewrites for the worst five messages (ready to paste)

Each block is the full replacement text. Discord markdown kept; emoji written
as [name] here, put the real emoji in.

### 1. Help button / /help embed (src/commands/help.ts:42-50)

Title: `How to play`

```
Everything you need is a button at the bottom of your division channel.

**Who do I play?** shows your opponents and which matches are done.
**Start a match** picks an opponent and opens a private thread for the two of you. The bot runs the bans and picks and records the result.
**My standings** shows your rank, points and who is left to play.
**League standings** shows your whole division.
**Schedule with Hammertime** makes a time that shows correctly for everyone.

Setting up a time is on you: message your opponent in your division channel or by DM.
Something wrong mid-match? Press **Call helper** in the match thread. Wrong result? Press **Report a problem** under the result post.

Full rules: <https://balatroleague.com/how-it-works>
```

Footer: drop the "/admin-help" line (admins know).

### 2. Game 1 ban embed and turn ping (src/match-render.ts:415-419, :175)

Turn ping:

```
@Alice (@alice) [target] your turn: ban 1.
```
(or "ban 3" when `expected` is 3; never "combo(s)")

Embed description, game 1 only (games 2+ keep the short form):

```
**How this works:** each game starts with 8 deck and stake options. Alice bans 1, Bob bans 3, Alice bans 3, then **Bob picks** from the last 2. The winner of each game records their lives left.

[target] **Alice** is banning: choose **1** from the menu below.

**Options (8 left):**
1. [icons] Red Deck / White
2. ...
```

Dropdown placeholder: `Alice: choose 1 to ban`
Buttons: `Random ban` | `Reroll options` | `Propose custom combo`
(Decision for the organiser: hide `Propose custom combo` and `Reroll options`
on league matches and keep them for casual challenges.)

### 3. Match complete embed and thread notice (src/match-render.ts:656-663, src/commands/match-buttons.ts:839)

```
[check] **Match complete**
[trophy] Alice 2-0 Bob

Result recorded. It counts straight away and is posted in the results channel.
Wrong result? Press **Report a problem** under that post.

Games
1. Red Deck / White - **Alice** (3 lives left)
2. Blue Deck / Red - **Alice** (1 life left)
```

Casual tail unchanged. Footer: `Match ref A1B2C3` (last 6 of the id) or none.

Thread notice:

```
**Match complete.** The result is in the results channel. This thread closes in a minute.
```

### 4. Division welcome (src/queue.ts:1110-1134)

```
# [cards] Welcome to Rare 2
_Season 7 - Rare 2 division_

## [flag] Finish all your games by <date> (<relative>)
_Then we take 2 days to settle shootouts and tiebreaks before the next season starts around <date>._

@Rare 2

**Your division (8 players):**
1. Alice (@alice)
2. ...

**How it works**
- You play 5 other people here, 2 games each. The bot DMs you your matchups. Lost track? Press **Who do I play?** below.
- To play, press **Start a match** below and pick your opponent. The bot runs the bans and picks and records the result straight away. Wrong result? Press **Report a problem** under the result post.
- After each game the winner records how many lives they had left. Lives settle ties at the end of the season.
- At the end of the season the top 2 finishers move up a division and the bottom 2 move down.
- Setting up a time is on you. Message each opponent here or by DM, and use **Schedule with Hammertime** below so the time shows correctly for everyone. Nobody will chase you.

**Ties, standings and your schedule:** <https://balatroleague.com/divisions/...>

Good luck. [cards]
```

The tie rule line is deliberately short and points at the page; the full rule
should come from one helper keyed by Season.tiebreak (backlog B02) so the
welcome, #league-info and the guide cannot disagree. If the organiser wants
the full rule inline, use this for the `lives` mode:

```
- **Ties:** two players level on points play one extra game (a shootout). No shootout? Whoever won your match 2-0 is ahead; if it was 1-1, the player who finished that match with more lives; if still level, total net lives for the season. Three or more level: net lives only.
```

### 5. Match invite embed and the missing expiry notice (src/match-render.ts:288-312, src/match-sweep.ts:75-118)

Ping (unchanged): `@Bob (@bob) [cards] match invite from @Alice (@alice) - accept or decline.`

Embed:

```
**Match invite**
Alice wants to play Bob. League match, 2 games, counts toward standings.

Bob, press **Accept** within 10 minutes to start. (Both of you should be ready to play now.)
```

Footer: `Match ref A1B2C3`. Use the real `matchInviteExpiryMinutes` setting
instead of the hardcoded "5".

New notice when the invite expires (DM to the inviter, before the thread is
deleted; the opponent is not pinged):

```
Your match invite to **Bob** expired - they didn't accept in time. Nothing is recorded. Agree a time with them first, then press **Start a match** again.
```

New notice when an idle or paused match is cancelled (post in the thread, then
DM both players):

```
Your match **Alice vs Bob** was cancelled after 7 days with no activity. Nothing is recorded. If you still want to play it, press **Start a match** and pick each other again.
```

## (d) Ranked backlog

| id | change | files | size | impact | needs decision |
|----|--------|-------|------|--------|----------------|
| B01 | Replace the Help embed (slash list) with the button-based "How to play" above | src/commands/help.ts | S | H | no |
| B02 | One `tiesText(tiebreak)` helper used by the welcome, #league-info, guide and shootout notices; wording per mode from the handbook | new src/ties-text.ts, src/queue.ts, src/league-info-content.ts, src/onboarding-guide.ts, src/shootout.ts | M | H | yes: confirm `lives` is the live mode and the intended rule |
| B03 | Notify before deleting: expired invite -> DM inviter; idle/paused cancel -> thread post + DM both | src/match-sweep.ts | M | H | no |
| B04 | Game-1 ban orientation line, "Options" not "Pool", "choose N to ban" placeholder, no "(s)" | src/match-render.ts | S | H | no |
| B05 | Fix result pointers: complete embed -> Report a problem; DC replies say Keep playing not Dispute; drop "(or run /support)"; disputed embed says Call helper | src/match-render.ts, src/commands/match-buttons.ts, src/commands/report.ts | S | H | no |
| B06 | Plurals: "1 lives left", "1 other people", "combo(s)", "top 1 promote" | src/result-message-core.ts, src/queue.ts, src/match-render.ts, src/commands/status.ts | S | M | no |
| B07 | Remove every slash mention that has a button (table above) | src/commands/status.ts, src/commands/standings.ts, src/league-info-content.ts, src/shootout.ts, src/match-render.ts, src/commands/match-buttons.ts | S | M | no |
| B08 | "play the match" -> "play game N"; "Match advances" -> "Game N locks in" | src/match-render.ts | S | M | no |
| B09 | Shorten or hide ids: footers "Match ref ABC123", drop "Round <id>", "-# ref ABC123" on results | src/match-render.ts, src/result-message-core.ts, src/announce.ts, src/signup/signup.ts | S | M | yes: do staff search by full id? |
| B10 | One word: "helper" everywhere (banned reply, invite gates, DC embed, shootout DC, guide "Chrono") | src/bans.ts, src/league-match-invite.ts, src/match-render.ts, src/commands/match-buttons.ts, src/onboarding-guide.ts | S | M | no |
| B11 | Division welcome rewrite (above): shorter, "runs" not "facilitates", ties pointer | src/queue.ts | M | M | no |
| B12 | Welcome guide: one DM that links to /how-it-works instead of three paragraphs DMs | src/onboarding-guide.ts, src/onboarding-dm.ts, web/lib/onboarding-guide.ts (synced) | M | M | yes |
| B13 | Finalise the DM panel at season end ("Season 7 is over. You finished #4 of 8 in Rare 2.") instead of freezing a stale deadline | src/dm-panel.ts, web/lib/end-season.ts | M | M | no |
| B14 | DM panel layout: deadline as one plain line (no H2 in a DM), title "Season 7: your panel" | src/dm-panel.ts, src/season-timing.ts | S | M | no |
| B15 | Invite embed: drop the two rules bullets, use matchInviteExpiryMinutes not "5 minutes" | src/match-render.ts, src/league-match-invite.ts | S | M | no |
| B16 | Hide `Propose custom combo` and `Reroll pool` on league matches (keep for casual) | src/match-render.ts | S | M | yes |
| B17 | Standings table for phone width (drop padding, one line per player under 35 chars) | src/standings.ts | M | M | no (check with compact-phone-tables work) |
| B18 | Verify `Start a match` works from the DM panel (guild resolution inside a DM) | src/commands/league-matches-buttons.ts, src/league-match-invite.ts | S | M | no |
| B19 | Merge the two "season is live" announcements into one builder | src/queue.ts, src/match-sweep.ts | S | L | no |
| B20 | Delete the dead pending/dispute path and its leftovers (Confirm/Dispute buttons, "Awaiting your confirmation", "awaiting confirm") | src/report-flow.ts, src/dispute-thread.ts, src/commands/dispute-buttons.ts, src/result-message-core.ts, src/schedule-embed.ts, src/commands/standings.ts, src/queue.ts | M | L | yes |
| B21 | "pick/ban" -> "bans and picks"; "matchup" -> "match" in prose (keep "Who do I play?"); bot "shootout" vs docs "showdown" -> pick one | src/queue.ts, src/league-info-content.ts, src/onboarding-guide.ts, src/dm-panel.ts, docs/player/*.md | S | L | yes (shootout vs showdown) |
| B22 | Emoji policy: one leading emoji per message, one card emoji for the league, button emoji only via setEmoji | many | M | L | yes |
| B23 | Spelling: "sign up" (verb) / "signups" (noun); button stays `Sign Up` | src/signup/*.ts, src/league-info-content.ts, src/commands/signup-ask-buttons.ts | S | L | no |
| B24 | Season-end DM for mid-table players too ("you stay in Rare 2") or rely on B13 | web/lib/end-season.ts | S | L | yes |
| B25 | Schedule-change "it no longer counts" -> "you can drop that plan"; "regenerated" variant says why | src/schedule-change-text.ts, src/queue.ts | S | L | no |
| B26 | "/admin/deck-bans" in a player reply -> "ask a helper" | src/commands/match-buttons.ts:937 | S | L | no |
