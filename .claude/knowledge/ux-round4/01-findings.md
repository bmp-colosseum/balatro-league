---
date: 2026-10-12
confidence: high for every interaction driven (Playwright, logged out, 390x844 and 1280x900, every screenshot inspected); medium for root causes named from source without running the code
sources:
  - https://balatroleague.com (/standings, /divisions/cmuyvr3mt002qnl01scisol0p, /profile/*, /hall-of-fame, /hall-of-fame?all=1, /how-it-works, /join, Ctrl K palette, chip switcher, phone Menu)
  - https://tour-dev.balatroleague.com (/seasons/Team Tour 5 and its /weeks, /pickem, /timeline, /draft; /teams/cmt0z67tv001jko3uzqz9cgat; /stats/players, /stats/teams; /hall-of-fame; /seasons; palette; switcher; season pill menu; phone Menu)
  - https://tour.balatroleague.com (only as the switcher's landing page)
  - D:/BalatroLeague/web: components/ProductSwitcher.tsx, SiteNav.tsx, SiteMobileMenu.tsx, CommandPalette.tsx, CommandButton.tsx, CollapsibleDivision.tsx, SeasonWindow.tsx, LocalDateTime.tsx, SeasonPill.tsx, SiteFooter.tsx, DivisionStandingsTable.tsx, ui/menu.tsx; app/globals.css, app/v2/standings-cards.css, app/standings/page.tsx, app/divisions/[id]/page.tsx, app/hall-of-fame/page.tsx, app/join/page.tsx, app/api/command-context/route.ts, lib/onboarding-guide.ts, lib/season-window-text.ts
  - D:/wt-tour-burgundy/apps/tour: app/layout.tsx, app/globals.css, components/ProductSwitcher.tsx, SeasonsMenu.tsx, SectionPicker.tsx, SeasonNav.tsx, MoreMenu.tsx, MoreColumnsToggle.tsx, StandingsTable.tsx, FlipSidesButton.tsx, ShowMore.tsx, SiteFooter.tsx, ui/menu.tsx, app/players/PlayersTable.tsx, app/teams/TeamsTable.tsx, app/seasons/[name]/page.tsx, weeks/page.tsx, pickem/page.tsx, loading.tsx, app/hall-of-fame/page.tsx, components/DraftBoardTable.tsx
  - prior audits (not repeated): ux-audit/01-findings.md, ux-cohesion/01-findings.md, ux-round3/01-findings.md, bot-ux/01-findings.md
screenshots: D:/BalatroLeague/.claude/knowledge/ux-round4/shots/ (sw-* switcher, menu-* phone menus, topbar-*, search-*, st-* standings, div-*, how-it-works-*, join-*, hof-*, t-* tour pages, slow-* Slow 3G frames, focus-* 2x crops of focused controls)
---

# Round 4: interaction and flows on both sites

Method: every flow in the brief was driven with Playwright at 390x844 and 1280x900, logged out,
with the keyboard (Tab, Enter, Space, arrows, Escape) as well as the mouse. For each control I
recorded the focused element's computed outline, whether :focus-visible matched, and took a 2x crop
to judge visibility by eye. Browser back was tested with scroll position and expand state. Four
pages were loaded on an emulated Slow 3G (400 ms latency, 50 KB/s) with a layout-shift observer.
Console: no errors or warnings on any page of either site during the whole run.

## a. Ten headline findings

1. The switcher is the same control on both sites, and the round trip breaks on the first hop.
   Same label ("Switch between Balatro League and Team Tour"), same two-row menu with a "Now
   viewing ..." subtitle under the current product, same keyboard behaviour (Tab reaches it, Enter
   opens with the first row focused, ArrowDown moves, Escape closes and puts focus back on the
   chip). But the league's "Team Tour" row goes to tour.balatroleague.com, which still serves the
   old shell with no chip, so a visitor who switches cannot switch back the same way. tour-dev's
   row points at the same prod host. Shipping the preview to prod closes this; nothing else does.
   [sw-league-desk-open, sw-league-desk-switched, sw-tour-desk-open, sw-tour-desk-switched-open]
