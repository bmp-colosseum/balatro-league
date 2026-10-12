---
date: 2026-10-12
confidence: high for everything rendered (both sites shot logged-out at 390x844 full-page and 1280x900 with Playwright, every PNG inspected); medium for root causes named from source without running the code
sources:
  - https://balatroleague.com (/, /standings, /divisions/cmuyvr3mo002onl01pk981pme, /profile/cmsypgm06002no101ln58fy35, /hall-of-fame, /hall-of-fame?all=1, /seasons, /seasons/cmt9wdsj20005pa01m787gjuh, /stats, /join, /how-it-works, 404)
  - https://tour-dev.balatroleague.com (/ -> /seasons/Team Tour 5, .../players, .../weeks, .../pickem, .../timeline, .../awards, .../draft, /teams/cmt0z67tv001jko3uzqz9cgat, /players/cmqzblpld001wrq4bduxcd856, /stats/players, /stats/teams, /stats/records, /stats/steals, /stats/rookies, /hall-of-fame, /rules, /seasons, 404)
  - https://tour.balatroleague.com (old look, / and the same team page, for before/after)
  - D:/BalatroLeague/design-system/MASTER.md
  - D:/BalatroLeague/web: app/**/page.tsx, components/SiteNav.tsx, SiteMobileMenu.tsx, CollapsibleDivision.tsx, DivisionStandingsTable.tsx, ProfileView.tsx, CommandPalette.tsx, lib/nav-links.ts, lib/season-window-text.ts, lib/onboarding-guide.ts, app/not-found.tsx
  - D:/wt-tour-burgundy/apps/tour: app/layout.tsx, app/globals.css, components/MoreMenu.tsx, ProductSwitcher.tsx, SeasonNav.tsx, SiteFooter.tsx, FitText.tsx, ShowMore.tsx, app/seasons/[name]/**/page.tsx, app/teams/[id]/page.tsx, app/stats/**/page.tsx, app/players/PlayersView.tsx
  - prior audits (items not repeated here): .claude/knowledge/ux-audit/01-findings.md, .claude/knowledge/ux-cohesion/01-findings.md
screenshots: D:/BalatroLeague/.claude/knowledge/ux-round3/shots/ (league-*, tour-*, tourprod-* full pages; crop-* are 2x zooms and opened menus); raw numbers in ../metrics.json
---

# Round 3: both sites on the Card Table look

Method: 12 league pages and 19 tour pages shot at 390x844 (full page) and 1280x900, plus the
old-look prod Tour for comparison. Per page I measured horizontal overflow, tap targets under
44px, text under 12px, contrast of every text/background pair from computed styles, bytes and
request counts, and console errors. Judged as a first-time player, a returning player asking
"what do I do next", and a spectator.

Hard numbers first, because they frame everything else:

| measure | league | tour |
|---|---|---|
| horizontal overflow, any page | 0px | 0px |
| console errors | none (only the 404 fetch on the 404 page) | none (same) |
| heaviest page | /standings 2.5 MB, 116 requests (87 Discord avatars) | /stats hub 2.3 MB, 76 requests |
| typical page | 1.0 to 1.4 MB, 25 to 60 requests | 1.0 to 1.4 MB, 23 to 50 requests |
| tallest phone page | /hall-of-fame?all=1 12,862px; /seasons/<id> 9,554px | /players/<id> 7,556px; /stats/records 8,566px; /rules 7,347px; season players 6,537px |
| text under 12px | 11px eyebrows and chips everywhere; 10px stat labels on profile; 9px "pts" on season rows | 11.5px standings second line (240 nodes on desktop); draft board names shrink to 6.9px |
| contrast pairs under 4.5:1 | paper-faint on panel 3.63:1 (every "None played", subtitle, table header); paper-faint on panel-2 3.05:1 (counts in tier chips, "lives" labels); tier colours as text on panel-2 3.2 to 3.5:1 | same faint pair 3.63 / 3.05; "Team Tour" brand label paper-on-gold 1.59:1; team names on light team colours down to 1.03:1 (localdunk, Planet Freaking Earth on /weeks) |

## a. Ten headline findings

1. The Tour port is real and it works. Side by side with prod, the new Tour reads as the league's
   sibling: felt ground, hard-shadow panels, Jersey 10 titles, gold season pill, footer. The
   phone standings went from a 7-column table with wrapped team names to one card per team.
   [shot: tourprod-home-desk.png vs tour-home-desk.png; tourprod-home-phone.png vs tour-home-phone.png]
