---
date: 2026-10-09
confidence: high for public pages (browsed live at 390x844 and 1280x900, logged out); medium for admin and logged-in player views (read from source, not rendered)
sources:
  - https://balatroleague.com/ (redirects to /standings)
  - https://balatroleague.com/standings
  - https://balatroleague.com/divisions/cmuyvr3mt002qnl01scisol0p (Season 9, Rare 1)
  - https://balatroleague.com/profile/cmsypgm06002no101ln58fy35 (baconisbets)
  - https://balatroleague.com/players (redirects to /auth/signin)
  - https://balatroleague.com/stats
  - https://balatroleague.com/seasons
  - https://balatroleague.com/seasons/cmt9wdsj20005pa01m787gjuh (Season 8)
  - https://balatroleague.com/hall-of-fame
  - https://balatroleague.com/traits
  - https://balatroleague.com/join
  - https://balatroleague.com/how-to-play (404 for non-admins)
  - web/lib/nav-links.ts, web/components/SiteNav.tsx, web/components/SiteMobileMenu.tsx
  - web/app/standings/page.tsx, web/app/divisions/[id]/page.tsx + actions.ts, web/components/ReportForm.tsx, web/components/DisputeForm.tsx
  - web/app/report/page.tsx, web/app/me/page.tsx, web/app/join/page.tsx + actions.ts, web/lib/loaders/join.ts, web/lib/report.ts, web/app/how-to-play/page.tsx
  - web/app/admin/**/page.tsx (all 35), web/lib/loaders/*, web/lib/end-season.ts
  - src/queue.ts (renderDivisionWelcome, queueSeasonOnboardingDms), src/dm-panel.ts, src/checkin-message.ts, src/signup/*, src/commands/signup-*.ts, src/commands/report.ts, src/report-flow.ts
screenshots: C:/Users/micha/AppData/Local/Temp/claude/C--Users-micha/74accfae-f427-461c-adb3-51832c5ea65f/scratchpad/ux/ (filenames cited inline as [shot: name])
---

# Balatro League UX audit: usability, simplification, overwhelm

## Executive summary

1. **Overwhelm #1: the standings page is a 10,000px wall.** On a phone, /standings renders all 13 divisions and 87 players as 85px cards with nothing personal on top. A returning player scrolls past ~75 strangers to find their own row. [shot: phone-standings-full.png]
2. **Overwhelm #2: the admin has 29 nav links and 35 pages for one organiser.** Four pages are called some kind of "Audit". Match fixing is split across Results, Resolve All, Disputes and the division page. Ending a season touches six unlinked pages. The dashboard has no to-do list.
3. **Overwhelm #3: per-row repetition.** Tie notes repeat the same sentence on every tied row (four times in Season 8 Rare 5). Tier names appear three times per division ("Legendary" heading, "Legendary" title, "LEGENDARY" chip). Every unplayed match card says "unplayed" under a "Still to play" heading. [shot: phone-season8-tienotes.png]
4. **Win #1: a "You" strip at the top of /standings and the profile.** It shows your division, rank, points, matches left and a "Who do I play next?" list. This one block answers 80% of returning-player visits.
5. **Win #2: collapse the admin into 3 weekly pages plus a Season Tools hub.** Make the dashboard an inbox (disputes, stale matches, unreachable DMs, ghosts). Merge Results, Resolve and Disputes into one "Matches" page. Put everything once-a-season behind "Season tools" as an ordered checklist.
6. **Win #3: fix the dead ends a new player hits.** The phone menu has no Join link unless signups are open. "Players" in the public nav bounces logged-out visitors to a sign-in page. /how-to-play returns 404. The most prominent menu item is the jargon toggle "Show BMP MMR". [shot: phone-menu-open.png]
7. **Leave alone:** /join (clear, two steps, honest copy). The Discord "Start a match" bot flow (results record themselves). The /stats leaderboards. The Card Table visual identity. The admin resolve queue's preview-then-apply step.
8. **One real bug surfaced:** the same tied players show different ranks on /standings ("2, 2, 2, 2, 2") and on the division page ("2, 3, 4, 5, 6"). [shot: phone-standings-full.png vs phone-division-full.png]
9. **One real bug surfaced:** /traits lists about 95 profile links, and Next.js prefetch fires all of them, which trips the rate limiter (16 console 429s). Any name-dump page has the same risk.
10. **Three different result-confirmation rules exist.** A web report is confirmed instantly. A /report slash command is pending with a 2-minute auto-confirm. A bot match needs both players' votes. Players can't learn one rule.

---

## Public pages

Severity: **H** means it costs players time or confuses them on every visit. **M** means noticeable friction. **L** means polish.

### Header and nav (every page). Severity H

- **What a player needs, ranked:** (1) my division, (2) standings, (3) join/sign in, (4) history. Today the nav gives six equal links: Standings, Players, Stats, Hall of Fame, Seasons, Traits.
- **Noise and dead ends:**
  - "Players" requires login and redirects to "Sign in". A visitor tapping a primary nav link should never hit a wall. Hide it when logged out, or make it public. [shot: phone-players-top.png, desk-players-signin.png]
  - "Traits" is a page of 4 cosmetic badges. It does not earn a primary slot. Move it to a link under the profile's "🎭 Traits" card and the footer.
  - "Join" is appended only when a signup round is open (SiteNav.tsx line 41). Between seasons a newcomer has no route to /join, which is exactly the page that offers "🔔 Notify me when next season opens". Always show "Join" to logged-out visitors.
  - "Show BMP MMR" is rendered as the yellow, highest-contrast item in the phone menu and as a checkbox in the ⚙️ menu on desktop. "BMP" is unexplained to players. Move it into the ⚙️ menu only, and relabel it "Show balatromp.com rating". [shot: phone-menu-open.png]
  - /how-to-play exists in source but is admin-only and returns a bare, unbranded Next.js 404 with no nav for everyone else. Ship it, or remove the "How to play (WIP)" command-palette entry. Also give the 404 page the site nav.
- **Phone:** the header packs a two-icon logo, "Menu", a search icon and "Login with Discord", so the login text sits at the right edge. The two logo glyphs carry no wordmark. Collapse "Login with Discord" into the menu, or shorten it to "Log in", and show the wordmark. [shot: phone-standings-top.png]
- **Proposed nav:** Standings · My division (logged in) or Join (logged out) · Seasons (archive plus Hall of Fame as a tab) · Stats. That's four items, which fits a phone without a menu.

### / and /standings. Severity H

- **Purpose:** the current season at a glance.
- **Player needs, ranked:**
  1. Where am I and who's next (absent for logged-in players; nothing personal on the page).
  2. My division's table.
  3. Others' divisions.
  4. Season progress.
- **Noise:**
  - Each division card repeats its tier three times: the section heading "Legendary", the card title "Legendary", and the chip "LEGENDARY". Keep only the coloured card title, and drop the chip and the H3 when a tier has one division.
  - The four tier chips ("LEGENDARY 1", "RARE 4"…) are jump links, but they look like filters. The count bubble means "divisions", which is not stated.
  - "12 / 174 matches played · 162 remaining · 7% complete" says the same thing three ways. Keep "12 of 174 played" plus the bar.
  - "round robin, play everyone" and "4 assigned opponents" on every card is setup detail. Move it to the division page.
  - Early season every row shows rank "1" and "0 PTS". With 0 matches played, show the alphabetical list without ranks and a "No matches yet" line.
  - The "KEY" disclosure explains ↑ ↓ 🔒 ⚔ and strikethrough. It does not explain the coloured squares (W/D/L form) or the "♥ -8" (net lives), which are the two marks actually visible in rows. Label them inline instead: "Form" on the pips and "lives" after the number.
- **Cuts and merges:**
  - Add a "Your division" card at the top for logged-in players, showing rank, points, "3 left: Melon, proy, ʇsnlʞ" and a "Report a result" link.
  - Make division cards collapsible on phone. Your own division opens, others show "Rare 2 · leader Birb 0 pts · 0/10 played" until tapped.
  - Replace the 85px row card with a 44px row: rank · avatar · name · W-D-L · pts. Add the W-D-L record; today a row shows points only.
- **Phone problems:**
  - Page height is 10,152px for 87 players [shot: phone-standings-full.png].
  - "0/10 MATCHES" clips against the card's right edge [shot: phone-standings-top.png].
  - Names truncate to "ezhikgoob…" and "Mangoma…" because the rank tile and the PTS tile take ~40% of the width [shot: phone-standings-rare1.png].
  - 84 tap targets measure under 32px tall.
- **Desktop:** the Legendary card spans the full 1050px for five 0-point rows, so only one division fits above the fold [shot: desk-standings-top.png]. A compact table would show 3-4 divisions per screen.
- **Bug:** tied players are ranked "2,2,2,2,2" here but "2,3,4,5,6" on the division page. Pick one rule. Shared rank is honest early in the season.

### /divisions/[id]. Severity M

- **Purpose:** one division's table and fixtures. For members, it is also where they report.
- **Player needs, ranked:**
  1. My remaining opponents.
  2. Report a result.
  3. The table.
  4. Others' fixtures.
- **Noise:**
  - The player-chip row ("hiker · JaySk8n · Melon…") directly above the standings duplicates the standings list. Cut it.
  - "unplayed" under each of 11 "Still to play" cards is redundant. Cut the word.
  - "Still to play" with 11 full-width cards comes before "Played". Once a season is half done, invert the order, or collapse "Still to play" to "11 left · show".
  - "6 players · 1 up · 1 down · 4 opponents" is fine but cryptic. Write "Top 1 moves up, bottom 1 moves down. You play 4 of the other 5." in plain words once.
- **For logged-in members (from source):** "🎯 Your matches", then "Report a match", then "Your played", then "Division matches", then a v2 overview that repeats "Your matches / Still to play / Played". That shows the same fixtures twice. Keep one list.
- **Feedback bug:** the report action redirects with "?reportOk=1" or "?reportErr=", but the page renders success and error callouts only for admins. A player who reports on this page gets no confirmation that it worked. Show "✓ Recorded: You beat Melon 2–0. Melon has been DMed."
- **Phone problems:** 1,980px tall for a 6-player division, mostly the 11 unplayed cards at 78px each [shot: phone-division-full.png]. The form pips and "♥ -8" are unlabeled and colour-only, which fails the colour-not-only rule.

### /profile/[id]. Severity M

- **Purpose:** one player's identity, current status and history.
- **Player needs, ranked:**
  1. This season: rank, record, who's left (who's left is missing).
  2. Career summary in one line.
  3. Match history.
  4. Deck and stake habits.
- **Noise:**
  - The hero card shows POINTS 0 / RECORD 0-0-0 / NET LIVES 0. Right under it, "This season" repeats "#1 of 5 · 0 pts · 0W · 0D · 0L · 0 played". Keep one.
  - "In Legendary (Legendary)" prints the tier and division names twice whenever they match.
  - Five full-width stat tiles (SEASONS 3, TOTAL POINTS 15, WINS (2-0) 4 · 57%, DRAWS (1-1) 3 · 43%, LOSSES (0-2) 0 · 0%) take 450px on phone. Make one line: "3 seasons · 15 pts · 4W 3D 0L · 79% game win rate". [shot: phone-profile-full.png]
  - "LEGENDARY X3" is ambiguous: it could mean three titles or three seasons in Legendary. Write "3× Legendary champion" or "3 seasons in Legendary".
  - The "Your deck & stake stats" disclosure says "Your" on someone else's profile, seen logged out. Write "Deck & stake stats".
  - Each of 8 match cards carries a "picks & bans" disclosure. That's fine, but the deck/stake icons plus "W/D" pill plus colour border triple-encode the result.
- **Missing:** "Still to play this season". The bot panel shows "${n} left to play: ${names}", but the web profile does not.
- **Desktop:** the hero card is a 360px-wide centred box with ~450px of empty space either side, pushing all data below the fold [shot: desk-profile-top.png]. Put the hero inline with the season summary.

### /players. Severity M

- Login-gated, yet in the public primary nav (see Header). It is unaudited beyond the redirect. The sign-in page copy is good: "Log in with Discord to view your profile, report results, and join signups."

### /stats. Severity L

- **Purpose:** league trivia. It's fine as a secondary page.
- **Noise:**
  - "Most match wins (2-0 results, all-time)" and "Most games won (game-level)" are near-duplicate top-5s with the same names. Keep one, or put them side by side as tabs.
  - The Streaks table shows five rows all at "3 ● active". When the top value is tied, show "5 players on a 3-match streak".
  - The deck and stake ban-rate bars are all red and span 67–94%, so the bars carry almost no contrast. Sort by ban rate, start the bar scale at 50%, or drop the bars and keep the numbers.
  - "Green · Green" in Most-banned combos reads as a typo, because deck and stake share the name "Green". Write "Green deck · Green stake".
- **Phone:** 3,143px, acceptable [shot: phone-stats-full.png].

### /seasons. Severity L

- **Purpose:** the archive index.
- **Missing:** the champion. Each row shows "13 divisions · 87 players · 174 matches". Replace that with "Legendary champion: estrakami".
- **Data oddity worth checking:** Season 7 and Season 8 both say "Runs Aug 26, 2026". Season 8 ends Oct 7, after Season 9 started on Sep 30. Either the dates are wrong or the labels are misleading.
- **Merge:** fold Hall of Fame into this page as a "Champions" tab. Both are "past seasons, by season". [shot: phone-seasons-full.png, desk-seasons.png]

### /seasons/[id]. Severity H on phone

- **Purpose:** the final tables of a past season.
- **Noise:**
  - Tie explanations are printed in italics on every tied row. In Rare 5 the sentence "Tied on points with … total net lives decided it (12 / 5 / 4 / 1)" appears four times, wrapping to six lines each on phone. Show one footnote per tie group under the table: "IsThisTheDagger?, PyjamaKittyy, Dacho and BreadyBoi tied on 6 pts; net lives decided it (12 / 5 / 4 / 1)." [shot: phone-season8-tienotes.png]
  - "Italic note = how a tie was broken" repeats under every division. Cut it once the footnote format exists.
  - The champion row has no trophy, even though Hall of Fame uses one.
  - The archive uses initials avatars ("ES", "JE") while live standings use Discord avatars. That inconsistency reads as a broken image.
- **Phone:** 13,412px for one season. Collapse divisions to "Rare 1 · 🏆 ezhikgoobikov · 5 players", expandable. [shot: phone-season8-top.png, desk-season8-top.png]

### /hall-of-fame. Severity M

- **Purpose:** champions by season.
- **Noise:**
  - Two H2s: "🏆 Hall of Fame" and "Hall of Fame".
  - The "x2"/"x3" badges are unexplained. They mean career titles, so write "3 titles" in a tooltip or legend.
  - On phone each champion is a half-width 100px card in a single column, leaving the right half empty. 112 titles produce a 12,814px page. [shot: phone-hof-top.png, phone-hof-full.png]
- **Fix:**
  - Put a "Most titles" leaderboard (top 5) at the top. That's the actual hall of fame.
  - Render each season as a compact two-column list on phone: "Legendary · estrakami ×3".
  - Collapse seasons older than the latest two.
- **Desktop** is fine as a grid [shot: desk-hof-top.png].

### /traits. Severity L (but a perf bug)

- **Purpose:** explain 4 cosmetic badges.
- **Noise:**
  - "50 players have it:" followed by a comma-separated dump of 50 linked names. Show a count plus 5 avatars and "+45", or nothing.
  - Typo: "as long as its on white stake" should read "it's".
  - "Dr. Spectred" renders without its icon, unlike the other three.
- **Perf bug:** loading the page triggered 16 HTTP 429 errors from prefetching the linked profiles. Set prefetch={false} on name-dump links. [shot: desk-traits.png, phone-traits-top.png]
- **Move:** take it out of the primary nav.

### /join. Severity L (leave alone)

- **Good:** two numbered steps, one button each, "No password needed", and a four-line "How it works".
- **Fixes:**
  - "You get about 2 weeks to finish" is computed. Season 9 runs Sep 30 to Oct 21, three weeks, so check the source value.
  - The banned state is only revealed after clicking "Sign me up". The loader could check for a ban and show the callout up front.
  - Discoverability: see Header. The page is unreachable from the nav between seasons.
- Screenshots: [shot: phone-join-full.png, desk-join.png]

---

## Admin: proposed information architecture

### What exists today

There are 29 links in lib/nav-links.ts: 18 in the primary row and 11 under "System ▾". The 7 sub-pages of seasons, signups and transcripts are on top of that. The dashboard shows two stat grids, six numbers and nothing actionable. Its "Set an end date" link points to /admin/seasons/{id}, which has no page.

Grouped by real frequency (from the source inventory):

| Frequency | Pages |
|---|---|
| Weekly | Dashboard, Results, Resolve All, Disputes, DMs, Participation, At Stake (late season) |
| Once a season | Seasons, Signups (+ [id], build, preview), MMR, Divisions, Standings Preview, Season end, Winners, Season Audit, Role audit |
| Rare | Avoided Pairs, Bans, Deck Bans, Seasons templates, Config, Activity, Message, Audit log, Data Audit, Transcripts, Traits |
| Never for the TO (dev-ops only) | Rules & Settings, Ops, Host, Play Times |

### Target: three weekly pages

1. **Inbox** (replaces Dashboard). It is one list of things needing a decision, each with its action inline:
   - Open disputes, with "✓ Accept proposed" and "Keep original" inline. That absorbs /admin/disputes.
   - Matches pending more than N days, linking to Matches pre-filtered.
   - Unread bot DMs and failed outbound sends, linking to Messages.
   - No-shows from Participation, with "Strike" and "Ban 1 season" inline.
   - Late season only: "What's at stake" as a collapsible summary ("3 divisions decided, 4 dead rubbers").
   - Season status line: "Season 9 · day 9 of 21 · 12/174 played · ends Oct 21". Drop "Fake players" and "Players (total)" from the main view.
   - Empty state: "Nothing needs you. 162 matches left."
2. **Matches** (merges Results, Resolve All and Disputes).
   - One table of this season's matches with filters: division, status (Pending / Disputed / Unplayed / Recorded), older than, involves dropped player.
   - Row click opens the single-match MatchActionsPanel (record, override, DQ, shootout, undo).
   - Tick boxes give the existing bulk "Choose an action… / Reason (required) / Preview / Apply to n matches".
   - Disputed rows show the disputer's proposal inline.
   - This removes three nav items and the "fix individually" hop.
3. **Messages** (merges DMs, Message and Transcripts).
   - Inbox / Sent / Failed tabs, plus a "New DM" button. Keep Transcripts as a tab on the same page.

### Season Tools hub (once a season), one nav link

It's a single page with an ordered checklist. Each step shows done / to do and links to the existing page, renamed as below:

1. **Signups.** Open, see who's in, close. This merges /admin/signups and /admin/signups/[id], and drops the "🧪 DM me a preview" button into a disclosure.
2. **Ratings.** This is /admin/mmr, renamed. Hide the "Turn OFF" / go-live / un-settle recovery controls behind "Advanced".
3. **Build divisions.** Merge signups/[id]/build and signups/[id]/preview into one page. Today both say "set up", and the TO must know that Seasons' "Set up →" goes to preview while the build page says "Set up the season". Keep the "ℹ️ How this works" 5-step list as the page's only copy.
4. **Start season.** This is the "Start season →" button.
5. **Before ending (optional).** Standings preview: dropouts, best-N, tiebreak, shootout clean-up. Its 31 explanatory blocks should collapse to one line per tool, with the long text behind "?".
6. **End season.** /admin/seasons/[id]/end. Add the missing side effects to the confirm card (see Flows).
7. **Champions.** Winners and Role audit on one page: "Division · Winner · Role given?".
8. **Close-out check.** Season Audit, linked as the final step.

The Seasons list page keeps only the season cards (create, archive, delete). "Re-home season" moves under "Advanced" on the card.

### Settings (rare), one nav link with tabs

Config · Rules templates (today "Rules & Settings", dev-ops) · Tier templates (seasons/templates) · Deck/stake presets (Deck Bans) · Avoided pairs · Bans & strikes · Traits.

Separately, Data Audit becomes a "Data issues" tab on Matches, because it lists off-schedule and broken-score matches.

### System (dev-ops only), hidden from the TO entirely

Ops, Host, Play Times, Activity scan, Audit log. Rename "Audit" to "Action log" so it stops colliding with Season Audit, Data Audit and Role audit.

### Resulting nav

Inbox · Matches · Messages · Season tools · Settings, plus System for dev-ops. That's 5 links instead of 29, and the weekly routine fits in Inbox, Matches and Messages.

### Dead or near-dead

- **/admin/message:** fully duplicated by DMs. Fold it into Messages as "New DM".
- **/admin/play-times:** read-only and never acted on. Move it to System.
- **The Dashboard "Look: new (default)" / "Use classic look here" card:** the classic look is being retired, so remove it from the TO's landing page.
- **Dashboard stat "Fake players":** a test-data counter. Show it only when it is above zero, as a warning.
- **The broken "Set an end date" link** on the dashboard.