2. Keyboard users cannot see where they are inside any menu. The switcher rows and the Tour's
   season menu rows have outline: none and a transparent background when focused (data-highlighted
   never lands on keyboard focus), so after Enter and ArrowDown nothing on screen changes. Every
   other control gets Chrome's default double ring, which is visible but is not the 3 px gold ring
   the design system gives inputs. [focus-league-menuitem, focus-tour-menuitem, focus-league-brand,
   focus-league-player]
3. League search promises what it does not hold. The placeholder says "Jump to a player, division,
   or season..." but /api/command-context returns players only to a logged-in session and never
   returns seasons, so "hiker" (top of Rare 1) and "season 8" both answer "No results." while
   "rare 2" works. The Tour palette finds Schnuu, Schnuu's Eleven, Ouijas Beat You and Team Tour 4
   from the same box. [search-league-desk-hiker, search-league-desk-season_8, search-tour-desk-Schnuu]
4. Standings forget what you opened. On the phone, expand Rare 2, tap Cartu V2, press back: the
   page restores the scroll offset (1186 px both ways) but Rare 2 is collapsed again, so the
   restored offset now shows the Rare 3 and Rare 4 chips and the player you came from is off
   screen. The open state lives in a useState with no storage (CollapsibleDivision.tsx:41-48).
   [st-phone-rare2-expanded, st-phone-back-after-expand]
5. Tour stats tables clip on a phone. The players and teams tables are 601 px and 749 px wide
   after "Show full stats" but the .table-scroll wrapper never scrolls (scrollWidth 306 = client
   width) because the table element itself carries overflow-x: auto, so Seasons, Sets, Set %,
   Games and Game % are unreachable; even the default view loses "Set %" at the edge. The team
   roster table (compact-phone, overflow visible) scrolls correctly, which proves the fix.
   [t-stats-players-phone-full2, t-stats-teams-phone-full2, t-team-phone-morecols]
6. Two "Menu" buttons stacked on the Tour phone standings. The header's Menu sits at top right and
   the section picker directly below is also labelled "Menu", because Standings is not one of the
   picker's items so pickerLabel() falls back to the generic word. On every other section it reads
   "Regular Season", "Pick'em", "Draft". [menu-tour-phone-open, t-seasonnav-phone-open]
7. One action, three names on the Tour: "Show sets and games" (season standings), "Show full
   stats" (stats players and teams tables), "More columns" / "Fewer columns" (team roster). None
   carries aria-pressed. The league has the same gesture as "Hide" / chevron on divisions.
   [t-standings-phone-sets, t-stats-players-phone, t-team-phone]
8. Slow 3G: both sites show real text within 1.5 s with no skeleton needed, but two things move.
   The Tour's loading shell is short, so the footer renders inside the first viewport and jumps
   out when the streamed section arrives (layout shift 0.162 on /weeks, 0.175 on /stats/players,
   both attributed to .site-footer). The league shows "Runs 2026-10-08 to 2026-10-22" until
   hydration, then "Oct 7, 2026 to Oct 21, 2026": raw ISO, then a different day. Avatars are
   black discs until the image lands. [slow-tour-phone-1500, slow-tour-phone-done,
   slow-league-phone-1500, slow-league-phone-done]
9. League phone top bar: "Login with Discord" is a 65 px, 12 px-type link that wraps to two lines
   beside an icon-only chip and a pill clipped to "Season 9 ..."; the header is 75 px tall against
   the Tour's 63 px. The phone Menu already contains the identical "Login with Discord" row, so
   the bar's copy is a duplicate. The Tour shows a bare sign-in glyph. [topbar-league-phone,
   topbar-tour-phone, menu-league-phone-open]
10. The division page has no heading, no match links and no "something is wrong" path. Its only
    h2 is inside the hidden v1 block (the visible title is a <strong>), the Played cards show
    "1-1" and "0-2" with nothing to open, and the only "Report a problem" copy on the site is the
    closing card of How it works, after "Ready? Join the league", so the page a new player reads
    ends on a problem rather than the call to action. [div-phone, div-phone-played,
    how-it-works-phone]

Good and should stay: collapsed divisions are now quiet panel-2 chips with the leader and
count (round 3 finding 6 is fixed); the KEY now explains pips and lives; the shared footer is on
both sites; Escape closes every popover and returns focus to its trigger on both sites; the Tour
Pick'em logged-out state is clear (pick buttons disabled, "sign in to pick", sign-in card above);
the Tour stats search filters instantly with a real empty state ("No players match "zzzzq"."); "Show
50 more players" keeps focus on the button; the Tour has a Skip to content link; Hall of Fame on
both sites: whole champion card is the link, aria-current on the league toggle, the Tour shelf card
selects a tour and every bracket team name opens the team page.

