---
date: 2026-10-12
confidence: high for every number and screenshot (Playwright chromium, logged out, 390x844 phone emulation and 1280x900 desktop, every screenshot inspected by eye); medium for file/line root causes named from source without running the code
sources:
  - https://tour-dev.balatroleague.com/seasons
  - https://tour-dev.balatroleague.com/seasons/Team%20Tour%205 (and /seeding, which renders the same page)
  - https://tour-dev.balatroleague.com/seasons/Team%20Tour%205/bracket
  - https://tour-dev.balatroleague.com/seasons/Team%20Tour%205/awards
  - https://tour-dev.balatroleague.com/seasons/Team%20Tour%205/rankings
  - https://tour-dev.balatroleague.com/seasons/Team%20Tour%205/news
  - https://tour-dev.balatroleague.com/seasons/Team%20Tour%205/players
  - https://tour-dev.balatroleague.com/seasons/Team%20Tour%205/players/impact
  - https://tour-dev.balatroleague.com/seasons/Team%20Tour%205/scouting
  - https://tour-dev.balatroleague.com/seasons/Team%20Tour%205/mock-draft
  - https://tour-dev.balatroleague.com/seasons/Team%20Tour%205/fantasy
  - https://tour-dev.balatroleague.com/seasons/Team%20Tour%205/weeks (expanded matchup)
  - https://tour-dev.balatroleague.com/seasons/Team%20Tour%204 (+ /bracket, /awards, /rankings, /news, /weeks: the finished conference season, used where Team Tour 5 has no data)
  - https://tour-dev.balatroleague.com/players (302 to /stats/players), /stats (302 to /stats/players), /stats/teams
  - https://tour-dev.balatroleague.com/players/cmqzblq8f00oprq4bdtuzs4in
  - https://tour-dev.balatroleague.com/u/0
  - https://tour-dev.balatroleague.com/matchups/cmuung12r001cs741km5xvbw5
  - https://tour-dev.balatroleague.com/matchups/cmuung12r001cs741km5xvbw5/sets/cmuutdutr001dll412fgzv0cf
  - https://tour-dev.balatroleague.com/rules, /hall-of-fame, /ratings, /tools, /signup, /signup/status, /auth/signin
  - https://tour-dev.balatroleague.com/awards, /rankings, /news, /scouting, /seeding, /mock-draft, /fantasy, /players/impact (top-level spellings from the brief; all 404)
  - D:/BalatroLeague/design-system/MASTER.md (Card Table rules; the worktree has no design-system/ folder)
  - D:/BalatroLeague/.claude/knowledge/ux-round4/01-findings.md (open rows T1-T14, S1-S8, M1-M2 not repeated here)
---

# Round 5: Tour pages earlier rounds did not cover

Method: one Playwright script (chromium, no MCP) visited every page at 390x844 (iPhone
UA, touch, DPR 2) and 1280x900, recorded HTTP status, horizontal overflow, page height,
tap targets under 44 px tall, text nodes under 12 px, console errors, failed requests,
and the Card Table markers (.rank-tile, .table-zebra, season pill, footer, .card panels),
then took full-page screenshots (viewport-only when the page was taller than 6000 px).
A second pass opened the phone Menu, expanded a week matchup at both widths, toggled
"Show sets and games", and scrolled the profile and Impact pages for close-ups.
Logged out throughout. No page has horizontal overflow at either width and no page logs
a console error except the 404s. Rounds 1-4 backlog rows T1-T22 are not repeated; where
a round-5 page is hit by an open row it is cross-referenced.

