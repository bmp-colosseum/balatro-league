---
date: 2026-10-12
confidence: high for every number and screenshot (Playwright chromium, logged out, 390x844 phone emulation and 1280x900 desktop, every screenshot inspected by eye); medium for file/line root causes named from source without running the code
sources:
  - https://balatroleague.com/ (serves /standings)
  - https://balatroleague.com/standings
  - https://balatroleague.com/seasons
  - https://balatroleague.com/seasons/cmuojr51o00pus301qxbujo56 (Season 9, active)
  - https://balatroleague.com/seasons/cmt9wdsj20005pa01m787gjuh (Season 8, finished)
  - https://balatroleague.com/seasons/cmpstvqis0000s12uu8imuqj4 (Season 1, oldest)
  - https://balatroleague.com/divisions/cmuyvr3mo002onl01pk981pme (Legendary)
  - https://balatroleague.com/divisions/cmuyvr3mt002qnl01scisol0p (Rare 1)
  - https://balatroleague.com/divisions/cmuyvr3n4002ynl01fq91qtwr (Uncommon 1)
  - https://balatroleague.com/divisions/cmuyvr3nf003cnl01e2m9ywzs (Common 4)
  - https://balatroleague.com/profile/cmqhccddq0008qs4zsayjvzi8 (hiker, active, +10 lives)
  - https://balatroleague.com/profile/cmpuxnf380000ok2urzcuo36m (Melon, -8 lives)
  - https://balatroleague.com/profile/cmpsuceyz0000p82uk2n2xy7f (estrakami, three-time champion)
  - https://balatroleague.com/profile/cmsypgm06002no101ln58fy35 (baconisbets, 0 played this season)
  - https://balatroleague.com/hall-of-fame and ?all=1
  - https://balatroleague.com/stats
  - https://balatroleague.com/traits
  - https://balatroleague.com/join
  - https://balatroleague.com/how-it-works and /how-to-play (redirects there)
  - https://balatroleague.com/auth/signin, /me, /report, /players (all land on sign-in)
  - https://balatroleague.com/changes, /preferences, /no-such-page-xyz, /seasons/doesnotexist, /divisions/doesnotexist, /profile/doesnotexist (404 states)
---

# Round 5 (League): the pages rounds 1-4 skipped, plus archive, profile and division variants

Scope: every public route under web/app (17 page.tsx files, admin dropped), logged out, at
390x844 and 1280x900. Rounds 2-4 backlogs (ux-cohesion L1-L23, ux-round3 R1-R15, ux-round4
L1-L16) were read first; open rows there are referenced by id and not repeated. What shipped
since round 4 and shows here: the product switcher, the season pill and the footer are on
every page; the collapsed-division summary rows and the small Hide chip; gold Join buttons
with no overlap; the "Ready? Join the league" closer; "Wrong score?" under Played; the
LogIn glyph in the phone bar; the Lucide 404 button.

Routes that turned out not to be public pages: /players, /report and /me redirect to sign-in;
/changes returns 404 for non-admins (it is an admin-only draft); /how-to-play redirects to
/how-it-works; /preferences has no page. 404 states are branded on every miss.

## a. Ten headline findings

1. **One browser title for the whole site.** Every page but How it works has `<title>Balatro
   League</title>` (app/layout.tsx:47 is the only title; no page sets metadata). A profile, a
   division, a season archive, Stats and the Hall of Fame are indistinguishable in tabs,
   history, bookmarks and shared links. H.
2. **The season archive is a second, poorer drawing of the standings.** /seasons/[id] shows
   two-letter initials where /standings shows avatars, black rank tiles where /standings and
   /divisions use tier-coloured ones, and for the active season every Legendary player is
   "1" with a "0 PTS" tile where /standings prints dashes and NONE PLAYED. On desktop it is
   one full-width column (8,978-10,103 px) while /standings is a two-up grid. R13 covers only
   the phone collapse. H.