## b. Flow-by-flow notes

Severity: H costs a visitor time or trust on most visits; M is visible friction; L is polish.

### 1. The switcher [sw-*, menu-*-phone-open, focus-*-brand, focus-*-menuitem]
- Desktop tab order league: chip, season pill, six nav pills, Search, Settings gear, Login. Tour:
  Skip to content, chip, season pill, four nav pills, Search, Sign in, then the season sub-nav.
  Sane on both; the league lacks the skip link. M.
- Enter on the chip opens the menu with row 1 focused; ArrowDown moves to row 2; Escape closes
  and focus returns to the chip. Identical on both sites. Rows have no visible focus (finding 2). H.
- Menu copy: league rows "Balatro League / Now viewing Season 9 - Truth Nuke" and "Team Tour /
  Team standings and brackets"; Tour rows "Balatro League / Standings, divisions and seasons" and
  "Team Tour / Now viewing Team Tour 5". Same pattern, neither marks the current row with
  aria-current. L.
- The chip itself differs in size on desktop: league 166x23 label chip, Tour 44 px tall gold
  button with a larger card glyph. On the phone both are icon-plus-chevron, 44 px. M.
- Switch league to Tour: 1.6 s to tour.balatroleague.com (old shell, no chip). Switch Tour to
  league: 1.5 s, chip present, menu identical. Back button returns correctly on both. H (finding 1).
- Phone Menu: both put the switcher rows first. League then lists Standings, Stats, Hall of Fame,
  Seasons, How it works, Join, the rating toggle (still a gold primary button), Login with
  Discord. Tour lists Search, Stats, Hall of Fame, Rules with icons. The league Menu has no
  icons, the Tour's has. L.

### 2. Search [search-*]
- Ctrl K opens on both at both sizes; the Search button opens it on the league; the Tour phone
  has no bar button, its Menu > Search row opens the palette and closes the Menu (focus lands in
  the input; Escape returns focus to the Menu button). Works. L (placement differs, see table).
- Input focus ring: league solid 3 px gold; Tour "none 3px gold" on the computed style but the
  wrapper draws it; both visibly fine.
- League results logged out: Pages (7) and Divisions (13) only. "hiker": No results. "rare 2":
  Divisions > Rare 2. "season 8": No results. "xqzv": No results. Enter on a no-result query does
  nothing (stays on the page). H (finding 3).
- Tour results: Pages, the current season's sections, Seasons, Teams (every tour), Players.
  "Schnuu" gives the team and the player; "Ouijas" the team; "Team Tour 4" the season plus its
  20 teams; "xqzv": No results. ArrowDown moves the selection to the second result, Enter opens
  it (landed on /teams/cmt0z5ovo000pko3ulem4l48d). Good.
- Empty-state wording is "No results." on both. Placeholder punctuation differs ("..." vs the
  single ellipsis character). L.

### 3. League standings [st-*, focus-league-tier, focus-league-player, hof-*]
- Phone default: first division of each tier open, the rest collapsed chips. Tap "Hide" on the
  open card: it becomes a chip in place; tap again: reopens. Tapping a collapsed chip expands it
  and the button shrinks from 44 px to the 23 px "Hide" tab, so the content below jumps 27 px up.
  Space and Enter both toggle the focused summary button; aria-expanded is correct. L (jump).
- KEY opens as a details inside the progress panel: promotion / relegation zones, clinched,
  locked, dropped out, form pips, net lives. Complete now. Good.
- Lives pill ("+10 lives"), tie footnote (11 px italic, 147,163,160 on panel) and form pips show
  nothing on hover or tap; the pip row has only a title attribute ("Form: 0W 0D 0L"), which touch
  never shows. L.
- Click a player: profile in about 200 ms with a "<- Standings" back link. Browser back: URL and
  scroll offset restored on both sizes, but on the phone any division you expanded is collapsed
  again (finding 4). H.
- "Your division" card is logged-in only; not covered here.