Conference and news/rankings pages: Team Tour 5 is Swiss and has no published rankings
or posts, and Team Tour 4 (conferences) has none either, so only their empty states could
be shot. /seasons/<name>/conf/<id> takes a conference cuid that no page links to (the
route's own comment says nothing routes there), so it was not reachable. /u/<discordId>
is not linked from any public page; /u/0 was probed for its empty state.

## a. Ten headline findings

1. **Impact is unusable on the phone.** /seasons/Team%20Tour%205/players/impact is
   45,753 px tall at 390 (12,451 at 1280): the .responsive-table turns each of the 227
   players into a five-line label/value card, and every card says "RANK --" because
   0 of 227 are ranked yet. The three-part row header ("Acheros . Numbers Go Down .
   unranked (1 more set to rank)") wraps into three narrow columns. Desktop is fine.
   Shot: shots/impact-phone-y3000.png, shots/seasons_Team_Tour_5_players_impact-phone.png.

2. **Seven Team Tour 5 pages are orphans with a picker that reads "Menu".** The season
   strip for Team Tour 5 is Player Rankings / Regular Season / Pick'em / Timeline / Draft,
   so Playoffs, Awards, Power rankings, News, Impact, Mock draft and Fantasy have no nav
   path logged out and their section picker falls back to "Menu" (T2 only covers the
   season root). Fantasy has live data (a 5-manager league, 1/55 picks) and still cannot
   be reached without typing the URL. Team Tour 4 shows Playoffs and Awards in the strip,
   so the strip is data-driven and the fix is to list sections that have data.
   Shot: shots/seasons_Team_Tour_5_fantasy-desk.png (no strip entry), shots/seasons_Team_Tour_5_bracket-phone.png.

3. **Matchup page phone table: the seed tag overlaps the player name.** In both team
   columns "S1" is drawn on top of the ascenders of "bacon" / "Syn" because the inline
   .seed span wraps onto its own 18 px line inside a 12 px cell. The Score column is
   hidden below sm so the check icon plus score sits in what desktop calls Status, and
   the two caster-only buttons (Matchup overlay, Overlay with sets) show to the public.
   Shot: shots/matchup-phone-row1.png, shots/matchups_cmuung12r001cs741km5xvbw5-phone.png.

4. **Expanded week matchup is the roughest surface on the site.** On the phone the sets
   table scrolls inside the <table> element (same root cause as T1), clipping the right
   team to "Sy", "JBl", "stu" with no fade. On desktop the open block fills one of the
   three grid columns and leaves two thirds of the row empty; its player pills are a
   per-seed gradient of the team colour (red to pink to purple to blue for one team) that
   is neither the team colour nor a token, on bare felt with no panel.
   Shot: shots/weeks-expanded-phone.png, shots/weeks-expanded-desk.png.

5. **Standings cards on the phone break team names mid-word and lose context.** The
   team-card-name link has overflow-wrap: anywhere, so "Meowster Manipulators" renders as
   "Meowster / Manipulator / s" and "Ashetronomers" as "Ashetronom / ers" in a 94 px pill.
   The record label is 10 px (61 text nodes under 12 px on the page). On Team Tour 4 the
   phone card drops the conference name entirely and, because finished seasons have no
   team colours, every name renders as a grey chip that reads as disabled.
   Shot: shots/seasons_Team_Tour_5-phone.png, shots/seasons_Team_Tour_4-phone.png.

6. **Soft 404s and dead routes.** /seasons/Team%20Tour%205/scouting returns 200 with
   <title> "Scouting - Team Tour 5" and a body of "Page not found" for logged-out viewers
   (notFound() after the layout streamed), where a sign-in prompt is the honest answer.
   /tools is a hard 404 for the public. /seasons/<name>/seeding renders the standings
   page under a /seeding URL (server redirect that the client keeps as 200 at the same
   URL). /players and /stats both redirect to /stats/players, so three URLs serve one page.
   Shot: shots/seasons_Team_Tour_5_scouting-phone.png.

7. **Page titles double the suffix and use two separators.** The layout template appends
   " | Team Tour" while pages already include it: "Rules . Team Tour | Team Tour",
   "Sign in . Team Tour | Team Tour", "What the stats mean - Team Tour | Team Tour".
   /signup is titled only "Team Tour"; a matchup is "Matchup - Team Tour" with no team
   names; a set is "Set - Team Tour". Season pages use " - ", others " . ".

8. **UI copy uses a typed double hyphen as a dash.** "Impact -- vs expected for your
   seed", "Avg seed -- average draft seed" (six times on /ratings), "Grouped by seed slot
   -- seeds aren't interchangeable", "never counts -- this is only about", "That page
   doesn't exist -- it may have been renamed" (22 occurrences across four files), while
   the same pages use a real em dash elsewhere ("Team Tour 5 -- regular season" is set
   with the real glyph). Two small copy bugs ride along: the mock-draft call to action
   links the wrong half ("Sign in" plain, "to submit a mock draft." underlined), and the
   /signup empty state ("Signups aren't open right now.") gives no next step or date.

9. **Phone Menu misreports the season and links to production.** On any Team Tour 4 page
   the Menu's switcher row says "Team Tour / Now viewing Team Tour 5", and that row links
   to https://tour.balatroleague.com (the old shell, S1). The Menu has Search, Stats, Hall
   of Fame, Rules but no Standings row, so the only way back to the current table from the
   phone Menu is the season pill. Shot: shots/menu0-open-phone.png.

10. **Player profile on the phone: 42 tap targets under 44 px and a 6,013 px page.** The
    set list's opponent names are 22 px links and the scores 24 px; the WON/LOST chip wraps
    to its own line on roughly half the rows so rows alternate between one and two lines;
    the head-to-head table top-aligns opponent names against vertically centred season
    cells; the @handle sits inside the h1 at 12 px. There is no in-page jump list for the
    seven sections. Shot: shots/profile-phone-y2600.png, shots/profile-phone-y4400.png.

Also noted, not headline: the Awards "also receiving votes" chips and the signup / mock
draft info boxes use the Common blue (#1e9bff) for links and borders, which MASTER.md
reserves for a genuine rarity; the Fantasy h1 carries the league name as a second span
and the "Browse other leagues (1)" disclosure opens by default to list the league already
on screen; the /seasons desktop grid is 4-up so Team Tour 5 sits alone on a second row
and the two leaderboard links are underlined body text rather than Card Table buttons;
/fantasy and /matchups/<id> never reach network idle (12 s timeout hit at both widths,
~1.6 s for every other page), so something keeps fetching logged out.

## b. Page-by-page notes

Columns: status, phone height / desk height (px), tap targets under 44 px tall at 390
(of all targets), text nodes under 12 px at 390, console errors. "Rules" and "Balatro
League" in the footer are 20 px links on every page and account for two of every count.

| page | status | height ph/dk | tap<44 ph | tiny ph | err | notes |
|---|---|---|---|---|---|---|
| /seasons | 200 | 1161 / 900 | 2/14 | 0 | 0 | Five season cards + two underlined leaderboard links. Desktop grid is 4-up (auto-fill 220 px) so Team Tour 5 is alone on row 2. Cards show "In progress" for TT5 but no week or date. Clean otherwise. |
| /seasons/Team Tour 5 (standings) | 200 | 2428 / 1372 | 2/29 | 61 | 0 | 20 rank tiles, 21 panels. Phone hides sets/games until "Show sets and games" (works, label flips to "Hide sets and games"). Team-name pills break mid-word (finding 5). 10 px record label. Picker reads "Menu" (T2). |
| /seasons/Team Tour 5/seeding | 200 | same as standings | same | same | 0 | redirect() to the season root; the browser keeps the /seeding URL. Title "Standings - Team Tour 5". |
| /seasons/Team Tour 5/bracket | 200 | 844 / 900 | 2/8 | 0 | 0 | Empty state: one panel "No playoffs for this season yet." No date or how-to-qualify line. Picker "Menu". TT4 bracket (1438 / 955 px, 2/17, 0 tiny) is good at both widths: rounds stack on the phone, connectors draw on desktop; "Champion:" link at the top repeats the champion pill at the bottom. |
| /seasons/Team Tour 5/awards | 200 | 844 / 900 | 2/8 | 0 | 0 | Empty state with icon, fine. TT4 awards (3104 / 1831 px): 32/38 targets under 44 px because winner cards and vote chips are 20-23 px links inside taller boxes; vote chips are Common blue; suit divider ornaments between podium and votes. |
| /seasons/Team Tour 5/rankings | 200 | 844 / 900 | 2/8 | 0 | 0 | "No rankings published yet this season." TT4 identical. No /rankings/<id> exists on the preview, so the detail page could not be shot. |
| /seasons/Team Tour 5/news | 200 | 844 / 900 | 2/8 | 0 | 0 | "No posts yet this season." TT4 identical. No post exists to open. |
| /seasons/Team Tour 5/players | 200 | 2680 / 1947 | 3/53 | 4 | 0 | 25 rank tiles, 23 tables (one per seed group). Phone: the ". seed N" suffix wraps under the name so the name sits on the row's top edge next to a centred tile; the Impact explainer paragraph pushes the table 300 px down; "More columns" (T4). 11 seed filter chips wrap to two rows. Desktop clean. |
| /seasons/Team Tour 5/players/impact | 200 | 45753 / 12451 | 3/239 | 0 | 0 | Finding 1. 11 seed panels, 227 rows, 188 tables. Desktop fine. |
| /seasons/Team Tour 5/scouting | 200 (soft 404) | 844 / 900 | 2/8 | 0 | 0 | Title "Scouting - Team Tour 5", h1 "Page not found" (finding 6). |
| /seasons/Team Tour 5/mock-draft | 200 | 844 / 900 | 2/9 | 0 | 0 | Leaderboard panel + blue-bordered "Sign in to submit a mock draft." box with the link on the wrong words. Copy has "--". Picker "Menu". |
| /seasons/Team Tour 5/fantasy | 200 | 1333 / 1109 | 2/11 | 4 | 0 | Standings table has plain rank numbers (no tiles) and no zebra; "Go to the live draft" and "Sign in with Discord" are underlined text; "Browse other leagues (1)" open by default listing the league on screen. Never reaches network idle. |
| /seasons/Team Tour 4 (conferences) | 200 | 3008 / 1735 | 3/37 | 61 | 0 | Playoffs panel above a flat 1-20 list. Desktop shows "Eris Conference / Pluto Conference" as text under each name (not links); phone drops it. Names are grey chips (no team colours stored). /conf/<id> unreachable. |
| /seasons/Team Tour 4/weeks | 200 | 1768 / 943 | 2/427 | 20 | 0 | Conference headings, 3-up grid on desktop. Expanded state: finding 4. |
| /players -> /stats/players | 200 | 2484 / 1874 | 3/38 | 7 | 0 | 25 rank tiles. Phone table clips at SET % (T1). Desktop: "Include playoff games" checkbox and the search input sit on one line with 0 gap. Stats strip wraps to a second row ("Rivalries") at 1280. |
| /stats -> /stats/players | 200 | same | same | same | 0 | Third URL for the same page. |
| /stats/teams | 200 | 2028 / 1780 | 2/61 | 4 | 0 | 25 rank tiles. Phone: SEASON column is an underlined two-line link ("Team / Tour 1") on every row, FINISH and later columns clipped (T1). TT5 teams in colour pills, older seasons plain text. |
| /players/<id> (Bard) | 200 | 6013 / 4776 | 42/119 | 23 | 0 | Finding 10. Eight stat tiles 2-up, season table (wrapped, scrolls), bar chart, by-deck and by-stake tables (unwrapped but fit), set list, head-to-head with By set / By opponent and a filter. "Back to leaderboard" link; MVP badges. |
| /u/0 | 200 | 844 / 900 | 2/8 | 0 | 0 | "Not on Team Tour" + "All players ->". Fine, but unlinked from anywhere. |
| /matchups/<id> | 200 | 1317 / 968 | 2/44 | 4 | 0 | Finding 3. h1 is two team-colour blocks in the pixel face (red block, black text) with a small "vs". Desktop Status column repeats the score ("bacon 2-1") in green and truncates "doctor cheese gl 2-0". Never reaches network idle. |
| /matchups/<id>/sets/<id> | 200 | 844 / 900 | 2/9 | 2 | 0 | "back to matchup" (lowercase, vs "Back to leaderboard"), h1 "S1 bacon vs S1 Syn", Bo3, bare "2-1" with no label, phone hides deck/stake/how-decided behind "More columns" (T4). Title "Set - Team Tour". |
| /rules | 200 | 7371 / 4009 | 3/9 | 0 | 0 | One long panel, gold h2s, readable at both widths. Raw Twitch URL as link text (22 px). No in-page section nav for a 7,400 px phone page. |
| /hall-of-fame | 200 | 1706 / 900 | 2/89 | 4 | 0 | Four champion cards + selected bracket. Phone: "Team Tour 4 -- Calculated Gambling" heading wraps around the dash. Collapsed round repeats (T10). 11 px season eyebrow. |
| /ratings | 200 | 1847 / 1523 | 2/8 | 0 | 0 | No panel at all: gold h2s straight on felt (the only content page without a Card Table panel besides sign-in). "--" six times. Title double suffix. |
| /tools | 404 | 844 / 900 | 2/8 | 0 | 1 (404) | Admin-only; public gets the not-found card. |
| /signup, /signup/status | 200 | 844 / 900 | 2/7 | 0 | 0 | /signup/status redirects to /signup. Blue info box "Signups aren't open right now." and nothing else; title "Team Tour". |
| /auth/signin | 200 | 844 / 900 | 2/8 | 0 | 0 | h1, one line, gold "Continue with Discord". Fine. Title double suffix. |
| /awards, /rankings, /news, /scouting, /seeding, /mock-draft, /fantasy, /players/impact (top-level) | 404 | 844 / 900 | 2/8 | 0 | 1 each | These only exist under /seasons/<name>/; nothing links the bare spellings, so no fix needed beyond noting it. |

Desktop tap-target counts are high everywhere tables appear (table links are 20-36 px)
and are not listed; the phone counts are the ones the brief asked for.

## c. Consistency table

"Rank tiles" = .rank-tile present; "zebra" = .table-zebra present (no public page uses it;
tables alternate by row borders only); "season pill" = the header season control;
"footer" = .site-footer; "panel" = at least one Card Table panel (.card or a
component card) wraps the main content.

| page | rank tiles | zebra | season pill | footer | Card Table panel |
|---|---|---|---|---|---|
| /seasons | no | no | yes | yes | yes (season cards) |
| /seasons/TT5 standings | yes (20) | no | yes | yes | yes |
| /seasons/TT5/bracket | no | no | yes | yes | yes (empty-state panel) |
| /seasons/TT5/awards | no | no | yes | yes | yes |
| /seasons/TT4/awards | no | no | yes | yes | yes (award cards) |
| /seasons/TT5/rankings | no | no | yes | yes | yes (empty-state panel) |
| /seasons/TT5/news | no | no | yes | yes | yes (empty-state panel) |
| /seasons/TT5/players | yes (25) | no | yes | yes | yes |
| /seasons/TT5/players/impact | no (all "--") | no | yes | yes | yes (11 seed panels) |
| /seasons/TT5/scouting | no | no | yes | yes | yes (not-found card) |
| /seasons/TT5/mock-draft | no | no | yes | yes | yes |
| /seasons/TT5/fantasy | no (plain numbers) | no | yes | yes | yes |
| /seasons/TT4 standings | yes (20) | no | yes | yes | yes |
| /seasons/TT4/bracket | no | no | yes | yes | yes |
| /seasons/TT4/weeks (expanded) | no | no | yes | yes | cards yes, open sets table no |
| /stats/players | yes (25) | no | yes | yes | yes |
| /stats/teams | yes (25) | no | yes | yes | yes |
| /players/<id> | no | no | yes | yes | yes (6 panels) |
| /u/0 | no | no | yes | yes | no (bare text) |
| /matchups/<id> | no | no | yes | yes | yes |
| /matchups/<id>/sets/<id> | no | no | yes | yes | yes |
| /rules | no | no | yes | yes | yes |
| /hall-of-fame | no | no | yes | yes | yes |
| /ratings | no | no | yes | yes | no (headings on felt) |
| /tools (404) | no | no | yes | yes | yes (not-found card) |
| /signup | no | no | yes | yes | yes (info box) |
| /auth/signin | no | no | yes | yes | no (bare h1 + button) |

Shared shell is consistent on every page: same sticky bar (switcher chip, season pill,
Standings / Stats / Hall of Fame / Rules, Search Ctrl K, Sign in), same footer, skip
link, #main-content, a global :focus-visible rule present. Colour drift is limited to
team colours (.cc-pill backgrounds, by design) and the #111111 ink those pills use for
text instead of the #0b1b1a token.

## d. Ranked backlog

Files are relative to D:/wt-tour-burgundy/apps/tour. Size S = under an hour, M = a
session, L = more than a session. Rows that only extend an open round-4 row say so.

| id | page | problem | fix | size | needs-user-decision |
|---|---|---|---|---|---|
| T30 | /seasons/<name>/players/impact | 45,753 px phone page; every player is a 5-line card and 227 of them read "RANK --" | Phone layout as one compact row per player: name + team on line one, Sets / Impact / vs-expected as three inline figures on line two; drop the Rank line while nobody is ranked; collapse each seed panel to its top 5 with "Show all 20" (app/seasons/[name]/players/impact/page.tsx, app/globals.css .responsive-table block at 321-431) | M | no |
| T31 | season strip / picker | Playoffs, Awards, Power rankings, News, Impact, Mock draft, Fantasy have no nav path on Team Tour 5 and the picker reads "Menu" on all of them | Season strip lists every section that has data or an empty state worth showing (Fantasy and Mock draft at least while the draft runs); picker label resolves the current pathname for nested sections (lib/section-nav-core.ts pickerLabel at 48-50, components/SectionPicker.tsx, the strip's item list) | M | yes (which sections belong in the strip) |
| T32 | /matchups/<id> | Phone table: seed tag overlaps the player name; Score hidden below sm so score lives in the Status cell | Put the seed in its own 11 px block line under the name (or in front with white-space: nowrap on the cell) and keep one Score cell at every width (app/globals.css .seed at 969, app/matchups/[matchupId]/page.tsx row markup ~line 60-120) | S | no |
| T33 | /matchups/<id> | "Matchup overlay" and "Overlay with sets" copy-link buttons show to logged-out viewers | Render them only for casters/TOs/captains (app/matchups/[matchupId]/page.tsx 199-200) | S | no |
| T34 | /seasons/<name>/weeks expanded (phone) | Sets table scrolls inside the <table> and clips the right team with no fade | Same fix as T1 applied to .wk-sets table: wrapper scrolls, right-edge fade, nowrap names (app/globals.css 1228-1230, 339-341) | S | no (extends T1) |
| T35 | /seasons/<name>/weeks expanded (desktop) | Open matchup fills one of three grid columns; two thirds of the row stays empty | details[open] gets grid-column: 1 / -1 and the sets table sits in a panel with the matchup header (app/globals.css .wk-grid at 1200, .wk-match) | S | no |
| T36 | /seasons/<name>/weeks expanded | Player pills are a per-seed gradient of the team colour, not a token or the team colour | One pill style: team colour as a 4 px left edge, panel-2 background, paper text; seed as a muted prefix (components for cc-pill-block, app/globals.css .cc-pill 1006) | M | yes (the gradient may be intentional) |
| T37 | /seasons/<name> standings (phone) | Team names break mid-word ("Meowster Manipulator / s"); record label 10 px | overflow-wrap: normal with hyphens: auto on .team-card-name a; pill gets min-width: 0 and the name may wrap at spaces only; record label 11 px minimum (app/globals.css 1613, 1628) | S | no |
| T38 | /seasons/<name> standings (TT4 and older) | Finished seasons have no team colours so every chip is grey, and the phone card drops the conference label | Show the conference as the card eyebrow on the phone; backfill colours for finished seasons or use a neutral paper chip with no border instead of panel-2 grey (app/seasons/[name]/page.tsx team cards, data) | M | yes (backfill colours or accept neutral) |
| T39 | /seasons/<name>/scouting | Logged-out visitors get 200 + "Page not found" under a "Scouting" title | Render a "Sign in to see scouting" card (same pattern as mock draft) instead of notFound(); keep notFound() only for non-captains if that is the policy (app/seasons/[name]/scouting/page.tsx 56) | S | yes (hide or invite) |
| T40 | /seasons/<name>/seeding, /players, /stats | Alias URLs: /seeding shows standings without changing the URL; /players and /stats both 302 to /stats/players | Make /seeding a permanentRedirect and drop it from any menu; keep one canonical (/stats/players) and 308 the others (app/seasons/[name]/seeding/page.tsx 6, app/stats/page.tsx 6, players redirect) | S | no |
| T41 | all pages | Titles double the suffix ("Rules . Team Tour | Team Tour"); /signup titled "Team Tour"; matchup/set titles carry no names; two separators | Pages set bare titles and let the layout template add " | Team Tour"; matchup title "A vs B - Week 5", set title "bacon vs Syn - Week 5"; one separator (app/layout.tsx 65, rules/page.tsx 8, ratings/page.tsx 6, auth/signin/page.tsx 5, matchups/[matchupId]/page.tsx 47, signup/page.tsx, sets page metadata) | S | no |
| T42 | /ratings, impact, mock-draft, not-found | 22 typed "--" dashes in UI copy | Replace with an em dash or a colon in the four files (app/ratings/page.tsx, app/not-found.tsx, app/seasons/[name]/players/impact/page.tsx, app/seasons/[name]/mock-draft/page.tsx) | S | no |
| T43 | /seasons/<name>/mock-draft | "Sign in" plain, "to submit a mock draft." is the link | Link the verb: "Sign in to submit a mock draft" as one link, styled as a secondary button (app/seasons/[name]/mock-draft/page.tsx 93) | S | no |
| T44 | /signup | Empty state is one sentence in a blue box with no next step | Add when signups open (or "watch #announcements"), a Discord link, and link to /rules "Intro to Team Tour"; drop the Common-blue border for a panel (app/signup/page.tsx) | S | yes (what to promise) |
| T45 | phone Menu | Switcher row says "Now viewing Team Tour 5" on Team Tour 4 pages; no Standings row | Row shows the season from the pathname (or just "Team Tour"); add a Standings row above Stats (components/MoreMenu.tsx, the product switcher's viewing label) | S | no |
| T46 | /players/<id> (phone) | 42 targets under 44 px; WON/LOST chip wraps on half the rows; head-to-head names top-aligned; @handle inside h1 | Set-list row as a two-line grid (meta line, then "vs Name 2-1 [WON]" with the chip pinned right at 44 px row height); vertical-align: middle on head-to-head cells and drop max-sm:min-h-11 from name links in favour of row height; move the handle under the h1 as .sub (app/players/[id]/page.tsx, components/PlayerGamesPanel.tsx 59) | M | no |
| T47 | /players/<id>, /rules | 6,000-7,400 px phone pages with no in-page navigation | A sticky "Jump to" chip row (Seasons, Games, Sets, Head-to-head; TLDR, Drafting, Format, Scheduling, Streaming, Sportsmanship) using the existing anchors (app/players/[id]/page.tsx, app/rules/page.tsx) | M | no |
| T48 | /seasons/<name>/awards | Vote chips and winner names are 20-23 px links; vote chips in Common blue | Chips at 32 px height with 44 px tap padding; chip colour paper-dim on panel-2 (gold only for the winner); whole winner card is the link (app/seasons/[name]/awards/page.tsx 89-95, app/globals.css .vote-chip, .podium-card) | S | no |
| T49 | /seasons/<name>/fantasy | h1 doubles as league name; "Browse other leagues" open by default listing the current league; draft link and sign-in as underlined text; standings has plain rank numbers | h1 "Fantasy", league name as eyebrow; disclosure closed unless there is more than one league; "Go to the live draft" as a primary button; rank tiles in the standings (app/seasons/[name]/fantasy/page.tsx 339, 369, standings table) | S | no |
| T50 | /seasons (desktop) | 4-up grid leaves the current season alone on row 2; leaderboard links are underlined text | Current season first as a full-width hero card ("Team Tour 5 - Week 5 of 7"), finished seasons 4-up below; leaderboards as two secondary buttons (app/seasons/page.tsx, app/globals.css .season-grid 951) | S | no |
| T51 | /seasons/<name>/players (phone) | ". seed N" wraps under the name so the name rides the row's top edge | Render seed as a .sub block under the name at 11 px and vertically centre the cell (app/seasons/[name]/players/page.tsx row cell, components/PlayersTable.tsx) | S | no |
| T52 | /ratings, /auth/signin, /u/<id> | Only content pages with no Card Table panel; headings sit on bare felt | Wrap in a .card like /rules; sign-in gets a small centred panel (app/ratings/page.tsx, app/auth/signin/page.tsx, app/u/[discordId]/page.tsx) | S | no |
| T53 | /matchups/<id> (desktop) | Status column repeats the score in green and truncates names ("doctor cheese gl 2-0") | Status shows only the outcome word ("Played", "Forfeit", "Pending") and the winner's name untruncated; the score stays in Score (app/matchups/[matchupId]/page.tsx status cell) | S | no |
| T54 | /seasons/<name>/bracket, /rankings, /news empty states | Panels say only that nothing exists | One more line each: when playoffs start and how many teams qualify (from the season config), "Rankings are posted after each week", "Posts appear here once a writer publishes" (app/seasons/[name]/bracket/page.tsx, rankings/page.tsx, news/page.tsx) | S | yes (copy) |
| T55 | /seasons/<name>/conf/<id>, /u/<id> | Routes nobody links to | Link conference names on the Team Tour 4 standings cards to /conf/<id>; link @handle on the profile to /u/<discordId>; or delete the conf route (app/seasons/[name]/page.tsx conference text, app/seasons/[name]/conf/[conf]/page.tsx 20-23, app/players/[id]/page.tsx handle) | S | yes (keep or delete the conf page) |
| T56 | /seasons/<name>/fantasy, /matchups/<id> | Never reach network idle logged out (12 s timeout at both widths, 1.6 s elsewhere) | Find the poller (router.refresh interval or a live hook) and stop it for logged-out viewers or pause it when the tab is hidden (app/seasons/[name]/fantasy/*, app/matchups/[matchupId]/*, any LiveRefresh component) | S | no |
| T57 | all tables | Team-colour pills use #111111 for text instead of the #0b1b1a ink token | Use var(--ink) or the gold-ink token in the cc-pill text rule (app/globals.css .cc-pill 1006 and the inline style that sets it) | S | no |

## Screenshots

All in C:/Users/micha/AppData/Local/Temp/claude/C--Users-micha/74accfae-f427-461c-adb3-51832c5ea65f/scratchpad/ux5/shots/
(metrics in ../metrics.json and ../metrics-extra.json; scripts audit.js, extra.js, extra2.js alongside).

- seasons-phone.png, seasons-desk.png
- seasons_Team_Tour_5-phone.png, seasons_Team_Tour_5-desk.png, standings-phone-sets-shown.png
- seasons_Team_Tour_5_seeding-phone.png, seasons_Team_Tour_5_seeding-desk.png
- seasons_Team_Tour_5_bracket-phone.png, seasons_Team_Tour_5_bracket-desk.png
- seasons_Team_Tour_4_bracket-phone.png, seasons_Team_Tour_4_bracket-desk.png
- seasons_Team_Tour_5_awards-phone.png, seasons_Team_Tour_5_awards-desk.png
- seasons_Team_Tour_4_awards-phone.png, seasons_Team_Tour_4_awards-desk.png
- seasons_Team_Tour_5_rankings-phone.png, seasons_Team_Tour_5_rankings-desk.png, seasons_Team_Tour_4_rankings-phone.png, seasons_Team_Tour_4_rankings-desk.png
- seasons_Team_Tour_5_news-phone.png, seasons_Team_Tour_5_news-desk.png, seasons_Team_Tour_4_news-phone.png, seasons_Team_Tour_4_news-desk.png
- seasons_Team_Tour_5_players-phone.png, seasons_Team_Tour_5_players-desk.png
- seasons_Team_Tour_5_players_impact-phone.png, seasons_Team_Tour_5_players_impact-desk.png, impact-phone-y3000.png, impact-phone-y20000.png
- seasons_Team_Tour_5_scouting-phone.png, seasons_Team_Tour_5_scouting-desk.png
- seasons_Team_Tour_5_mock_draft-phone.png, seasons_Team_Tour_5_mock_draft-desk.png
- seasons_Team_Tour_5_fantasy-phone.png, seasons_Team_Tour_5_fantasy-desk.png
- seasons_Team_Tour_4-phone.png, seasons_Team_Tour_4-desk.png
- seasons_Team_Tour_4_weeks-phone.png, seasons_Team_Tour_4_weeks-desk.png, weeks-expanded-phone.png, weeks-expanded-desk.png
- players-phone.png, players-desk.png, stats-phone.png, stats-desk.png, stats_players-phone.png, stats_players-desk.png
- stats_teams-phone.png, stats_teams-desk.png
- players_cmqzblq8f00oprq4bdtuzs4in-phone.png, players_cmqzblq8f00oprq4bdtuzs4in-desk.png, profile-phone-y1700.png, profile-phone-y2600.png, profile-phone-y3500.png, profile-phone-y4400.png, profile-phone-y5300.png
- u_0-phone.png, u_0-desk.png
- matchups_cmuung12r001cs741km5xvbw5-phone.png, matchups_cmuung12r001cs741km5xvbw5-desk.png, matchup-phone-row1.png
- matchups_cmuung12r001cs741km5xvbw5_sets_cmuutdutr001dll412fgzv0cf-phone.png, matchups_cmuung12r001cs741km5xvbw5_sets_cmuutdutr001dll412fgzv0cf-desk.png
- rules-phone.png, rules-desk.png, hall_of_fame-phone.png, hall_of_fame-desk.png, ratings-phone.png, ratings-desk.png
- tools-phone.png, tools-desk.png, signup-phone.png, signup-desk.png, signup_status-phone.png, signup_status-desk.png, auth_signin-phone.png, auth_signin-desk.png
- menu0-open-phone.png
- awards-, rankings-, news-, scouting-, seeding-, mock_draft-, fantasy-, players_impact- (phone/desk): the top-level 404 spellings