3. **Sign-in ignores where you came from.** /report and /players redirect to
   /auth/signin?from=/report, but the page never reads `from` and the server action always
   sends you to /me (app/auth/signin/page.tsx:8); /me's own redirect drops the param
   (app/me/page.tsx:21). The page is also off-system: a blurple button, "Sign in" heading
   versus "Login with Discord" button versus "Login with Discord" in the bar. M.
4. **Traits is an orphan page drawn with emoji.** The only way in is an 18 px "All traits"
   link on profiles (components/ProfileView.tsx:571); it is in no nav or footer. The heading
   is "(mask emoji) Traits", three of four trait icons and every "How to earn" marker are emoji
   (11 on the page; MASTER.md says none), holders are a 53-name comma paragraph with no
   profile links, and "as long as its on white stake" has a typo. M.
5. **The brand chip is the h1 on every page.** components/SiteNav.tsx:60 renders the wordmark
   as h1, so every page heading is an h2, and three pages (division, Join, How it works) now
   carry a second h1. Screen-reader and outline users get "Balatro League" as the page name
   everywhere. M.
6. **Stats rank markers disagree inside one list.** The top-5 panels use a gold tile for 1
   and plain tiles for 2-3, then faint "4." and "5." text (app/stats/page.tsx:126-134);
   Streaks uses "1." for all five. On phone the Streaks table is 240 px wide inside a 342 px
   panel, leaving the right third empty. Section headings say "Decks & stakes" then
   "Deck + stake combos". M.
7. **Profile dates and separators are from another site.** Match history prints "2026-10-12 -
   Season 9 - Truth Nuke - Rare 1" via toISOString (components/ProfileView.tsx:261, 927) while
   every other page says "Oct 12, 2026"; the career line is "7 seasons - 41 pts - 10W 11D 3L"
   with spaced hyphens where the seasons list uses middle dots. On phone each season-history
   card is 128 px for three numbers (7 cards = 900 px before the matches). M.
8. **Three phone wraps.** "Uncommon 1" breaks its number onto a second line under the
   UNCOMMON chip on /standings; "<- all seasons" wraps to two lines beside the long Season 9
   name on /seasons/[id]; the standings h2 is the two-em-dash "Season 9 - Truth Nuke -
   Standings" across two lines. M.
9. **Tap targets: the row is not the link.** Player names on standings, season and division
   cards are 16 px tall anchors inside 60 px rows (a.player-card-name); division hero links
   are 23 px; profile season (21 px), opponent (18 px) and All traits (18 px) links; tier
   tabs and Hall of Fame toggles 36 px. Under-44 counts at 390: standings 29, season pages
   86-100, divisions 32-44, profiles 12-43. M.
10. **Document weight.** /standings is 826 KB of HTML (59 KB gzipped) for 87 players: each
    player appears in more than one row layout (344 player-card-name and 172
    standings-card-name anchors) and the whole tree is repeated in the RSC payload. Profiles
    are 741-792 KB with 239-264 deck/stake sprite images and 6,294 sub-12 px text nodes
    inside the closed "Deck and stake stats" disclosure. Season archives are 817 KB. M.

## b. Page-by-page notes

Severity: H costs a visitor time or trust on most visits; M is visible friction; L is polish.
Numbers are phone / desktop unless stated. Overflow was 0 px on every page at both sizes;
console was clean except the expected 404 resource line on 404 pages.

### Shell (every page) [shots: *-phone.png top strip]
- Switcher, season pill, Menu, search, LogIn glyph on phone; six pills, search, gear, login on
  desktop; footer with three links everywhere, pinned to the bottom on short pages. Good.
- Title: "Balatro League" on 29 of 31 routes (finding 1). The /changes 404 carries the hidden
  page's own title "Multiplayer changes - Balatro League" (app/changes/page.tsx:22), the one
  place a 404 names the page it refuses to show. L.
- h1 is the brand chip (finding 5).