2. The Tour ground is navy, not the burgundy MASTER.md specifies. globals.css sets --felt to
   #1c2a4a while the design system says #4a1d24. Either the doc or the app is wrong, and the
   green-grey league panels (#26383a) now sit on a blue ground, which reads slightly off. Needs
   the organiser's call before anyone "fixes" it either way.
3. The league has no way to reach the Tour. The Tour's brand chip opens a two-row switcher
   ("Balatro League / Team Tour") and its footer links back, but balatroleague.com has zero
   links to tour.balatroleague.com on any public page (checked the DOM). A spectator who lands
   on the league cannot discover the Tour exists. [shot: crop-tour-brand-open-desk.png vs
   league-standings-desk.png]
4. Three small things look broken on the Tour header. (1) A dark bar peeks out under the phone
   "Menu" label: the menu trigger is bg-transparent but inherits the global button hard shadow.
   (2) The desktop "Team Tour" brand label is paper text on the gold chip, 1.59:1, barely
   legible. (3) "Standings" appears twice in the chrome (header pill and sub-nav first tab) and
   a third time as the h1 "Team Tour 5" says what the season pill already says.
   [shot: crop-tour-home-phone-top.png, tour-home-desk.png]
5. The Tour /stats/records page is unreadable on a phone: in every list the player name is drawn
   above its row, clipped by the row above, because the compact-phone two-line name clamp
   (display: -webkit-box) collides with table-dense row heights. 8,566px of it.
   [shot: crop-tour-records-phone-mid.png]
6. The league's standings page on a phone is now a column of gold bars. Every collapsed division
   is a full-width gold Jersey 10 button ("Rare 2 - leader Birb 3 pts - 2/10 played"), the same
   weight as the primary CTA, twelve times down the page; the open card carries a 40px gold strip
   whose only content is the word HIDE. Finding your division works; the page no longer has a
   hierarchy. [shot: crop-league-standings-rare1-phone.png, crop-league-standings-phone-top.png]
7. The league's How it works page and the standings disagree on the season dates. The guide says
   "Started October 8, 2026. Ends around October 22, 2026"; /standings and /seasons say "Runs
   Oct 7, 2026 to Oct 21, 2026". The guide formats on the server (season-window-text.ts) and the
   standings format client-local (SeasonWindow.tsx LocalDateTime), so UTC-evening timestamps slip
   a day. A new player reading both will think one is stale.
   [shot: league-how-it-works-desk.png vs league-standings-desk.png]
8. The design system's own muted text fails its own rule. MASTER.md requires paper-faint on panel
   at 4.5:1 or better; the tokens give 3.63:1 on panel and 3.05:1 on panel-2, and both sites use
   that pair for every subtitle, table header, "None played", "Sets 61.1%" line and tier-chip
   count. One token change (paper-faint to about #93a3a0 gives 4.6:1 on panel) fixes 30-plus
   call sites on both sites at once.
9. The Tour standings second line ("Sets 61.1%  Games 58.5%  33-21 sets . 76-54 games") is
   readable at 2x but is 11.5px, 3.63:1, and gives each team three unlabeled percentages (the big
   tile's 80.0% is matchup %, unlabeled). On the phone the raw counts hide behind a button still
   called "More columns" on a page that has no columns. [shot: crop-tour-home-desk-2x.png,
   crop-tour-home-phone-morecols.png]
10. Spectator tools leak into the public UI on the Tour. Tapping a week matchup on a phone reveals
    "Open matchup ->", "Matchup overlay", "Great Stake Spectacle overlay" and "Bovine Battalion
    overlay" to anyone, before the set list; the team page has "Team overlay" in the hero. These
    are stream-overlay copy-link buttons; a spectator reads them as navigation and gets a blank
    overlay page. [shot: crop-tour-weeks-expanded-phone.png, tour-team-desk.png]

Things that are good and should be left alone: the Tour week matchup cards and the gold clinch
stripe; the Tour Hall of Fame (cards plus bracket) on both sizes; the Tour awards empty state
(icon, one line, one sentence); the league 404 and Tour 404 both branded with the nav; the search
palette on both sites (same shape, same grouping, Ctrl K); the Tour phone Menu, which now puts
the product switcher first; the league Seasons list with the champion line; the league Hall of
Fame "Legendary champions" single shelf; the Tour timeline content.

## b. Per-page notes

Severity: H costs a visitor time or trust on most visits; M is visible friction; L is polish.

### League

Shell (every page) [shot: league-standings-desk.png, crop-league-standings-phone-top.png, league-menu-open-phone.png, crop-league-gear-open-desk.png]
- Desktop header is clean: six pills, search, gear, login. Phone header is still two glyphs and
  no wordmark (prior item, not shipped). Phone Menu lists the six links, then the rating toggle
  rendered as a gold primary button, then "Login with Discord". The gold on the toggle is the
  loudest thing in the menu (prior item). M.
- No footer on any page; pages end on bare felt (prior item L22, still open). M.
- No link to the Tour anywhere (finding 3). H.
- The "Jump to" h2 appears in every page's heading outline; it is the command palette's hidden
  heading leaking into the document outline (screen readers hear it on every page). L.

/standings (= /) [shot: league-standings-phone.png, crop-league-standings-rare1-phone.png, crop-league-standings-common1-phone.png, crop-league-standings-expand-phone.png, league-standings-desk.png, crop-league-standings-desk-mid.png, crop-league-key-open-desk.png]
- Works: tier chips as jump links, progress line, zero-match state ("NONE PLAYED", dash tiles),
  tie footnotes once per group, shared ranks (2,2,2,2,6), form pips and signed lives.
- Phone: 4,453px for 87 players, down from 10,152 (collapsing works). But the collapsed summary is
  a gold Jersey 10 bar at full width, so 12 bars dominate the page (finding 6); the first
  division of every tier is open and the rest closed, with no cue why; the open card's HIDE
  strip is a 40px gold band with a single 11px word at the right. H.
- Phone: the summary text wraps to two lines on long names ("Rare 3 - leader saksh0907 3 pts -
  2/13 played"). Shorten to "Rare 3 . saksh0907 leads . 2/13" or drop "leader". L.
- The KEY disclosure now sits in the progress panel and, when open, explains arrows and
  padlocks but still not the pips or the hearts, which are the two marks on every row. M.
- Desktop: one card per division in a two-column grid is right. The Legendary single card still
  leaves the right half empty (prior item). The grid can show 1.5 divisions per screen. L.
- 87 avatars at ?size=64 make this the heaviest page on either site (2.5 MB, 116 requests).
  Rows below the fold should lazy-load, and collapsed divisions should not fetch avatars at
  all. M.

/divisions/[id] [shot: league-division-phone.png, league-division-desk.png]
- Works: zero-match state matches the standings now; "Still to play" cards are compact.
- The hero still has the roster chip row that duplicates the table (prior item). "all standings"
  is a lowercase text link floating at the right of the hero. L.
- Desktop "Still to play" is a 4-up grid of vs-cards; good density. Phone stacks 10 of them at
  53px each; fine.

/profile/[id] [shot: league-profile-phone.png, league-profile-desk.png, crop-league-profile-history-desk.png]
- Works: one-line career summary, season history cards with gold edges, match cards with G1/G2
  deck/stake chips and picks-and-bans disclosure.
- Hero is still a 360px centred card on desktop (prior item). The four stat tiles say RANK #1,
  POINTS 0, RECORD 0-0-0 before any match, and the "Legendary x3" sticker is unexplained (prior
  items). "Show all seasons (8 more matches)" is good.
- 10px tile labels (RANK, POINTS, RECORD, NET LIVES) at 3.63:1. L.
- "Deck and stake stats" is a bare disclosure with no teaser (prior item).

/hall-of-fame and ?all=1 [shot: league-hof-phone.png, league-hof-desk.png, league-hof-all-desk.png, crop-league-hof-all-phone.png]
- Legendary view: one shelf, newest first, title-count stickers. Good on both sizes. 903px on
  phone.
- All divisions: desktop shelves per season are good. Phone is 12,862px because each champion is
  still a half-width card in a single column with the right half empty (prior item, still
  open). H on phone.
- Two headings (the trophy-emoji "Hall of Fame" then "Hall of Fame") remain in the outline (prior item).

/seasons and /seasons/[id] [shot: league-seasons-phone.png, league-seasons-desk.png, league-season-desk.png, crop-league-season-phone.png, crop-league-season-phone-2.png]
- /seasons now shows "Champion: estrakami" per finished season. Good. ACTIVE pill is green,
  FINISHED grey. Fine.
- /seasons/[id] on phone is 9,554px: 15 divisions fully expanded, 80px per row, initials
  avatars. The collapsing that fixed /standings was not applied here. Each tier also prints its
  name twice (the tier h3 "Legendary" in purple, then the card title "Legendary" in purple
  Jersey 10). H on phone.
- Finished seasons have no champion marker on the division rows; the Hall of Fame does. L.

/stats [shot: league-stats-phone.png, league-stats-desk.png, crop-league-stats-phone-top.png]
- Works: rank tiles replaced the medals; two top-5 panels; deck/stake ban-rate bars. 3,150px on
  phone, acceptable.
- Desktop: the two top-5 panels are still stacked full-width, with the number 900px from the
  name (prior L13, not shipped). Phone is fine.
- Streaks "(dot) active" repeated five times (prior item).

/join [shot: league-join-phone.png, league-join-desk.png]
- Clear, two steps. Buttons still blurple (prior L10).
- The "How it works" box repeats four facts the how-it-works page says in sections 1 to 3 and 7,
  then links "Read the full how-it-works page". A first-timer sees the same copy twice within
  one click. Keep the two buttons here, cut the box to one line plus the link. M.
- On the phone the "Open Discord invite" button overlaps the end of the step text ("Join the
  server before you sign up." is partly hidden behind the button). Looks broken at 390px. M.
  [shot: league-join-phone.png, rows 300-360]

/how-it-works [shot: league-how-it-works-phone.png, league-how-it-works-desk.png]
- Good: one card per topic, bold inline terms, plain language, the Discord button names match
  the bot ("Who do I play?", "Start a match", "Help").
- The date mismatch (finding 7). H.
- No call to action. The page explains everything and then stops at "Good luck out there!" with
  no "Join" button; the join page is the one with buttons. Add a final card "Ready? Join the
  league" linking to /join (logged out) or "Your division" (logged in). M.
- "WELCOME TO THE BALATRO LEAGUE!" is an 11px faint eyebrow at 3.63:1. L.
- The page is 2,649px on a phone; a 10-item "On this page" strip at the top would help a
  returning player who wants only "Ties". L.

404 [shot: league-404-phone.png, tour-404-phone.png]
- Branded, with the nav, two text links written with ASCII arrows ("<- Standings", "Join the
  league ->"). The Tour's 404 has a gold button and a Lucide arrow. Same page, two drawings. L.

### Tour

Shell (every page) [shot: tour-home-desk.png, crop-tour-home-phone-top.png, tour-menu-open-phone.png, crop-tour-brand-open-desk.png, crop-tour-seasonpill-open-phone.png, crop-tour-search-phone.png]
- Works: brand chip switcher (two rows with a subtitle each), gold season pill with a dropdown
  of all tours plus "All seasons", pill links, search, sign in, footer. The phone Menu puts the
  switcher first, then Search, Stats, Hall of Fame, Rules. This is the shared shell the
  cohesion audit asked for, built.
- Menu ghost shadow (finding 4). H, because it is on every phone page.
- Brand label contrast 1.59:1 (finding 4). H.
- "Standings" duplicated: header pill and first sub-nav tab go to the same URL. On a season page
  the header pill is redundant; on /stats it is the only way back. Keep it, but mark it active
  only on the standings page (it currently shows active on /players too? No: it shows active on
  the standings page only; fine) and drop the sub-nav's "Standings" tab in favour of the h1. M.
- The phone sub-nav is a gold-underlined bar reading "Standings v" in gold Silkscreen; it looks
  like a heading, not a control, until tapped. Add the chevron label "Section" or render it as
  a select-styled panel-2 strip. L.
- "TT5" in the phone season pill is an abbreviation nobody has been taught; the dropdown shows
  "Team Tour 5". Use "Tour 5". L.
- Footer: one sentence, "Rules", "Balatro League". It appears on every page except the league.
  Good.

/seasons/Team Tour 5 (standings, = /) [shot: tour-home-desk.png, crop-tour-home-desk-2x.png, tour-home-phone.png, crop-tour-home-phone-morecols.png, tourprod-home-desk.png]
- Works: two-column team cards with rank disc, team band on the left edge, team name pill, big
  matchup record tile, gold disc for 1st, dashed PLAYOFF LINE. The old look's 7-column table is
  gone. Phone is 2,539px for 20 teams, down from a table that wrapped every name.
- Second line (finding 9). M.
- Team name pills vs plain text: 18 of 20 teams wear a colour pill; Cartun Network and Winning
  By Default have no colour and render as plain bold text with no band, which reads as missing
  data next to the pills. Give colourless teams a panel-2 pill and a paper-faint band. M.
- Pill contrast: ColorChip computes ink per colour, but on /weeks the white-ish teams (localdunk,
  Planet Freaking Earth, The Aura Monsters) get paper ink on a light band (1.03 to 1.3:1 measured
  on the band element). Likely the inline bands use the band colour as background with the
  default text colour rather than ColorChip's ink. Check and reuse the ink. H on /weeks.
- "More columns" on the phone reveals a second line of counts, not columns. Rename to "Show
  sets and games" or make the second line always visible at 12px. L.
- The explainer paragraph under the h1 is still on every visit (prior item).
- Desktop: 1,348px, two screens for 20 teams. Good density.

/players (season rankings) [shot: tour-players-desk.png, crop-tour-players-phone-top.png, crop-tour-players-phone-mid.png, tour-players-phone.png]
- Desktop works: chips, checkbox, seed filter, impact paragraph, dense table with name cell on
  panel-2.
- Phone: 6,537px because each row becomes a six-line labelled card (RANK, SETS, SET %, GAMES,
  GAME %, IMPACT). The same page uses compact-phone rows elsewhere (team page roster). Use the
  compact row here: rank, name + seed, sets, set %. Prior item T16 covers the controls; this is
  the row. H on phone.
- The "By record / Impact" segment plus "Include playoff games" plus the Seed chip row plus the
  Impact paragraph is four control rows before data (prior item).

/weeks [shot: tour-weeks-desk.png, tour-weeks-phone.png, crop-tour-weeks-phone-top.png, crop-tour-weeks-expanded-phone.png]
- Works: the best page on either site. Week chips, 3-up matchup cards, team bands, big scores,
  gold clinch stripe on the winning side, "3 TO PLAY" eyebrow. 900px on desktop.
- Tapping a matchup on a phone expands into: the same two team names again as a "vs" block,
  "Open matchup ->" text link, three overlay buttons (finding 10), then the set list where the
  score "2-1" wraps to two lines ("2-" / "1") in an 18px-wide cell. H on phone.
- "Flip sides" button is a global toggle with no explanation of what flips (home/away order).
  Tooltip or label "Swap home/away". L.
- Week 6 has an unexplained gold dot (means "open week"). Say so in a title attribute. L.

/pickem [shot: tour-pickem-desk.png, tour-pickem-phone.png, crop-tour-pickem-row-open-desk.png, crop-tour-pickem-leaderboards-desk.png]
- Works: Picks/Leaderboards tabs, week chips with open counts, "11 to pick" per matchup,
  expanded rows show S1..S11 pairings with team emoji, the leaderboard panels.
- Signed-out: every matchup row shows two greyed team pills and "sign in to pick"; the sign-in
  callout above is a text link with an icon (prior T8).
- Phone: a matchup row wraps as "Great / Stake / Spectacle / vs" with the emoji on its own line,
  and "11 to pick" pushes the second team to a third line. Use the two-band stacked layout the
  week cards use. M.
- "Week 6 . 33 open" is still a Silkscreen heading inside the card (prior item).

/timeline [shot: tour-timeline-desk.png, tour-timeline-phone.png]
- Works: icon per event type, week panels, "Show 3 more weeks". Good spectator page.
- "Show 1 more events": singular/plural bug in ShowMore.tsx. L.
- Eight consecutive "N seed changes on <team>" rows carry little; group them as one row "Seed
  changes on 8 teams" with a disclosure. L.
- Phone rows wrap team names mid-line ("Great Stake Spectacle def. / Bovine Battalion 6-5"),
  fine, but 2,894px; acceptable.

/awards [shot: tour-awards-desk.png, tour-awards-phone.png]
- Empty state is exemplary. But the tab is in the sub-nav while empty; hide the tab until an
  award exists, or show "Awards (after playoffs)" muted. L.
- Desktop ends at 430px of content, then the footer, then 330px of felt below the footer. The
  footer should be the last thing on the page (min-height layout). L.

/draft [shot: tour-draft-desk.png, crop-tour-draft-phone-top.png]
- Desktop: a 20x14 grid in one panel; names shrink to fit cells via FitText down to 6.9px
  (measured), unreadable. Floor at 10px and ellipsize, with the full name on hover. M.
- Phone: the board scrolls inside its wrapper with sticky # and team columns, plus a "Fit to
  screen" button. Works. "PRESENT MODE" is a streamer feature exposed to all; move it next to
  the overlay buttons behind one "Stream tools" disclosure. L.
- 233 links under 44px tall on the phone (every pick). Acceptable in a board, but the row height
  could be 36px.

/teams/[id] [shot: tour-team-desk.png, tour-team-phone.png, crop-tour-team-phone-top.png, tourprod-team-desk.png]
- Works: team-colour edge on the hero, captain line, matchups tile, roster table with avatars,
  gold "C" chip, "from S6" seed origin, OUT row, Roster moves, Week by week. Big improvement
  over prod.
- Hero: the team name is Jersey 10 at ~40px with no colour band; the only colour is the 6px left
  edge. The team should wear its band here (prior T14).
- Five stat tiles still leave ROSTER orphaned on a second row (prior T6). On the phone they
  stack 2+2+1 for 700px before the roster.
- "Open week: 6": the link is the single underlined digit, 8x44px. Make "Week 6" the link. L.
- "Team overlay" in the hero (finding 10). M.
- Roster table on the phone: the name pill wraps to two lines for long names and the "C" chip
  drops under the name. Fine.

/players/[id] (Tour player) [shot: tour-player-desk.png, tour-player-phone.png]
- Desktop: eight stat tiles, two sentences, season table with heat-coloured cells, charts,
  games, head-to-head. Dense but scannable.
- Phone: 7,556px. Eight tiles stacked one per row (the league uses a 2x2 strip), the season
  table as 9-line labelled cards, two bar charts, then "By deck", "By stake", the games list and
  H2H. Cut the tiles to a 2x4 grid and use compact-phone rows for the season table. H on phone.
- "Played up: 5 sets (2-3) . even: 18 sets (8-9) . down: 11 sets (6-5)" uses full stops as
  separators; reads like a typo. Use middle dots. L.
- "<- leaderboard" back link goes to /stats/players; the stats hub's back link says "<- home"
  and goes to /. Two labels, two targets, one idea. L.

/stats and sub-pages [shot: tour-stats-desk.png, crop-tour-stats-phone-top.png, tour-stats2-teams-desk.png, tour-stats3-records-desk.png, crop-tour-records-phone-top.png, crop-tour-records-phone-mid.png, tour-stats4-steals-desk.png, tour-stats5-rookies-desk.png]
- Works: eleven-tab strip now wraps (Rivalries alone on row two), sortable leaderboards with
  avatars and rings column, "Include playoff games" everywhere, season select on Steals,
  "BALATRO'S BIGGEST BUM" and "SUB" chips.
- /stats lands on All-time players with a "<- home" link that goes to the standings, not to a
  stats hub. Drop it; the tab strip is the navigation. L.
- Records on the phone (finding 5). H.
- Records desktop: "Most seasons" lists 20 players all ranked "1" with "+27 more" in the
  headline; the list is pure noise. Cap at five rows and say "32 players have 5 seasons". M.
- All-time players phone: the table scrolls sideways inside its wrapper and a "Show full stats"
  button sits above it; the column headers get cut at "SE". Fine, but the search box, checkbox
  and button make three control rows before the table. L.
- All-time teams: season column links are underlined blue-ish in a table (prior T3 says plain
  in tables). L.

/hall-of-fame [shot: tour-hof-desk.png, tour-hof-phone.png]
- Four champion cards (selected one gold-edged), bracket with clinch stripes, champion chip,
  round summaries. Good on both sizes. The champion names are gold text on gold-edged cards;
  on the phone "Calculated Gambling" in the bracket chip measures 1.43:1 (paper on gold
  fill). Use gold-ink on gold fills. M.

/rules [shot: tour-rules-desk.png, crop-tour-rules-phone-top.png]
- 7,347px on the phone, no index (prior T18). Headings now Jersey 10 gold. Fine otherwise.

/seasons [shot: tour-seasons-desk.png, tour-seasons-phone.png]
- The live season's card shows "--" where the champion goes. Write "In progress . week 6". L.
- Five cards plus two bare underlined links (prior T13).

404 [shot: tour-404-phone.png]
- Branded, gold "Back to the home page" button. Good.

### Empty and loading states (both)
- Seen: league "NONE PLAYED" label plus dash tiles, "None played this season." panel, "No
  champions yet"; Tour "No awards yet" (icon + text), "No standings yet", "Nothing has happened
  yet", "No matchups scheduled yet". The Tour's are consistently icon + line + sentence; the
  league's are bare sentences. Adopt the Tour's EmptyState shape in the league. L.
- Loading: both sites are server-rendered within about 1s on every page; no skeleton was ever
  visible. The Tour has loading.tsx for /stats and season pages (Next streaming); the league
  has none. Not a user-visible problem today.

### Search (both) [shot: crop-league-search-phone.png, crop-tour-search-phone.png]
- Same component shape, same Ctrl K hint, grouped results. The league lists "Players" as a page
  for logged-out visitors; it redirects to sign-in (prior item). The Tour's placeholder "Jump to
  a player, team, or season..." is better than the league's "Jump to a page...". L.

## c. Cross-site consistency

| component | league | tour | verdict |
|---|---|---|---|
| ground | felt green #1b443f + weave | navy #1c2a4a + weave (MASTER.md says burgundy) | decide: fix the doc or the token |
| panel / shadow / radius | #26383a, 2px edge, hard shadow, r10 | identical | shared, done |
| display face | Jersey 10 sentence case, h1 clamp | Jersey 10, but "All-Time Player Leaderboard" title case on stats pages | tour: sentence case everywhere |
| eyebrow labels | Silkscreen 11px (KEY, NONE PLAYED, MATCHES) | Nunito uppercase 11px (STANDING, PLAYER, SETS) plus Silkscreen for sub-nav text | pick one; Silkscreen for eyebrows per MASTER.md, Nunito for table headers |
| top bar | brand chip + wordmark, 6 pills, search, gear, login text | brand chip switcher, season pill, 4 pills, search, sign in | league adopts the switcher and the season pill (prior L23/S3); drop gear or fold into account |
| product switcher | none | brand chip menu with two rows | league must add it |
| phone menu | gold Menu button, 6 links, gold rating toggle, login | muted Menu text, switcher rows, search, 3 links | tour's order is right; league: make Menu secondary, move toggle last and muted |
| season pill | none | gold outline "Team Tour 5" with dropdown | league adds "Season 9" pill (prior) |
| footer | none | one sentence + Rules + Balatro League | league adds the same component |
| primary button | gold fill, gold-ink, hard shadow (Menu, HIDE bars) | gold fill, gold-ink (Back to home, By record) | shared, done; league overuses it on standings |
| secondary button | panel-2 (Search) | panel-2 (More columns, Flip sides) | shared, done |
| rank marker | square tile in tier colour, number | round disc, gold for 1st, panel-2 otherwise | two drawings of one thing; pick the disc on both (it also fixes the league's "-" tile) |
| row / card | player-card: tile, avatar, name, pips, lives, pts tile | team-card: disc, band, name pill, meta line, record tile | same recipe, different parts; fine, both read as the family |
| name identity | plain bold paper, Discord avatar | colour pill for teams, avatar for players | fine; colourless teams need a neutral pill |
| semantic colour | rarity: tier chips, tier h3, zone stripes | team colour bands; gold for 1st and clinch | per MASTER.md, correct |
| tie / tiebreak note | italic faint footnote per group | none (no ties shown) | n/a |
| chips (filters) | chunky tier chips with hard shadow + count bubble | outline pills (weeks), filled circles (seeds), underline tabs (Picks/Leaderboards) | tour still has three chip styles (prior S1) |
| sub-nav | none | panel strip with pill-active tab; phone dropdown | fine; league could use on division page |
| back link | "<- Standings" ASCII, faint | Lucide arrow + underlined text, three different labels | one component: arrow icon + "Back to X", faint, no underline |
| empty state | bare sentence in a panel | icon + title + sentence | adopt the Tour's |
| 404 | nav + panel + two ASCII text links | nav + panel + gold button | adopt the Tour's |
| stat tiles | 4 small tiles in one row inside the hero | 5 or 8 big tiles, one per row on phone | tour adopts the league's 2x2 strip |
| search palette | "Jump to a page..." + Pages + Divisions | "Jump to a player, team, or season..." + Pages + season | same component; copy the Tour placeholder |
| muted text contrast | 3.63:1 / 3.05:1 | same | one token fix for both |
| overlay / streamer tools | none public | overlay buttons on weeks, team, draft present mode | hide behind one "Stream tools" disclosure or sign-in |

## d. Backlog

Size: S one file, under an hour; M two to four files, half a day; L cross-cutting. Impact: H
visible on most visits or fixes a looks-broken moment; M noticeable; L polish. Decision: needs
the organiser before building. League S/no-decision first, then Tour S/no-decision, then the
rest.

| id | change | site | files | size | impact | decision |
|---|---|---|---|---|---|---|
| R1 | Render the guide's "Started / Ends around" dates with LocalDateTime so they match /standings (Oct 7-21 vs Oct 8-22) | league | web/lib/season-window-text.ts (34-35), web/app/how-it-works/page.tsx | S | H | no |
| R2 | Add a Tour link: a "Team Tour" row at the top of the phone Menu, a "Team Tour ->" entry in the gear menu, and a line in the 404 panel; use the Tour URL from lib/tour-profile.ts | league | web/components/SiteMobileMenu.tsx, web/components/SiteNav.tsx, web/app/not-found.tsx | S | H | no |
| R3 | Collapsed division summary: panel-2 row with the division name in its tier colour, a faint "Birb leads . 2/10" and a chevron; gold only for the viewer's own division | league | web/components/CollapsibleDivision.tsx (41-46), web/app/v2/standings-cards.css | S | H | no |
| R4 | Replace the open card's full-width HIDE strip with a small "Hide" chip in the header strip | league | web/components/CollapsibleDivision.tsx (46), web/app/v2/standings-cards.css | S | M | no |
| R5 | Lift paper-faint to about #93a3a0 (4.6:1 on panel) and re-check panel-2 uses; both sites | league | web/app/globals.css (:root tokens), design-system/MASTER.md | S | H | no |
| R6 | How it works: add a closing card with a gold "Join the league" button (logged out) or "Your division" (logged in) | league | web/app/how-it-works/page.tsx (45-62) | S | M | no |
| R7 | Join: cut the "How it works" box to one line plus the link; fix the invite button overlapping the step text at 390px | league | web/app/join/page.tsx (75-98, 199-208) | S | M | no |
| R8 | Lazy-load avatars below the fold and skip avatar fetches in collapsed divisions (2.5 MB, 116 requests) | league | web/components/DivisionStandingsTable.tsx (232-240), web/lib/avatar.ts | S | M | no |
| R9 | KEY: add the form pips and the heart/lives to the legend | league | web/app/standings/page.tsx (231-239) | S | M | no |
| R10 | 404: gold "Back to standings" button and Lucide arrow, same as the Tour | league | web/app/not-found.tsx (15-19) | S | L | no |
| R11 | Search placeholder "Jump to a player, division, or season..." | league | web/components/CommandPalette.tsx | S | L | no |
| R12 | Remove the "Jump to" h2 from the document outline (visually-hidden label on the dialog, not an h2) | league | web/components/CommandPalette.tsx | S | L | no |
| R13 | /seasons/[id]: reuse CollapsibleDivision so a finished season is one summary row per division on phone; drop the duplicate tier h3 | league | web/app/seasons/[id]/page.tsx | M | H | no |
| R14 | Standings rank marker as the Tour's disc (gold 1st, panel-2 others) on both sites | both | web/app/v2/standings-cards.css, apps/tour/app/globals.css | M | M | yes (look) |
| R15 | Shared EmptyState (icon + title + sentence) in the league | league | web/components/EmptyState.tsx (new), DivisionStandingsTable.tsx, hall-of-fame/page.tsx, seasons/page.tsx | M | L | no |
| T1 | Menu trigger: add shadow-none / rounded-none so the global button shadow stops drawing a bar under "Menu" | tour | apps/tour/components/MoreMenu.tsx (42-43), apps/tour/app/globals.css (button rule ~610-620) | S | H | no |
| T2 | Brand label: gold-ink text on the gold chip (1.59:1 today) | tour | apps/tour/components/ProductSwitcher.tsx (20, 32), apps/tour/app/globals.css (.brand 834) | S | H | no |
| T3 | Records: exempt table-dense name cells from the two-line box clamp, or give the row min-height 44px, so names stop drawing above their row on phone | tour | apps/tour/app/globals.css (335-356), apps/tour/app/stats/records/page.tsx | S | H | no |
| T4 | Hide "Open matchup / Matchup overlay / <team> overlay / Team overlay / Present mode" behind one "Stream tools" disclosure, or show only when signed in | tour | apps/tour/app/seasons/[name]/weeks/page.tsx (158-161), apps/tour/app/teams/[id]/page.tsx (244), apps/tour/app/seasons/[name]/draft/page.tsx (56) | S | H | no |
| T5 | Weeks expanded set list: score cell nowrap and min-width 44px ("2-" / "1" today) | tour | apps/tour/app/seasons/[name]/weeks/page.tsx, apps/tour/app/globals.css | S | M | no |
| T6 | Standings second line: one line "Sets 33-21 (61%) . Games 76-54 (59%)" at 12.5px paper-dim; label the tile "80% matchups"; rename "More columns" to "Show sets and games" | tour | apps/tour/app/seasons/[name]/page.tsx (141-149), apps/tour/app/globals.css (1443) | S | M | no |
| T7 | Colourless teams get a panel-2 pill and a faint band instead of plain text | tour | apps/tour/components/ColorChip.tsx, apps/tour/app/seasons/[name]/page.tsx | S | M | no |
| T8 | Inline bands on /weeks use ColorChip's computed ink (paper on near-white bands today, 1.03:1) | tour | apps/tour/app/seasons/[name]/weeks/page.tsx, apps/tour/components/ColorChip.tsx | S | H | no |
| T9 | Hall of Fame bracket champion chip and gold fills use gold-ink text (1.43:1 today) | tour | apps/tour/app/hall-of-fame/page.tsx, apps/tour/app/globals.css (.hof-* rules) | S | M | no |
| T10 | Draft board: FitText floor 10px, ellipsis and title on overflow | tour | apps/tour/components/FitText.tsx (77-82) | S | M | no |
| T11 | ShowMore: "Show 1 more event" singular | tour | apps/tour/components/ShowMore.tsx (64-68) | S | L | no |
| T12 | Records: cap each list at five rows and summarise ties ("32 players have 5 seasons") | tour | apps/tour/app/stats/records/page.tsx | S | M | no |
| T13 | Team page: make "Week 6" the link, not the digit (8px target) | tour | apps/tour/app/teams/[id]/page.tsx (253) | S | L | no |
| T14 | Back links: one component, "<- Back to X", faint, no underline; drop "<- home" on /stats/players | tour | apps/tour/app/players/PlayersView.tsx (26), apps/tour/app/teams/[id]/page.tsx, apps/tour/app/players/[id]/page.tsx | S | L | no |
| T15 | Player page: middle dots in "Played up . even . down"; "--" on the live season card becomes "In progress . week 6" | tour | apps/tour/app/players/[id]/page.tsx, apps/tour/app/seasons/page.tsx (47) | S | L | no |
| T16 | Stats page titles to sentence case ("All-time player leaderboard") | tour | apps/tour/app/players/PlayersView.tsx, apps/tour/app/stats/teams/page.tsx | S | L | no |
| T17 | Phone season pill label "Tour 5" instead of "TT5" | tour | apps/tour/components/SeasonsMenu.tsx | S | L | no |
| T18 | Awards tab hidden (or muted "after playoffs") while empty; footer pinned to the bottom on short pages | tour | apps/tour/lib/season-nav-tabs.ts (36-48), apps/tour/app/layout.tsx | S | L | no |
| T19 | Season player rankings on phone: compact-phone rows (rank, name + seed, sets, set %) instead of six-line labelled cards | tour | apps/tour/app/seasons/[name]/players/page.tsx (135) | M | H | no |
| T20 | Player page on phone: 2x4 tile grid and compact-phone season table | tour | apps/tour/app/players/[id]/page.tsx, apps/tour/app/globals.css | M | H | no |
| T21 | Pick'em phone rows: stacked two-band layout like the week cards | tour | apps/tour/app/seasons/[name]/pickem/MatchupPickRow.tsx | M | M | no |
| T22 | Sub-nav: drop the "Standings" tab (header pill already goes there) and make the h1 the section name; phone dropdown labelled as a control | tour | apps/tour/lib/season-nav-tabs.ts, apps/tour/components/SeasonNav.tsx (82-83) | M | M | yes (nav change) |
| T23 | Timeline: group "N seed changes on <team>" rows into one disclosure per week | tour | apps/tour/app/seasons/[name]/timeline/page.tsx | M | L | no |
| T24 | Felt colour: confirm navy (#1c2a4a) and update MASTER.md, or switch to burgundy (#4a1d24) per the doc | tour | apps/tour/app/globals.css (:root --felt, --felt-deep), design-system/MASTER.md | S | H | yes |
| X1 | League adopts the Tour's shell: brand chip switcher, season pill, footer (prior L22/L23/S3, now unblocked because the Tour half exists) | league | web/components/SiteNav.tsx, SiteMobileMenu.tsx, SiteFooter.tsx (new, port from apps/tour/components/SiteFooter.tsx), web/app/layout.tsx | M | H | yes (nav) |
| X2 | One chip primitive for tier chips, week chips, seed circles and tab toggles (prior S1) | both | web/app/globals.css, apps/tour/app/globals.css | M | M | no |
| X3 | Shared design-system package once the repos merge (prior S4) | both | new package | L | H | yes |