### 4. League division page [div-phone, div-phone-played, div-desk]
- Hero: pixel title, rarity chip, season link, "all standings" text link floating right, meta
  line, roster chips (duplicate of the table below, prior item). Standings card. "Still to play"
  as a grid of vs-blocks (not links). "Played" cards show the two names and the score, no date,
  no link to anything. A hidden v1 "Recent matches (2)" details exists in the DOM but is not
  rendered. M.
- No heading element is visible: the h2 "Rare 1" is in the hidden v1 block. L (outline/a11y).
- "Report a problem" copy: none on this page. The only instruction is the last card of How it
  works: "Press Report a problem on the result post in Discord, open a ticket in the support
  channel, or DM Chrono." A player who sees a wrong score here has no pointer to that. M.

### 5. How it works and Join [how-it-works-phone, join-phone]
- How it works reads well as a new player: eleven short cards in order (seasons, tiers, schedule,
  playing a match, results, standings, how the season ends, ties, scheduling, need help). The
  closing card is "Something wrong with a result?", placed after the "Ready? Join the league"
  button, so the page ends on the escalation rather than the CTA. M.
- Links: "balatroleague.com/standings" goes to https://www.balatroleague.com/standings, a second
  host that serves the whole site with a 200 and no redirect to the apex; "hammertime.cyou";
  "open in Discord" and "support channel" (same Discord channel URL); "Join the league" -> /join.
  All resolve. L.
- Join: h2 "Join the league", intro, Step 1 card (Open Discord invite, gold), Step 2 card (Sign in
  with Discord, gold, callback to /join), a closing note card linking the full guide. All three
  links resolve. The page has no h1. L.

### 6. League Hall of Fame [hof-phone, hof-phone-all, hof-phone-champfocus]
- Toggle is two tier-tab links ("Legendary champions" purple-active, "All divisions") with
  aria-current="page"; switching is a full navigation that scrolls to the top. Fine.
- Champion cards are whole-card links to the profile (verified: estrakami -> /profile/...), with
  a gold-tinted shadow on focus. Good.

### 7. Tour [t-*]
- Standings "Show sets and games" (phone only): label flips to "Hide ...", the row gains "Sets
  35-19 (64.8%) . Games 78-58 (57.4%)" under the name; no aria-pressed; not persisted. Fine
  except the naming (finding 7).
- Regular Season weeks: six week chips (links), the active one gold but without aria-current;
  "Week 6" carries a gold dot with a title "Still open" that touch never shows. "Flip sides"
  swaps the two bands in every card, keeps its label and has no pressed state, so after a flip
  there is no sign the order is non-default. Tapping a matchup opens the set list with "Open
  matchup ->" and a collapsed "Stream tools" details (round 3 finding 10 is fixed); the open
  card repeats the two team names once more as a header row. L.
- Team page: hero (name, captain, 5-0 matchups), "Open week: Week 6" link, stat tiles, roster
  table with "More columns" (works, scrolls), roster moves, week-by-week as details. Opening a
  week and following "week 1 ->" lands on /weeks?week=1 at the top with Week 1 active; back
  restores scroll but the details is closed again. L.
- Pick'em logged out: "Sign in with Discord to make picks - see everyone's standing below", a
  sign-in link, Picks / Leaderboards tabs, W1..W6 chips (W5 and W6 carry open counts rendered as
  "W55" / "W633" to a screen reader; aria-label says only "Week 5"), matchup groups with "11 to
  pick"; inside, pick buttons are disabled at 0.75 opacity with "sign in to pick". Clear. L (chips).
- Timeline: one details ("Seed changes on 8 teams") and "Show 3 more weeks"; focus and open
  work. Good.
- Draft: board in a horizontal scroller with "Fit to screen" (aria-pressed true) on the phone and
  "Expand" on desktop; "Stream tools" is a bare summary that reads as a caption; sort controls
  are "v", "sort", "reset" and an icon button labelled "Remove sort". L.
- Stats players: checkbox "Include playoff games", search box (filters as you type; "schn" -> 1
  row; empty state "No players match "zzzzq"."), "Show full stats", table, "Show 50 more players"
  / "Show all 223 players" under a header that says "248 of 511 players" (223 is the remainder;
  after one click it says "Show all 173"). Columns clip on the phone (finding 5). H.