---

## Flows

### Flow 1: sign up

**Today:**
1. Find /join. It's unreachable from the nav unless a round is open.
2. "Open Discord invite".
3. "Sign in with Discord".
4. "Sign me up".
5. Wait.
6. At season start: an onboarding DM (~60 words plus opponents), a "Your League Panel" DM (~40 words, 6 buttons), and a pinned channel welcome (~280 words that pings the role).
7. If quiet, a check-in DM.

Players on the 🔔 list may also get up to three "Are you in?" asks with four buttons each.

**Information not needed at the decision point:**
- The ask DM's "Tapping ✅ Sign me up signs you up right now and puts you on the roster" is the right warning, but the bold sentence is 30 words. Cut it to "Only sign up if you can play the whole season. Dropouts break everyone's schedule."
- The channel welcome's tie rules ("Net lives = the lives you had left in your wins, minus the lives your opponents had left in your losses.") belong in Help, not in a day-one post.

**Inconsistent instructions:** the check-in DM says run "/schedule" to see who you play. Every other message says click "Who do I play?". Use the button everywhere.

**No signup confirmation DM:** a web signup only shows a callout. A one-line DM, "✅ You're in for Season 10. Divisions are posted when it starts on <date>.", would close the loop.

**Simpler version:** Join from any page, sign in with Discord, tap "Sign me up". At season start you get one DM with your division, your opponents, the deadline and a "Start a match" button.