### /standings (= /) [standings-phone.png, crops/st-phone-1..3.png, standings-desk.png]
- 4,592 / 5,849 px; 29 / 115 small targets; 120 / 291 sub-12 px nodes (tier counts, Key,
  Hide, matches chips, the 11 px meta line "5 players . 1 down . round robin, play
  everyone").
- "Uncommon 1" wraps its "1" under the chip (finding 8). "Common 1" fits.
- The KEY disclosure is an 11 px uppercase word with no chevron or outline, inside the
  progress panel; nothing says it opens. M.
- Player names are 16 px anchors in 60 px rows (finding 9).
- 826 KB HTML (finding 10).
- Still open from earlier rounds, seen again: Legendary single card leaves the right half of
  the desktop grid empty (L18), KEY does not explain pips or hearts (R9).

### /seasons [seasons-phone.png, crops/seasons-desk-y0.png]
- 1,626 / 1,542 px; 0 / 11 small targets; 9 / 10 tiny (the ACTIVE and FINISHED pills).
- Clean. Each card is a whole-card link with no affordance (no chevron, no hover change);
  nothing distinguishes it from a static panel. L.
- Still open: L20 (active season hero, finished seasons two-up).

### /seasons/[id]: Season 9 active, Season 8 finished, Season 1 oldest [crops/s9-phone-y*.png, crops/s8-phone-y*.png, crops/s1-phone-y*.png, season-8-finished-desk.png]
- 9,171 / 8,978 px (S9), 9,794 / 9,340 (S8), 9,826 / 10,103 (S1); 86-130 small targets;
  199-417 tiny nodes (initials at 11 px, "pts" at 9 px, lives at 11 px).
- Second drawing of the standings (finding 2): initials "ES", "JE" instead of avatars; black
  rank tiles; Season 9 shows every Legendary player as rank 1 with 0 PTS and no NONE PLAYED.
- "<- all seasons" wraps on phone next to "Season 9 - Truth Nuke" (finding 8); it is a
  23 px link.
- Tier name printed twice ("Legendary" h3 then "Legendary" card title) and 15 divisions fully
  expanded on phone: R13, still open.
- Finished seasons have no champion marker on the winning row: still open from round 3 notes.
- Season 1 has a division named "Common A (1)" among "Common 1..6": a data artefact that
  reads as a typo on the archive and on the Hall of Fame. L.
- 817 KB HTML (finding 10).

### /divisions/[id]: Legendary, Rare 1, Uncommon 1, Common 4 [div-*-phone.png, crops/div-rare1-*.png, div-rare1-desk.png]
- 1,569-2,282 / 1,119-1,455 px; 32-44 / 43-55 small targets; 17-46 / 18-34 tiny.
- Hero: "Season 9 - Truth Nuke" and "all standings" are 23 px links; the meta line
  "6 players . 1 up . 1 down . 4 opponents" is 11 px. The roster chip row (34 px chips) is
  still there: L19 open.
- Legendary zero-state matches /standings (dashes, NONE PLAYED, "Drops" legend). Good.
- h1 is now the division name (L8 shipped) but the page also still has an h2 with the same
  text and the brand h1 above it (finding 5).
- Tie notes use typed " -- " ("tied on points -- total net lives decided it"). L.
- "Still to play" and "Played" are clear; 10 vs-cards stack at 53 px on phone. Good.

### /profile/[id]: hiker (active, +10), Melon (-8), estrakami (champion), baconisbets (0 played) [crops/profile-*-phone-y*.png, crops/profile-hiker-active-desk-y*.png, profile-bacon-unplayed-phone.png]
- 1,553-2,485 / 1,248-1,751 px; 12-43 / 33-84 small targets; 36 visible tiny nodes (10 px
  RANK/POINTS/RECORD/NET LIVES labels, "Per deck. Min 5 games.") plus 6,294 inside the closed
  Deck and stake stats.
- ISO match dates and hyphen career line (finding 7).
- Season history: full cards per season on phone (128 px each); desktop 5-up grid with two
  orphans on the second row. A compact row per season (season, division chip, place, pts)
  would halve the phone page. M.
- The hero edge takes the current tier colour (red for Rare, purple for Legendary) and the
  plain panel edge when the player is not in the active season (estrakami). Nothing explains
  the colour; fine once learned. L.
- baconisbets: "Match history: None played this season." then "Show all seasons (8 more
  matches)". Good empty state.