- Stats teams: same shape, "Search teams or seasons...", same clipping. Ten stats tabs.
- Hall of Fame: four shelf cards (selected one gold-edged) that reload the page with ?hofSeason=,
  then the bracket (QF, SF, Final, Champion) and below it three collapsed details that repeat the
  same three rounds. Team names link to team pages. L (duplicate list).
- Season pill: a menu (Team Tour 5 marked with a dot, 4, 3, 2, 1, "All seasons ->"); Enter opens
  with the current row focused, arrows move, Escape closes. Rows have no visible focus (finding 2).

### 8. Loading and empty states [slow-*]
- League /standings on Slow 3G: full HTML at 1.5 s (header, title, tier chips, progress, first
  division); layout shift 0.001; done at 13.4 s. Dates flash ISO then local (finding 8). Avatars
  are black discs until loaded.
- League profile: text at 1.5 s, shift 0, done 12.9 s.
- Tour /weeks: shell at 1.2 s with main 464 px tall and the footer at y=707; at about 6 s the
  section streams in, main grows to 1384 px and the footer jumps off screen (shift 0.162). Fonts
  swap at the same moment (display and body load at 6-7 s). /stats/players: same pattern, shift
  0.175, done 14.2 s.
- Empty states seen: Tour "No standings yet." / "No week-by-week results" paths exist in source;
  Tour stats search empty state is good; league palette "No results." is the only empty state a
  logged-out visitor can reach.

### 9. League phone top bar [topbar-league-phone, topbar-tour-phone]
- Measured: chip 44x44 at x=16, pill 92 px wide showing "Season 9 ..." (text-overflow clip), Menu
  73 px gold, Search 36 px, "Login with Discord" 65 px at 12 px wrapping to two lines; header
  75 px. Tour: chip 72 px, pill "Tour 5" 84 px, Menu 57 px ghost, sign-in glyph 16 px; header 63 px.
- Judgement: the login text is the only two-line element in either header and the Menu already
  has the same row. Proposal: below sm render the LogIn glyph with aria-label "Login with
  Discord" (matching the Tour), keep the text at sm and up. The 50 px saved lets the pill show
  "Season 9 - Truth" or a short name, and the header drops to 63 px like the Tour's.

### 10. Consistency: see section c.

## c. Consistency table

| thing | league | tour | verdict |
|---|---|---|---|
| Brand chip (desktop) | 166x23 label chip with chevron | 44 px tall gold button, bigger glyph | align league to 44 px |
| Brand chip (phone) | icon + chevron, 44x44 | icon + chevron, 72x44 | fine |
| Switcher menu rows | "Now viewing Season 9 - Truth Nuke" / "Team standings and brackets" | "Standings, divisions and seasons" / "Now viewing Team Tour 5" | same pattern; add aria-current |
| Switcher target | tour.balatroleague.com (old shell) | balatroleague.com (new shell) | ship Tour to prod |
| Season pill | link to /seasons/<id>, gold outline box, no chevron | menu button (calendar glyph, chevron) listing every season | decide one behaviour |
| Phone pill text | "Season 9 ..." clipped | "Tour 5" | league needs a short name |
| Search entry (phone) | round button in the bar | row inside Menu | decide one |
| Search entry (desktop) | "Search Ctrl K" pill | "Search Ctrl K" pill | same |
| Search placeholder | "Jump to a player, division, or season..." | "Jump to a player, team, or season..." (ellipsis char) | same shape; league claim is false logged out |
| Search empty state | "No results." | "No results." | same |
| Login (phone) | "Login with Discord" text, wraps | LogIn glyph, no label | glyph on both |
| Login (desktop) | "Login with Discord" muted text | "Sign in" with glyph | pick one verb |
| Menu button (phone) | gold primary "Menu" | ghost "Menu" | league is the louder one; pick one |
| Phone Menu order | switcher, 6 pages, rating toggle, login | switcher, Search, 3 pages | fine (different IA) |
| Desktop nav | Standings, Stats, Hall of Fame, Seasons, How it works, Join | Standings, Stats, Hall of Fame, Rules (+ season sub-nav) | fine |
| Skip link | none | "Skip to content" | add to league |
| Footer links | Join Discord, How it works, Team Tour | (Join Discord if env set), Rules, Balatro League | fine; tour-dev lacks the env |
| Back links | profile "<- Standings"; division "all standings" (hero, lowercase) and "<- all standings" (hidden v1) | team "<- Back to Team Tour 5"; season pages none | one recipe: "<- Standings" style |
| Reveal more columns | "Hide" tab / chevron on divisions | "Show sets and games", "Show full stats", "More columns" | one label on the Tour |
| Toggle semantics | aria-expanded on division buttons | no aria-pressed on any Tour toggle | add |
| Focus ring | browser default double ring; gold only on inputs | same | one gold rule on both |
| Menu row focus | none visible | none visible | fix on both |
| Loading | SSR complete, dates hydrate late | streamed shell, footer jumps | see T6, L4 |
| Console | clean | clean | same |