**Minimum steps:**
1. Tap "Join" in the nav.
2. Tap "Sign in with Discord", which also offers the server invite if you're not a member.
3. Tap "Sign me up".
4. At season start, receive one DM.

Merge the onboarding DM and the League Panel into a single message: the panel's first render carries the welcome line and the opponent list. The pinned channel post keeps only the deadline, the roster and "Start a match". Rules go to a "Rules" button.

### Flow 2: report a match / resolve a match

**Player side today:** there are three parallel paths with three different rules.
- **Bot "Start a match":** about 10–14 clicks over 2 games. It needs no confirmation because both players vote on the winner. This is the best path.
- **Web ReportForm** on /divisions/[id] or /report: opponent, result, and 6 optional deck/stake/lives fields. It is recorded as CONFIRMED immediately, and the opponent is DMed a dispute link. On the division page the player gets no success message.
- **Slash command /report:** PENDING, with "Confirm" / "Dispute" buttons and auto-confirm after 2 minutes.
- **Disputing on the web:** go to /report, expand "Your recent matches", expand "Dispute", pick "What it should be (your POV):", optionally add "Winner's lives left per game", add context, then "Submit dispute". That's about 5 steps.

**Information not needed:**
- In ReportForm, "Per game (optional — decks differ each game)" with 2 × (deck, stake, lives) pickers sits open by default. Put it behind "Add deck/stake/lives (optional)". Lives matter for tiebreaks, so keep lives visible and hide deck/stake.
- The confirmation box "You're reporting: You beat Melon 2–0." duplicates the submit button label "Report — You beat Melon 2–0". Keep the button.