- "picks & bans" summaries are blurple link colour: L9 open. Hero centred 360 px on desktop:
  L17 open. "Rare x4" sticker unexplained: round 3 note, open.
- 741-792 KB HTML, 239-264 images (finding 10).

### /hall-of-fame and ?all=1 [hof-phone.png, hof-desk.png, crops/hofall-phone-y*.png, crops/hof-all-desk-y0.png]
- Legendary view 1,144 / 900 px; All divisions 13,102 / 3,524 px; 2 / 13 small targets
  (the two 36 px toggles); 10-98 tiny (x3 stickers).
- Legendary shelf is good at both sizes.
- All divisions on phone: each champion is a half-width card in a one-column list, right half
  empty, 13,102 px for 112 titles. Round 3 noted it as "prior item, still open" but no
  backlog row exists; see L37. H on phone.
- Two headings in the outline ("(trophy emoji) Hall of Fame" then "Hall of Fame"): round 3 note, open.
- Detection found no .card panel; the shelves use their own hof-* classes but draw the same
  hard-shadow panel. Counted as yes in the table.

### /stats [crops/stats-phone-y*.png, crops/stats-desk-y*.png]
- 3,391 / 3,288 px; 0 / 27 small targets; 64 / 65 tiny ("(dot) active", PLAYER/STREAK headers,
  panel subtitles).
- Rank markers (finding 6). Streaks table narrow on phone (finding 6). "Decks & stakes" vs
  "Deck + stake combos" (finding 6).
- Deck and stake ban-rate bars are all rare red at 67-94 %, so 23 bars look alike; the number
  does the work. L.
- Desktop top-5 panels still full width with the count 900 px from the name: L13 open.
- "(dot) active" after every streak: round 3 note, open.

### /traits [traits-phone.png, traits-desk.png]
- 1,624 / 982 px; 0 / 110 small targets (desktop counts the 110 inline-name spans as
  non-targets; they are plain text); 0 tiny.
- Orphan page, emoji icons, unlinked holder paragraph, "its" typo (finding 4). One holder name
  contains window-control glyphs ("Club Penguin _ [] X"): data, but it shows the list is raw
  Discord display names.
- The subtitle "Start showing up after 10 games" and "After 10+ games" repeat on every card.
  L.

### /join [join-phone.png, join-desk.png]
- 949 / 900 px; 0 / 13 small targets; 0 / 1 tiny. Gold buttons, no overlap: R7 shipped.
- Join page heading is an h1 now (L16 shipped) alongside the brand h1 (finding 5).
- The closing box still repeats How it works in one sentence plus the link: acceptable.

### /how-it-works (and /how-to-play) [crops/how-it-works-phone-y*.png, crops/how-it-works-desk-y0.png]
- 2,992 / 2,031 px; 0 / 16 small targets; 1 / 2 tiny (the eyebrow). /how-to-play redirects
  here. Title is correct on this page only.
- Closing "Ready? Join the league" card shipped (R6). Date mismatch with /standings persists
  ("Started Oct 7 ... Ends around Oct 21" vs "Oct 8 to Oct 22"): R1 open.
- "Use Hammertime ( hammertime.cyou)" and "support channel ( open in Discord)" break the line
  after the opening parenthesis on phone, leaving "(" orphaned. L.
- Copy uses typed " -- " in three cards. L.

### /auth/signin (also where /me, /report, /players land) [signin-phone.png, signin-desk.png]
- 844 / 900 px; 0 / 12 small targets. Blurple button, lost `from` (finding 3). No sentence
  says what signing in unlocks for the page you came from.