## d. Ranked backlog

Order: league S/no first, then tour S/no, then larger or decision items. Files are relative to
D:/BalatroLeague/web (league) and D:/wt-tour-burgundy/apps/tour (tour).

| id | change | site | files | size | impact | decision |
|---|---|---|---|---|---|---|
| L1 | Remember division open state per id in sessionStorage so back (and reload) returns to what the player expanded | league | components/CollapsibleDivision.tsx (41-48) | S | H | no |
| L2 | Visible keyboard focus on menu rows: gold 3 px outline on [role=menuitem]:focus-visible and a panel-2 background on data-highlighted | league | components/ui/menu.tsx (67, 80), app/globals.css | S | H | no |
| L3 | Palette placeholder tells the truth logged out ("Jump to a page or division") plus one muted row "Sign in to search players" | league | components/CommandPalette.tsx (115-117, 143) | S | H | no |
| L4 | SeasonWindow passes a UTC-formatted fallback (same formatter as lib/season-window-text.ts) so slow loads never show ISO or a different day | league | components/SeasonWindow.tsx (47), components/LocalDateTime.tsx (57), lib/season-window-text.ts (22) | S | M | no |
| L5 | Phone bar login as the LogIn glyph with aria-label below sm; text stays at sm and up (Menu already has the row) | league | components/SiteNav.tsx (182-184) | S | M | no |
| L6 | One global :focus-visible rule (3 px gold, offset 2) for a, button, summary, matching inputs | league | app/globals.css (754-758) | S | M | no |
| L7 | Skip-to-content link before the header, same class as the Tour's | league | app/layout.tsx, app/globals.css | S | M | no |
| L8 | Division hero title becomes the page h1 (strong.division-name -> h1 with the same classes) | league | app/divisions/[id]/page.tsx (155) | S | M | no |
| L9 | One muted line under "Played": "Wrong score? Press Report a problem on the result post in Discord." | league | app/divisions/[id]/page.tsx (Played section) | S | M | no |
| L10 | How it works: standings link relative (/standings), not the www host | league | lib/onboarding-guide.ts (24-25, 101), the env that feeds standingsUrl | S | L | no |
| L11 | Move the "Something wrong with a result?" card above "Ready?" so the guide ends on the CTA | league | lib/onboarding-guide.ts (card order), app/how-it-works/page.tsx | S | L | no |
| L12 | Keep the open card's header strip the same height as the collapsed chip so expanding does not shift content 27 px | league | app/v2/standings-cards.css, components/CollapsibleDivision.tsx | S | L | no |
| L13 | Avatar box gets a panel-2 background (or initials) behind the img so slow loads show a tile, not a black disc | league | app/v2/standings-cards.css (170-190) | S | L | no |
| L14 | Form pip row gets aria-label as well as title; tie footnote gets a title explaining "net lives" | league | components/DivisionStandingsTable.tsx (260, 539) | S | L | no |
| L15 | Switcher rows carry aria-current="true" on the current product | league | components/ProductSwitcher.tsx (46) | S | L | no |
| L16 | Join page heading as h1 | league | app/join/page.tsx (43) | S | L | no |
| T1 | Stats tables scroll on the phone: drop overflow-x from the table element so .table-scroll scrolls (as the roster table does); add a right-edge fade | tour | app/globals.css (320-330, 236), app/players/PlayersTable.tsx, app/teams/TeamsTable.tsx | S | H | no |
| T2 | Section picker shows "Standings" on the season root instead of "Menu" | tour | lib/section-nav-core.ts (pickerLabel), components/SectionPicker.tsx (30) | S | H | no |
| T3 | Visible keyboard focus on menu rows (switcher, season menu, section picker, Menu) | tour | components/ui/menu.tsx (53, 66), app/globals.css | S | H | no |
| T4 | One label for the reveal toggle everywhere ("More columns" / "Fewer columns") plus aria-pressed | tour | components/MoreColumnsToggle.tsx (13), components/StandingsTable.tsx (100), app/players/PlayersTable.tsx (87), app/teams/TeamsTable.tsx (47), app/seasons/[name]/page.tsx (118) | S | M | no |
| T5 | Loading shell: #main-content min-height of one viewport so the footer never paints above the fold and jumps | tour | app/globals.css (.site-footer, #main-content), app/seasons/[name]/loading.tsx, app/stats/loading.tsx | S | M | no |
| T6 | Week chips: aria-current="page" on the active week; "Flip sides" gets aria-pressed and a "Sides flipped" state label | tour | app/seasons/[name]/weeks/page.tsx (310-316), components/FlipSidesButton.tsx (15-16) | S | M | no |
| T7 | One global :focus-visible rule (3 px gold) for a, button, summary | tour | app/globals.css (619-622) | S | M | no |
| T8 | "Show all N" uses the total ("Show all 248 players"), or "Show the other 223" | tour | components/ShowMore.tsx (75) | S | L | no |
| T9 | Pick'em week chips: count as a separate badge with aria-label "Week 5, 5 open" | tour | app/seasons/[name]/pickem/page.tsx (week chip row) | S | L | no |
| T10 | Hall of Fame: drop the three collapsed round details that repeat the bracket above | tour | app/hall-of-fame/page.tsx (80-110) | S | L | no |
| T11 | Week card open state: remove the repeated "A vs B" header row inside the opened matchup | tour | app/seasons/[name]/weeks/page.tsx (matchup details body) | S | L | no |
| T12 | Draft board controls get words: "Stream tools" as a chevron summary, sort buttons labelled "Sort by", "Reset sort" | tour | components/DraftBoardTable.tsx (990-1010), components/ScrollableBoard.tsx (43) | S | L | no |
| T13 | Open-week dot on week chips gets visible text ("open") instead of a title-only dot | tour | app/seasons/[name]/weeks/page.tsx (310-316), app/globals.css (.wk-tab-open) | S | L | no |
| T14 | Set NEXT_PUBLIC_DISCORD_INVITE_URL on tour-dev and prod so the footer shows Join Discord like the league | tour | components/SiteFooter.tsx (8), deploy env | S | M | no (env) |
| S1 | Deploy the Tour preview to tour.balatroleague.com so the league switcher lands on the shared shell | tour | deploy | S | H | yes (release) |
| S2 | League desktop brand chip at the Tour's 44 px size and glyph | league | components/ProductSwitcher.tsx (26-39), app/globals.css (.brand, .ps-*) | S | M | no |
| S3 | Season pill: same behaviour on both (league gets the seasons menu, or the Tour pill links to the season page) | both | components/SeasonPill.tsx; apps/tour/components/SeasonsMenu.tsx | M | M | yes |
| S4 | Search entry on the phone: bar button on both, or Menu row on both | both | components/CommandButton.tsx (28-34), SiteNav.tsx; apps/tour/components/MoreMenu.tsx (106), app/layout.tsx | S | M | yes |
| S5 | Phone Menu button weight: ghost on both (league currently gold primary) | league | components/SiteMobileMenu.tsx trigger classes | S | L | yes |
| S6 | Login verb: "Login with Discord" vs "Sign in"; pick one for both desktops | both | components/SiteNav.tsx (182); apps/tour/app/layout.tsx (sign-in link) | S | L | yes |
| S7 | Public player search in the league palette (names are public on /standings already) | league | app/api/command-context/route.ts (27-28), components/CommandPalette.tsx | S | H | yes (privacy posture) |
| S8 | www.balatroleague.com 301 to the apex | league | infra (proxy) | S | L | no |
| M1 | Division page "Played" cards link to a match view (or the two profiles) and show the date | league | app/divisions/[id]/page.tsx, new match route | M | M | yes (what to show) |
| M2 | Team page week details remembered across back (open state in the URL hash) | tour | app/teams/[id]/page.tsx | S | L | no |