**Simpler version:** Play through "Start a match" and the result records itself. If you played outside the bot, report it on the site and your opponent gets one tap to confirm or dispute.

**Minimum steps for a player:**
1. Open "Report".
2. Pick opponent.
3. Pick result.
4. Submit and see "✓ Recorded".

To dispute:
1. Open the DM link, which lands on that one match.
2. Pick the correct result and tap "Dispute".

Make the DM link deep-link to the match, not to /report with two disclosures to open. Align the web report with /report: either both pending with auto-confirm, or both instant. Pick instant plus dispute, because that is what the bot effectively does.

**TO side today:** Disputes, Resolve All and Results are three pages. A disputed match appears on both Disputes and Resolve. Shootouts can be recorded in Results and deleted in Standings Preview.

**Minimum steps for the TO:**
1. In Inbox, tap "Accept proposed" or "Keep original".
2. For anything else, use Matches: filter, tick, act, add a reason, preview, apply.

### Flow 3: end a season

**Today:** six pages, in an order the TO must remember.
1. Optionally, Standings Preview. Here the TO may choose best-N scoring, the tiebreak, dropouts ("Reason (required, admin-only)" then "Apply {n} drop(s)") and shootout clean-up. These are four tools with seven confirm dialogs and 31 explanatory blocks.
2. /admin/seasons, then "End season →".
3. /end: the TO reads a per-division table (# / Player / Old rank / New rank / Movement), then clicks "End season + apply ratings" and confirms "End this season and apply new ratings to every player? This rewrites all ratings and can't be cleanly undone."
4. Back on Seasons: "📦 Archive", with no confirm.
5. Winners: "Mark awarded" per division, or "Who won?" then "Set champion" for ties.
6. Season Audit, from the System menu and not linked from the flow: "Recompute final ranks", then "Mark reviewed" per finding.
7. Role audit, separately.

**Information shown but not needed for the decision:**
- On /end, the Old rank / New rank columns for middle finishers, who show "no change". Show only movers: "↑ 13 promoted, ↓ 13 relegated", expandable per division.
- Information that is needed but missing: the confirmation never says that ending also deletes the season's Discord channels and roles, DMs every promoted and relegated player, and refreshes league info (lib/end-season.ts). These side effects are hard to reverse. Add them to the confirm card verbatim: "This will also: delete 13 division channels and roles, DM 26 players about moving up or down."
- "Mark awarded" is "bookkeeping only -- it checks the division off here without assigning any Discord role." A checkbox that does nothing in Discord invites a false sense of done. Either assign the role or rename it "Noted".

**Simpler version:** Season tools shows "End season" as a checklist:
1. ⚠ 4 unplayed matches: resolve.
2. ⚠ 2 ties: pick winners.
3. Review movers.
4. End season, with the side effects listed.
5. Champions: give roles.
6. ✓ Close-out check passed.

**Copy that should go:**
- The 31 muted paragraphs on Standings Preview. Keep one line per tool and move the rest behind "?".
- "Preview of new rankings (1 = best). Each division's top finisher promotes to the previous division (↑ green on /standings)…" Replace it with "Who moves: 13 up, 13 down."
- The Seasons page's "Re-home season" paragraph ("For moving the league to a new Discord mid-season. First: set DISCORD_GUILD_ID…"). Move it behind "Advanced".

---

## Prioritised backlog

| # | Item | Page | Type | Effort | Impact |
|---|---|---|---|---|---|
| 1 | Add a "Your division" card (rank, pts, opponents left, Report link) at the top of /standings for logged-in players | /standings | redesign | M | H |
| 2 | Always show "Join" in the nav for logged-out visitors; hide "Players" when logged out | nav | move | S | H |
| 3 | Show success and error feedback to players after reporting on the division page | /divisions/[id] | redesign | S | H |
| 4 | Make the same tied players rank the same on /standings and the division page | /standings, /divisions/[id] | redesign | S | H |
| 5 | Replace 85px player cards with 44px rows: rank · avatar · name · W-D-L · pts | /standings, /seasons/[id], /divisions/[id] | redesign | M | H |
| 6 | Collapse non-own divisions on phone to a one-line summary | /standings, /seasons/[id] | redesign | M | H |
| 7 | Show one tie footnote per tie group instead of per row; drop "Italic note = …" | /seasons/[id], /divisions/[id] | reword | S | H |
| 8 | Replace the admin dashboard with an Inbox (disputes inline, stale matches, DMs, ghosts) | /admin | redesign | M | H |
| 9 | Merge Results, Resolve All and Disputes into one "Matches" page | /admin | merge | L | H |
| 10 | Build a Season Tools hub with an ordered checklist; move 9 once-a-season links into it | /admin | move | M | H |
| 11 | List end-season side effects (channel/role deletion, DMs) on the confirm card | /admin/seasons/[id]/end | reword | S | H |
| 12 | Cut the admin nav from 29 links to 5 (Inbox, Matches, Messages, Season tools, Settings) + System | lib/nav-links.ts | move | M | H |
| 13 | Label the form pips and net lives inline ("Form", "♥ −8 lives"); add both to KEY | standings rows | reword | S | M |
| 14 | Remove the triple tier label (H3 + title + chip) per division card | /standings | cut | S | M |
| 15 | Remove the player-chip row and the per-card "unplayed" word | /divisions/[id] | cut | S | M |
| 16 | Collapse the profile stat tiles into one line; remove the duplicate "This season" block | /profile/[id] | merge | S | M |
| 17 | Add "Still to play" to the profile for the current season | /profile/[id] | redesign | S | M |
| 18 | Fix "In Legendary (Legendary)", "LEGENDARY X3" and "Your deck & stake stats" wording | /profile/[id] | reword | S | M |
| 19 | Move "Show BMP MMR" into ⚙️ only and relabel it "Show balatromp.com rating" | nav | move | S | M |
| 20 | Add prefetch={false} to name-dump links (429 storm) | /traits, /hall-of-fame | redesign | S | M |
| 21 | Put a "Most titles" leaderboard first, use compact season lists, explain "x2" | /hall-of-fame | redesign | S | M |
| 22 | Fold Hall of Fame into Seasons as a tab; show the champion on each season row | /seasons | merge | M | M |
| 23 | Take Traits out of the primary nav; link it from the profile Traits card | nav | move | S | M |
| 24 | Merge DMs, Message and Transcripts into "Messages" | /admin | merge | M | M |
| 25 | Merge signups/[id]/build and /preview into one "Build divisions" page | /admin/signups | merge | L | M |
| 26 | Collapse Standings Preview's 31 explanatory blocks behind "?" | /admin/standings-preview | cut | S | M |
| 27 | Rename "Audit" to "Action log"; put Data Audit under Matches; link Season Audit from Season tools | /admin | reword | S | M |
| 28 | Use one rule for result confirmation: web, /report and bot all instant + dispute | web report + bot | redesign | M | M |
| 29 | Deep-link the dispute DM to the specific match | web/lib/report.ts | redesign | S | M |
| 30 | Merge the onboarding DM and the League Panel DM; trim the channel welcome to deadline + roster + button | src/queue.ts, src/dm-panel.ts | merge | M | M |
| 31 | Check-in DM: replace "/schedule" with the "Who do I play?" button | src/checkin-message.ts | reword | S | L |
| 32 | Hide deck/stake per-game pickers behind a disclosure in ReportForm; keep lives | ReportForm | cut | S | L |
| 33 | Give the 404 page the site nav; ship /how-to-play or remove its palette entry | global | redesign | S | L |
| 34 | Fix the dashboard "Set an end date" link that points at a missing page | /admin | redesign | S | L |
| 35 | Remove the "Look: new / classic" card and the "Fake players" stat from the dashboard | /admin | cut | S | L |
| 36 | Stats: merge the two win leaderboards; group a tied streak; relabel "Green · Green" | /stats | merge | S | L |
| 37 | Show the banned state up front on /join; verify the "about 2 weeks" copy vs a 3-week season | /join | reword | S | L |
| 38 | Investigate the overlapping Season 7/8/9 dates on /seasons | /seasons | reword | S | L |
| 39 | Fix the "its" to "it's" typo; restore the Dr. Spectred icon | /traits | reword | S | L |