### 404 states: /no-such-page-xyz, /seasons/x, /divisions/x, /profile/x, /changes, /preferences [404-random-phone.png, 404-random-desk.png]
- All six return HTTP 404 with the shell, the gold "Back to standings" button and footer.
  Good. "Join the league ->" and "Team Tour ->" are text links with ASCII arrows beside a
  Lucide-arrow button: R10 half shipped. L.
- The /changes 404 carries the hidden page's title (shell note above).

## c. Consistency table

| page | switcher | season pill | footer | rank tiles | zebra | Card Table panel |
|---|---|---|---|---|---|---|
| /standings | yes | yes | yes | yes (tier colour) | n/a (cards) | yes |
| /seasons | yes | yes | yes | n/a | n/a | yes |
| /seasons/[id] | yes | yes | yes | yes (black, not tier) | n/a (cards) | yes |
| /divisions/[id] | yes | yes | yes | yes (tier colour) | n/a (cards) | yes |
| /profile/[id] | yes | yes | yes | no (stat tile only) | no (deck tables: lines, no stripes) | yes |
| /hall-of-fame | yes | yes | yes | n/a | n/a | yes (own hof-* classes) |
| /hall-of-fame?all=1 | yes | yes | yes | n/a | n/a | yes (own hof-* classes) |
| /stats | yes | yes | yes | partial (1-3 tiles, 4-5 text, streaks "1.") | no (lines only) | yes |
| /traits | yes | yes | yes | n/a | n/a | yes |
| /join | yes | yes | yes | n/a | n/a | yes |
| /how-it-works | yes | yes | yes | n/a | n/a | yes |
| /auth/signin | yes | yes | yes | n/a | n/a | yes (blurple button inside) |
| 404 (all six) | yes | yes | yes | n/a | n/a | yes |

Page title: correct on /how-it-works only. h1: brand chip on every page; page-level h1 only
on /divisions/[id], /join, /how-it-works (so those have two).

## d. Ranked backlog

Size: S one file, under an hour; M two to four files, half a day; L cross-cutting.
Needs-user-decision: yes when the organiser must pick wording or behaviour first. S/no first.

| id | page | problem | fix | size | needs-user-decision |
|---|---|---|---|---|---|
| L30 | every page | One `<title>` for the whole site (finding 1) | Add generateMetadata per route: "hiker - Balatro League", "Rare 1 - Season 9", "Season 8", "Stats", "Hall of Fame", "Seasons", "Join", "Sign in", "Traits"; keep the 404 on the layout default (app/layout.tsx:47 plus each page.tsx) | S | no |
| L31 | /auth/signin | `from` is dropped and the action always redirects to /me (finding 3) | Read searchParams.from, pass it as redirectTo when it is a same-origin path, and make /me's redirect pass from=/me (app/auth/signin/page.tsx:8, app/me/page.tsx:21) | S | no |
| L32 | /auth/signin | Blurple button and three wordings for one action | Gold primary button; heading and button both "Sign in with Discord"; one muted line "You will come back to <page>" when from is set | S | no |
| L33 | /seasons/[id] | Active season shows rank 1 and 0 PTS for every unplayed row | Pass the same noMatchesYet flag the division page uses so dashes and NONE PLAYED appear (app/seasons/[id]/page.tsx, components/DivisionStandingsTable.tsx) | S | no |
| L34 | /seasons/[id] | Initials and black rank tiles where /standings has avatars and tier tiles | Load avatar URLs for archive rows and pass the tier colour to the rank tile; same component, same props | S | no |
| L35 | /stats | Rank markers 1-3 tiles then "4." "5."; Streaks "1."; Streaks table 240 px wide on phone; "Decks & stakes" vs "Deck + stake combos" | Plain tiles for 4-5 and in Streaks; table width 100 % on phone; "Decks and stakes" / "Deck and stake combos" (app/stats/page.tsx:126-134 and the streaks table) | S | no |
| L36 | /profile/[id] | ISO match dates; hyphen separators in the career line | Format with the shared LocalDateTime/date helper ("Oct 12, 2026"); middle dots in the career line (components/ProfileView.tsx:261, 927, career summary) | S | no |
| L37 | /hall-of-fame?all=1 | Phone: half-width champion cards in one column, 13,102 px | Two-up grid at 390 (or full-width rows); each season shelf collapsible with the champion count in the header (app/v2/hall-of-fame.css, app/hall-of-fame/page.tsx) | S | no |
| L38 | /standings | "Uncommon 1" wraps its number under the chip on phone | white-space: nowrap on the division name; let the chip wrap to the next line instead (app/v2/standings-cards.css, division header) | S | no |
| L39 | /seasons/[id] | "<- all seasons" wraps beside the long season name on phone | Move the back link above the title (same slot as "<- Standings" on profiles) and give it min-height 44 px (app/seasons/[id]/page.tsx:164) | S | no |
| L40 | /standings | KEY disclosure has no affordance | Chevron plus "Key" in body size; same treatment as the Hide chip (app/standings/page.tsx:231) | S | no |
| L41 | /traits | Holder names are an unlinked paragraph; "its" typo; "After 10+ games" repeated per card | Link each name to /profile/[id]; "it's"; say the 10-game rule once in the intro (app/traits/page.tsx) | S | no |
| L42 | /how-it-works, /divisions/[id] | Typed " -- " dashes; "(" orphaned before a link at a line break | Real dashes or a colon; keep "(" with the link via a non-breaking space or drop the parentheses ("Use Hammertime: hammertime.cyou") (lib/onboarding-guide.ts, tie-note text in lib/standings-cards-core.ts) | S | no |
| L43 | 404 | Text links with ASCII "->" beside a Lucide-arrow button; /changes 404 carries the hidden page's title | Lucide ArrowRight in both text links; drop the metadata export from the admin-only draft until it ships (app/not-found.tsx, app/changes/page.tsx:22) | S | no |
| L44 | /seasons | Whole-card links with no affordance | Chevron at the right edge and a panel-2 hover, matching the collapsed division rows (app/seasons/page.tsx:30) | S | no |
| L45 | every page | Brand chip is the h1; page headings are h2; three pages have two h1s | Brand becomes a span/div; each page's heading becomes its h1 (components/SiteNav.tsx:60, then each page's top heading) | M | no |
| L46 | /standings, /seasons/[id], /divisions/[id] | Player name is a 16 px anchor inside a 60 px row | Make the whole row the link (or stretch the anchor with an ::after overlay) and keep the name as the accessible text (components/DivisionStandingsTable.tsx:585, app/v2/standings-cards.css) | M | no |
| L47 | /profile/[id] | Season-history cards are 128 px each on phone; two orphans on desktop | Compact rows on phone (season, tier chip, place, pts on one line); 4-up grid on desktop so 7 seasons fill two rows (components/ProfileView.tsx, app/v2/profile.css) | M | no |
| L48 | /seasons/[id] | Desktop is one full-width column, 9-10k px | Reuse the standings two-up grid and the CollapsibleDivision summary (extends R13 to desktop) (app/seasons/[id]/page.tsx) | M | no |
| L49 | /traits | Orphan page; emoji heading and icons | Add "Traits" to the gear menu and the Stats page intro; Lucide or sprite icons; plain "Traits" heading (app/traits/page.tsx, components/SiteNav.tsx) | M | yes (where Traits lives in the nav) |
| L50 | /standings, /seasons/[id] | 826 KB HTML: each player row rendered in several layouts, then repeated in the RSC payload | Render one row layout per breakpoint via CSS, not duplicate markup; lazy-load avatars (R8) (components/DivisionStandingsTable.tsx) | M | no |
| L51 | /profile/[id] | 741-792 KB HTML; 239-264 sprite images and 6,294 tiny nodes inside a closed disclosure | Render Deck and stake stats on open (client component or a /profile/[id]/decks route); cap sprite images to the visible matches (components/ProfileAnalyticsSection.tsx, ProfileView.tsx) | M | no |
| L52 | /stats | 23 ban-rate bars all rare red at 67-94 %, no spread | Scale the bar to the pool's min-max or colour by tercile; or drop the bar and keep the number | S | yes (chart meaning) |
| L53 | /seasons/[id], /hall-of-fame | Division named "Common A (1)" in Season 1 | Rename the division in the database (admin) or display-map it to "Common A" | S | yes (data edit) |

Counts: 16 S, 7 M, 0 L. 3 need a decision.

## Screenshots

Folder: C:/Users/micha/AppData/Local/Temp/claude/C--Users-micha/74accfae-f427-461c-adb3-51832c5ea65f/scratchpad/r5/
Metrics: r5/metrics.json (31 routes x 2 viewports: status, final URL, overflow, height, small
targets, tiny text, console, shell flags). Scripts: r5/audit.js, r5/probe.js, r5/probe2.js,
r5/scrollshots.js, r5/crop.js.

Full pages (shots/, phone is fullPage when under 6,000 px, desktop when under 4,000 px):
404-random-desk.png 404-random-phone.png changes-hidden-desk.png changes-hidden-phone.png
div-404-desk.png div-404-phone.png div-common4-desk.png div-common4-phone.png
div-legendary-desk.png div-legendary-phone.png div-rare1-desk.png div-rare1-phone.png
div-uncommon1-desk.png div-uncommon1-phone.png hof-all-desk.png hof-all-phone.png
hof-desk.png hof-phone.png home-desk.png home-phone.png how-it-works-desk.png
how-it-works-phone.png how-to-play-redirect-desk.png how-to-play-redirect-phone.png
join-desk.png join-phone.png me-gated-desk.png me-gated-phone.png players-gated-desk.png
players-gated-phone.png preferences-desk.png preferences-phone.png profile-404-desk.png
profile-404-phone.png profile-bacon-unplayed-desk.png profile-bacon-unplayed-phone.png
profile-estrakami-champ-desk.png profile-estrakami-champ-phone.png
profile-hiker-active-desk.png profile-hiker-active-phone.png profile-melon-neglives-desk.png
profile-melon-neglives-phone.png report-gated-desk.png report-gated-phone.png
season-1-oldest-desk.png season-1-oldest-phone.png season-404-desk.png season-404-phone.png
season-8-finished-desk.png season-8-finished-phone.png season-9-active-desk.png
season-9-active-phone.png seasons-desk.png seasons-phone.png signin-desk.png
signin-phone.png standings-desk.png standings-phone.png stats-desk.png stats-phone.png
traits-desk.png traits-phone.png

Crops and scrolled viewports (crops/):
div-common4-phone-y0.png div-common4-phone-y1100.png div-rare1-desk-y0.png
div-rare1-phone-y0.png div-rare1-phone-y1000.png hof-all-desk-y0.png hofall-phone-y0.png
hofall-phone-y800.png hofall-phone-y6000.png hofall-phone-y12300.png
how-it-works-desk-y0.png how-it-works-phone-y0.png how-it-works-phone-y1000.png
how-it-works-phone-y2000.png profile-estrakami-champ-phone-y0.png
profile-estrakami-champ-phone-y1000.png profile-hiker-active-desk-y0.png
profile-hiker-active-desk-y900.png profile-hiker-active-phone-y0.png
profile-hiker-active-phone-y900.png profile-hiker-active-phone-y1800.png
profile-melon-neglives-phone-y0.png s1-phone-y0.png s1-phone-y900.png s8-phone-y0.png
s8-phone-y900.png s8-phone-y4500.png s8-phone-y9000.png s9-phone-y0.png s9-phone-y900.png
s9-phone-y8400.png seasons-desk-y0.png st-phone-1.png st-phone-2.png st-phone-3.png
stats-desk-y0.png stats-desk-y1000.png stats-phone-y0.png stats-phone-y1100.png
stats-phone-y2300.png
