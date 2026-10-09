---
date: 2026-10-09
confidence: high for everything seen live (both sites browsed logged out at 390x844 and 1280x900); medium for the merged-site proposal (design judgement, not yet validated with the organiser)
sources:
  - https://balatroleague.com/ (standings, divisions/cmuyvr3mo002onl01pk981pme, profile/cmsypgm06002no101ln58fy35, hall-of-fame, seasons, stats, join)
  - https://tour.balatroleague.com/ (seasons/Team Tour 5 standings, /weeks, /pickem, /players, teams/cmt0z67tv001jko3uzqz9cgat, /seasons, /stats/players, /stats/teams, /hall-of-fame, /rules)
  - D:/BalatroLeague/design-system/MASTER.md
  - D:/BalatroLeague/web/app/globals.css, web/app/v2/*.css, web/app/layout.tsx, web/components/SiteNav.tsx, web/lib/nav-links.ts, web/lib/preferences.ts
  - D:/balatro-team-tour/apps/tour/app/globals.css, app/layout.tsx, AGENTS.md, DEPLOY.md, lib/site-nav-core.ts, components/SeasonNav.tsx, components/StandingsTable.tsx, components/ColorChip.tsx
  - D:/BalatroLeague/.claude/knowledge/ux-audit/01-findings.md (previous audit; its items are not repeated here)
screenshots: D:/BalatroLeague/.claude/knowledge/ux-cohesion/shots/ (80 files, league-* and tour-*, desk/phone, "-fold" = first screen, no suffix = full page)
---

# League + Team Tour: UI polish round 2 and one shared look

## The short version

1. The league is live on the Card Table look for everyone (data-ui="v2" is the default since 2026-10-09). The Tour is live on the league's OLD look: near-black ground, 1px borders, system font body, Silkscreen headings loaded from Google. The two sites do not look related today. [shot: league-desk-standings-fold.png vs tour-desk-home-fold.png]
2. MASTER.md already says how the two should relate (same base, Tour gets a burgundy felt and team colours instead of rarity colours). Nothing of that has been built on the Tour side. The Tour's own opt-in preview palette (?theme=v2, a slate ground) is a dead end and should be removed in favour of the Card Table port.
3. The league's remaining "spreadsheet" smell is not the tables any more. It is leftover v1 colour (blurple progress bar, blurple links, blurple Discord buttons, emoji medals, v1 rgba pills) and dead space (one-card Hall of Fame shelves, a half-empty Legendary column, a 360px profile card in a 1100px page).
4. The Tour has two ideas the league should steal: the gold season pill in the header and the team-colour bands. The league has four the Tour should take: the felt-plus-panel-plus-hard-shadow recipe, Jersey 10 sentence-case headings, the player-card row, and the trophy shelf.
5. Cheapest wins first: nine league S-size fixes need no decision and are listed at the top of the backlog.

---

## a. Side by side

| | Balatro League (live, Card Table v2) | Pizza Power Team Tour (live, v1 port) |
|---|---|---|
| Ground | felt green #1b443f with a 45deg weave; header/sticky bars felt-deep #12302d | flat near-black #0f1115; header same colour with a 1px #2a2f3a line |
| Panel | #26383a, 2px #0d1a1a edge, radius 10, shadow 0 6px 0 edge + 0 14px 28px soft; header strip in #2f4447 | #181b22, 1px #2a2f3a border, radius 8, no shadow, no header strip |
| Text | paper #f3eee2 / dim #b8c2bf / faint #7f8f8c; body 15px Nunito Sans | #e6e8ec / muted #abb3c4; body 14px system font |
| Accent | gold #f1b53a (champion, promotion, "you", focus, primary button) | gold #f1c40f (season pill, active tab, week chip, winner rows) |
| Semantic set | rarity: Legendary #bb73d6, Rare #ff6259, Uncommon #3cc78f, Common #1e9bff | team colours (per-team bands via ColorChip), plus link blue #3cb4ff, button blue #0572b7, border blue #009cfd |
| Leftover v1 colour | blurple #5865f2 still on the standings progress bar, join buttons and default link colour (#747ff4) | all of v1 by design |
| Display face | Jersey 10, sentence case, h1 clamp(28,5vw,40) | Silkscreen 30px ALL CAPS with 0.5px tracking on every h1 and h2 (the loudest thing on each page) |
| Pixel labels | Silkscreen 11px eyebrows only | Silkscreen used for headings, brand, season names, bracket titles, "WEEK 5 - 62 OPEN" |
| Fonts served | self-hosted woff2 (3 families) | Silkscreen via next/font/google at build; body is the system stack |
| Radii | 10 panel / 8 button, input / 5 chip / 999 nav pill | 8 card / 6 flash / 4 team chip / 999 badge, week chip |
| Buttons | gold fill, dark ink, 0 4px 0 hard shadow, 3px press; secondary panel-2; danger rare | shadcn blue fill, white text, flat; secondary surface-2 |
| Header | brand (CSS card chip + wordmark) + 5 pill links + search + gear + login; phone: icon only, gold Menu, red Search, "Login with Discord" text | pizza icon + TEAM TOUR pixel wordmark + gold-outlined season pill + Stats/Hall of Fame/Rules with lucide icons + search + sign in; phone: TT5 pill, Menu, Sign in |
| Second nav row | none | season sub-nav (Standings, Player Rankings, Regular Season, Pick'em, Timeline, Awards, Draft) as underline tabs; on phone a gold-tinted dropdown |
| Back links | "<- Standings" on profile only | "<- seasons" / "<- Team Tour 5" on every page, blue and underlined |
| Footer | none | none |
| Card language | player-card rows (rank tile, avatar, name, form pips, lives, pts tile), vs-blocks, roster chips, tier tabs, profile hero card, trophy shelves, season cards | stat tiles, dense sortable tables, team-colour bands, matchup cards (two bands + scores + chevron), week chips, pick'em rows with Discord emoji, bracket columns, awards podium |
| Motion | deal-in 220ms with 30ms stagger, hover lift 1px, button press, reduced-motion honoured | colour transitions and a chevron rotate only |
| Phone page heights seen | standings 4335, division 1592, profile 1346, hall of fame 1867, stats 3143 | standings 1902, weeks 1739, pick'em 1374, team 2803, player rankings 6836, rules 7419 |

### Verdict: what is shared, what stays distinct

Share the shell and the primitives. Keep one accent and one signature element per product.

Shared (identical code in both apps, later one package):
- Ground recipe (felt + weave), panel, panel header strip, hard offset shadow, button, chip, form control, table header style, focus ring.
- Fonts: Jersey 10 display, Silkscreen eyebrows, Nunito Sans body, all self-hosted.
- Top bar, footer, search palette, account menu, phone Menu.
- Rarity palette as the one set of "tier" colours. The Tour only uses it where a league rarity genuinely appears (a player's league tier on their Tour profile, for instance).
- Gold means the same thing on both: the thing that matters most to the viewer (champion, promotion, "you", captain, your team, pick'em leader).
- Motion rules (deal-in on lists, press on buttons, reduced-motion).

Distinct:
- Felt colour: League green, Tour burgundy (#4a1d24 / #2e1116 as MASTER.md already proposes). Every page says which product you are in without reading a word.
- Semantic colour: League uses rarity for tiers. Tour uses team colours for teams, as the panel edge on team cards and as the bands in tables.
- Signature elements: League keeps tier tabs, zone stripes, tie footnotes, the hero card. Tour keeps team bands, matchup "vs" blocks (two bands and a score), week chips, the bracket.
- Brand mark: League keeps the paper card chip. Tour keeps the pizza, drawn as the same little CSS chip with a pizza glyph in it, so the two marks sit side by side in the switcher.

---

## b. The shared shell

Fonts: Jersey 10 (display, sentence case), Silkscreen (11px eyebrows only), Nunito Sans (body). Copy web/app/fonts/ into apps/tour/app/fonts/ and switch the Tour to next/font/local. Drop the Google Fonts call.

Tokens: the MASTER.md block, verbatim, in both apps' :root. The Tour overrides exactly two: --felt and --felt-deep. The Tour adds --team-edge and --team-ink per team at render time (ColorChip already computes contrast-safe ink). Remove --accent-2 blurple from both: the League's progress bar and join buttons go gold; link text on both sites becomes paper with a gold underline on hover (table-cell names plain, as the Tour already does). Blue is reserved for the Common tier.

One top bar (felt-deep, 3px panel-edge bottom border, 56px tall):
- Left: product mark. Two CSS card chips side by side, the active one raised (paper chip for League, pizza chip for Tour), then the wordmark in Jersey 10. Clicking the mark opens a two-row menu: "Balatro League - Season 9, 19 of 174 played" and "Team Tour - Tour 5, week 5". On phone the same two rows are the first thing in Menu.
- Next: a season pill, gold outline, "Season 9" or "Tour 5". The Tour already has this. The League should copy it and let it open the seasons list.
- Middle: the product's own links as pills. League: Standings, Stats, Hall of Fame, Join or My profile. Tour: Standings, Stats, Hall of Fame, Rules, Sign up when open. Four or five items, which is what fits a phone without a menu. Admin appears only for staff.
- Right: Search (secondary button, not red), account.
- Second row, per product, only where the product needs it: the Tour's season sub-nav; the League could use one on the division page (Standings, Matches, Report) later.

Footer (both sites, felt-deep band): "Balatro League and Pizza Power Team Tour are community-run Balatro Multiplayer events on Discord." plus Join Discord, Rules, the other product's link, and a small "built by" line. Today neither site has a footer, so a page ends on bare felt.

Switching: the product mark and the two felt colours do the work. A visitor on the Tour sees burgundy and the pizza; one click on the mark lands on the League in green. Shared Discord login already uses the .balatroleague.com cookie, so the account menu is the same person on both.

URL structure for the merged site (needs the organiser's decision):
- Recommended: balatroleague.com/ becomes a small hub (two big product cards with live status), /league/* holds today's league routes and /tour/* holds today's Tour routes. Redirect /standings -> /league/standings and every tour.balatroleague.com/* -> balatroleague.com/tour/*. One Next.js app with two route groups, one shared package for tokens and shell.
- Alternative: League stays at the root, Tour moves to /tour/*. Fewer redirects, but the hub then lives inside the League's look and the Tour reads as a sub-section.
- Keep the subdomain and only share the shell: cheapest, and the shell switcher still works across hosts because both are Next.js apps with the same components.

---

## c. League polish round 2 (per page, with files)

Shell
- Phone header shows two unlabeled glyphs (the CSS paper chip and the 24px png icon) and no wordmark. Jersey 10 is condensed enough that "Balatro League" fits at 390 next to Menu and Search. Drop the png when the CSS chip is on; make "Login with Discord" a secondary button or fold it into Menu. web/components/SiteNav.tsx, web/app/globals.css (header h1 a::before). [shot: league-phone-standings-fold.png]
- The Search button renders in the Rare red with green key hint text, which reads as a destructive action on every page. It should be the secondary panel-2 button. web/components/CommandButton.tsx and the v2 [data-slot="button"] rules in web/app/globals.css. [shot: league-desk-standings-fold.png]
- Default link colour under v2 is still the v1 blurple (#747ff4): "all standings", "<- Standings", "All traits", "Open Discord invite" text. Re-point a { color } under html[data-ui="v2"] to paper with a gold hover underline. web/app/globals.css (@layer base a, add v2 override).
- No footer. Add components/SiteFooter.tsx and render it in web/app/layout.tsx (see section b).

/standings [shot: league-desk-standings-fold.png, league-phone-standings-fold.png]
- The progress bar fill is inline var(--accent-2) blurple, the only blurple on the page. Make it gold. web/app/standings/page.tsx lines 212 and 226.
- The progress line and the KEY toggle sit in a 60px panel with nothing else. Fold the "19 of 174 played" bar into the h1 block as a subtitle and move KEY under the first division. web/app/standings/page.tsx.
- The rank tile shows a lone "." when nothing has been played. It looks like a rendering bug. Hide the tile (let the avatar lead) or print a faint dash. web/components/DivisionStandingsTable.tsx line 521, web/app/v2/standings-cards.css.
- The tie footnote prints "baconisbets, ezhikgoobikov, Jellyy, Owen and piton322 tied on points -- total net lives decided it (0 / 0 / 0 / 0 / 0)" when zero matches exist. Suppress the footnote when noMatchesYet or when every value in the group is zero. web/lib/standings-cards-core.ts (groupTiebreakNotes), web/components/DivisionStandingsTable.tsx line 539.
- "round robin, play everyone" and "4 assigned opponents" are still on every card. Keep the "5 players - 1 down" part, drop the format words (they belong on the division page). web/app/standings/page.tsx (.meta-v2).
- A one-division tier (Legendary) fills the left half of a two-column grid and leaves the right half empty for 500px. Let the grid run continuously across tiers (one grid for the page with tier headings as full-width rows), or give a single-division tier a full-width card with its five rows in two columns. web/app/globals.css (@media min-width 1100px .tier-section .grid-2), web/app/standings/page.tsx.

/divisions/[id] [shot: league-desk-division-fold.png, league-phone-division-fold.png]
- Every row says rank "1" and a "0 PTS" tile when nothing has been played. The standings page already handles this with noMatchesYet; the division page does not pass it. web/app/divisions/[id]/page.tsx (DivisionStandingsTable call).
- "unplayed" still sits under every "Still to play" card. Drop the status line when there is no score. web/app/divisions/[id]/page.tsx (vs-status), web/app/v2/division.css.
- The roster chip row repeats the five names that appear in the table 40px below it. Cut it, or turn it into the one thing the table cannot show: "You still play: Owen, Jellyy" for a signed-in member. web/app/divisions/[id]/page.tsx (.roster-v2).
- "all standings" is a blurple text link floating in the hero. Make it a secondary button labelled "All standings". web/app/divisions/[id]/page.tsx.

/profile/[id] [shot: league-desk-profile-fold.png, league-phone-profile-fold.png]
- Desktop: a 360px hero card centred in 1100px with 370px of felt on each side, pushing Traits, Deck stats and Season history below the fold. At >= 900px put the hero on the left and the Season history grid beside it. web/app/v2/profile.css (.profile-hero-v2, .profile-season-grid-v2).
- Rank "#1", points 0, record 0-0-0 before any match: show "Season not started" in the stat strip instead. web/components/ProfileView.tsx.
- The Traits card header still uses an emoji icon; MASTER.md says inline SVG or none. web/components/ProfileView.tsx.
- "Deck and stake stats" is a panel that is only a summary line. Put a teaser in the summary ("12 games - Red deck most - White stake most") so the panel earns its space. web/components/ProfileAnalyticsSection.tsx.

/hall-of-fame [shot: league-desk-hof-fold.png, league-phone-hof-fold.png]
- With the default "Legendary champions" filter, each season is a full-width shelf band plus a plank holding one 170px card and 900px of empty wood. Eight seasons, eight near-empty shelves. Make the Legendary view one shelf: a single row of champion cards, newest first, each labelled with its season, so the page is one glance. Keep per-season shelves for "All divisions". web/app/hall-of-fame/page.tsx, web/app/v2/hall-of-fame.css.
- Same on phone (1867px of one-card shelves).

/seasons [shot: league-desk-seasons-fold.png]
- Cards still show "13 divisions - 87 players - 174 matches" and no champion. Add a trophy line "Champion: estrakami" in the Legendary colour. web/app/seasons/page.tsx.
- The ACTIVE and FINISHED pills use inline v1 rgba colours. Use the token pill: Uncommon fill for active, panel-2 with faint ink for finished. web/app/seasons/page.tsx lines 30 to 32.
- Eight identical stacked panels read as a list. Give the active season a gold edge with its progress bar, and put finished seasons in a two-column grid. web/app/seasons/page.tsx, web/app/globals.css.

/stats [shot: league-desk-stats-fold.png, league-phone-stats-fold.png]
- Gold, silver and bronze medal emoji in the rank column break the no-emoji rule and look nothing like the rank tiles used everywhere else. Use a small rank tile: gold for 1, paper-dim for 2 and 3, plain number after that. web/app/stats/page.tsx line 120.
- Each top-5 panel stretches to 1050px with the number 900px away from the name. Put "Most match wins" and "Most games won" side by side (grid-2) and cap list tables at 640px. web/app/stats/page.tsx.

/join [shot: league-desk-join-fold.png]
- "Open Discord invite" and "Sign in with Discord" are inline blurple fills. Under the system the primary button is gold with dark ink; keep the Discord glyph on the button so the brand is still there. web/app/join/page.tsx lines 88 and 123.
- "How it works" is four unnumbered 12px lines in faint ink. Make it a numbered list at body size. web/app/join/page.tsx.

---

## d. Team Tour polish (per page, with files)

Shell [shot: tour-desk-home-fold.png, tour-phone-home-fold.png]
- Port the Card Table base: tokens, felt weave, panel, header strip, button, chip, form control, table header and the header rules from web/app/globals.css into apps/tour/app/globals.css under :root (not behind a flag), with --felt #4a1d24 and --felt-deep #2e1116. Delete the ?theme=v2 slate preview block and the inline script in app/layout.tsx that sets data-tt. apps/tour/app/globals.css, apps/tour/app/layout.tsx. This is the one L item and it unlocks every other Tour row.
- Fonts: copy web/app/fonts/ into apps/tour/app/fonts/, switch Silkscreen to next/font/local, add Jersey 10 and Nunito Sans, and move h1/h2/.brand/.season-name/.bracket-title to Jersey 10 sentence case. Today every page title is Silkscreen ALL CAPS at 30px with wide tracking ("ALL-TIME PLAYER LEADERBOARD", "TEAM TOUR 5 - REGULAR SEASON"), which is the loudest element on every screen and reads arcade, not card table. apps/tour/app/layout.tsx, apps/tour/app/globals.css (@layer base h1,h2 and the Tour helpers block).
- Header: same bar as the league. Keep the gold season pill (it is the Tour's best navigation idea). Replace the lucide-icon text links with pill links. apps/tour/app/layout.tsx header block, components/MoreMenu.tsx.
- Season sub-nav: underline tabs on bare ground. Restyle as a panel-2 strip with a pill for the active tab, matching the league's nav pills. The phone dropdown ("Standings v" in gold tint) is good; keep it. apps/tour/components/SeasonNav.tsx.
- "<- seasons" and "<- Team Tour 5" back links on every page, blue and underlined. The season pill and sub-nav already give the path. Remove them, or render as faint paper without underline. apps/tour/app/seasons/[name]/*/page.tsx, apps/tour/app/stats/*/page.tsx.
- Links: every name in a 247-row leaderboard is blue-underlined, which is the single biggest "spreadsheet of hyperlinks" signal on the site. Keep the underline for links inside prose; in tables use plain paper with the underline on hover only (the globals.css rule at about line 1095 re-underlines td a; limit it to .prose and p). apps/tour/app/globals.css. [shot: tour-desk-players-fold.png]
- No footer; add the shared one.

/seasons/[name] standings [shot: tour-desk-home-fold.png, tour-phone-home-fold.png]
- The team-colour bands are the signature; keep them. Put them in the league's row recipe: rank tile in panel-edge, team band, record, pct, with the viewer's team edged in gold instead of the blue inset. apps/tour/components/StandingsTable.tsx, apps/tour/app/globals.css (tr.row-mine).
- Six near-identical number columns (MATCHUPS, M %, SETS, SET %, GAMES, GAME %). Group each pair as one cell, "4-0 (100%)", so desktop has three number columns and phone needs no "More columns" button. apps/tour/components/StandingsTable.tsx.
- The explainer sentence under the h1 ("Playoff order. A matchup is a week's team-vs-team; ...") shows on every visit. Move it behind a "?" or to Rules. apps/tour/app/seasons/[name]/page.tsx.

/seasons home [shot: tour-desk-seasons-fold.png, tour-phone-seasons-fold.png]
- Five identical cards in a four-up grid leave an orphan, and the live season shows "--" where a champion would be. Make the current tour a full-width hero card ("Tour 5 - week 5 - 62 sets open - leader: mmmmmmmmmmmm") and the finished tours four-up below with the champion's team colour as the card edge. apps/tour/app/seasons/page.tsx, .season-card rules in apps/tour/app/globals.css.
- "All-time player leaderboard ->" and "All-time team leaderboard ->" are bare blue links under the grid. They are already in Stats; drop them or make them two small panels. apps/tour/app/seasons/page.tsx.

/seasons/[name]/weeks [shot: tour-desk-weeks-fold.png, tour-phone-weeks-fold.png]
- The matchup cards (two bands, two scores, "8 to play") are the best thing on either site. Give them the vs-block treatment: panel edge, hard shadow, scores in body 800 at 19px, "8 to play" as a faint eyebrow, and a gold left stripe on the band that has clinched the week. apps/tour/app/seasons/[name]/weeks/page.tsx, apps/tour/app/globals.css.
- Week chips are outline pills with the active one gold-filled. Pick'em uses filled circles (W1..W5), player rankings uses circles for seeds, the league uses chunky rarity tabs. Four chip styles for one job. Define one .tab-chip (chunky, hard shadow, press) in both repos and use it for weeks, seeds, tiers and the Hall of Fame toggle. apps/tour/app/globals.css, web/app/globals.css.

/seasons/[name]/pickem [shot: tour-desk-pickem-fold.png, tour-phone-pickem-fold.png]
- Rows show Discord custom emoji as the only team identity. Add the team colour band around the name so a pick'em row reads like a week card. apps/tour/app/seasons/[name]/pickem/MatchupPickRow.tsx, PickemSetRow.tsx.
- "WEEK 5 - 62 OPEN" is a 16px Silkscreen heading inside the card. Under the shared system it is an 11px eyebrow above the list. apps/tour/app/seasons/[name]/pickem/page.tsx.
- The sign-in callout is a card with a blue text link. Make "Sign in with Discord" the gold primary button. apps/tour/app/seasons/[name]/pickem/page.tsx.

/teams/[id] [shot: tour-desk-team-fold.png, tour-phone-team-fold.png]
- Five stat tiles in a four-up grid leave "ROSTER 11" orphaned on a second row; on phone the five tiles stack to 550px before the roster appears. Use the league's hero stat strip (four small tiles in one row, two-by-two on phone) and put the roster count in the roster table's header strip ("Roster - 11"). apps/tour/app/teams/[id]/page.tsx (.stat blocks).
- The h1 is the team name in pixel caps with no colour. The team should wear its band here, as a hero: band with emoji and name, then "Team Tour 5 - 1st of 20". apps/tour/app/teams/[id]/page.tsx, components/ColorChip.tsx (block mode already exists).
- "(C)" under a name and "5 from S6" under a seed are unlabeled. Use a gold "C" chip (same recipe as the league's "you" badge) and a seed chip. apps/tour/app/teams/[id]/page.tsx.

/seasons/[name]/players [shot: tour-desk-seasonplayers-fold.png, tour-phone-seasonplayers-fold.png]
- Three control rows (By record / Impact, Include playoff games, Seed: All 1..11) and a three-line Impact paragraph come before the first row; phone height is 6836px because each row becomes a labelled card. Collapse the paragraph to a "?" popover, put the seed filter in a select on phone, and use a compact phone row (rank, name, record, pct). apps/tour/app/seasons/[name]/players/page.tsx.
- "+4.3 *": the trailing asterisk is unexplained. Add a footnote line under the table. Same file.

/hall-of-fame [shot: tour-desk-hof-fold.png, tour-phone-hof-fold.png]
- One season at a time behind a select, and the page is a single card with 400px of empty ground under it. Show every tour as a trophy shelf (same shelf CSS as the league): champion card with the team colour edge, the bracket collapsed under it. Both products' Hall of Fame pages then look like the same room. apps/tour/app/hall-of-fame/page.tsx, shelf rules copied from web/app/v2/hall-of-fame.css.

/rules [shot: tour-desk-rules-fold.png]
- The prose panel is fine. Section headings are gold Silkscreen caps; switch to Jersey 10. Add an "On this page" index: sticky on desktop (page is 3648px), a details block on phone (7419px). apps/tour/app/rules/page.tsx, .prose rules in apps/tour/app/globals.css.

/stats/* [shot: tour-desk-players-fold.png]
- The eleven-tab stats sub-nav runs to the right edge at 1280 ("Rivalries" touches the gutter). Wrap into two rows with the chip style, or group as three menus. apps/tour/app/stats/layout.tsx or wherever the tab row lives.
- "Include playoff games" and the "Search players..." box overlap at 1280: the checkbox label runs under the input. apps/tour/app/stats/players/page.tsx.

---

## e. Backlog

Size: S = one file, under an hour. M = two to four files, half a day. L = cross-cutting. Impact: H = visible on every visit or fixes a "looks broken" moment. Decision = needs the organiser before building.

| id | change | repo | files | size | impact | decision |
|---|---|---|---|---|---|---|
| L1 | Progress bar fill gold instead of blurple | league | web/app/standings/page.tsx (212, 226) | S | M | no |
| L2 | Hide the rank tile (or faint dash) when no matches played instead of "." | league | web/components/DivisionStandingsTable.tsx (521), web/app/v2/standings-cards.css | S | H | no |
| L3 | Suppress the tie footnote when nothing is played or every value is 0 | league | web/lib/standings-cards-core.ts, web/components/DivisionStandingsTable.tsx (539) | S | H | no |
| L4 | Pass noMatchesYet on the division page so ranks and 0 PTS tiles disappear early season | league | web/app/divisions/[id]/page.tsx | S | H | no |
| L5 | Drop the "unplayed" status line under Still to play cards | league | web/app/divisions/[id]/page.tsx, web/app/v2/division.css | S | M | no |
| L6 | Replace emoji medals with rank tiles on /stats | league | web/app/stats/page.tsx (120) | S | M | no |
| L7 | Seasons list: add champion line, token pills for ACTIVE/FINISHED | league | web/app/seasons/page.tsx (30-32) | S | M | no |
| L8 | Search button to secondary panel-2 (not red) | league | web/components/CommandButton.tsx, web/app/globals.css | S | M | no |
| L9 | Links under v2: paper text, gold underline on hover (kills blurple #747ff4) | league | web/app/globals.css | S | H | no |
| L10 | Join buttons gold primary with the Discord glyph kept | league | web/app/join/page.tsx (88, 123) | S | M | no |
| L11 | Phone header: show the wordmark, drop the duplicate png glyph, login as a button | league | web/components/SiteNav.tsx, web/app/globals.css | S | M | no |
| L12 | Standings: fold progress + KEY into the h1 block; drop "round robin" words from cards | league | web/app/standings/page.tsx | S | M | no |
| L13 | Stats: two top-5 panels side by side, list tables capped at 640px | league | web/app/stats/page.tsx | S | M | no |
| L14 | Join: numbered "How it works" at body size | league | web/app/join/page.tsx | S | L | no |
| L15 | Profile: Traits header icon to Lucide; "Season not started" stat strip at 0 played | league | web/components/ProfileView.tsx | S | L | no |
| L16 | Hall of Fame: Legendary-only view as one shelf of champion cards | league | web/app/hall-of-fame/page.tsx, web/app/v2/hall-of-fame.css | M | H | no |
| L17 | Profile: two-column desktop (hero left, season history right) | league | web/app/v2/profile.css, web/components/ProfileView.tsx | M | M | no |
| L18 | Standings: one continuous grid across tiers so a one-division tier does not leave half a screen empty | league | web/app/standings/page.tsx, web/app/globals.css | M | M | no |
| L19 | Division page: replace the roster chip row with "You still play: ..." for members, cut it for visitors; "All standings" as a button | league | web/app/divisions/[id]/page.tsx, web/app/v2/division.css | M | M | no |
| L20 | Seasons page: active season hero card with progress, finished seasons two-up | league | web/app/seasons/page.tsx, web/app/globals.css | M | M | no |
| L21 | Profile: teaser line in the Deck and stake summary | league | web/components/ProfileAnalyticsSection.tsx | S | L | no |
| L22 | Shared footer component | league | web/components/SiteFooter.tsx (new), web/app/layout.tsx | M | M | yes (links and wording) |
| L23 | Season pill in the league header, copied from the Tour | league | web/components/SiteNav.tsx | M | M | yes (nav change) |
| T1 | Port the Card Table base into the Tour (tokens, felt, panel, button, chip, form, header); remove the slate preview | tour | apps/tour/app/globals.css, apps/tour/app/layout.tsx | L | H | yes (confirm burgundy felt per MASTER.md) |
| T2 | Self-host Jersey 10 / Silkscreen / Nunito Sans; headings to Jersey 10 sentence case | tour | apps/tour/app/layout.tsx, apps/tour/app/fonts/ (new), apps/tour/app/globals.css | M | H | no |
| T3 | Table links plain paper, underline on hover; prose links keep the underline | tour | apps/tour/app/globals.css (about line 1095) | S | H | no |
| T4 | Remove or fade the "<-" back links on season and stats pages | tour | apps/tour/app/seasons/[name]/*/page.tsx, apps/tour/app/stats/*/page.tsx | S | M | no |
| T5 | Standings: pair the six number columns into three "4-0 (100%)" cells | tour | apps/tour/components/StandingsTable.tsx | S | M | no |
| T6 | Team page: one stat strip, roster count into the table header, captain and seed chips | tour | apps/tour/app/teams/[id]/page.tsx | S | M | no |
| T7 | Stats: fix the checkbox and search overlap; wrap the eleven tabs | tour | apps/tour/app/stats/players/page.tsx, stats tab row | S | M | no |
| T8 | Pick'em: sign-in as a gold button; "WEEK 5 - 62 OPEN" as an eyebrow | tour | apps/tour/app/seasons/[name]/pickem/page.tsx | S | L | no |
| T9 | Header to the shared bar (keep the season pill, pill links instead of icon links) | tour | apps/tour/app/layout.tsx, apps/tour/components/MoreMenu.tsx | M | H | no (after T1) |
| T10 | Season sub-nav as a panel-2 strip with pill-active | tour | apps/tour/components/SeasonNav.tsx | S | M | no (after T1) |
| T11 | Week matchup cards as vs-blocks (edge, shadow, 800-weight scores, gold stripe on the clinched side) | tour | apps/tour/app/seasons/[name]/weeks/page.tsx, apps/tour/app/globals.css | M | H | no (after T1) |
| T12 | Standings rows in the league's player-card recipe with team bands | tour | apps/tour/components/StandingsTable.tsx, apps/tour/app/globals.css | M | H | no (after T1) |
| T13 | Seasons home: current tour as a hero card, past tours with champion colour edge | tour | apps/tour/app/seasons/page.tsx, apps/tour/app/globals.css | M | M | no |
| T14 | Team page hero: the team band as the title with emoji and standing | tour | apps/tour/app/teams/[id]/page.tsx | S | M | no |
| T15 | Hall of Fame as trophy shelves, one per tour, bracket collapsed | tour | apps/tour/app/hall-of-fame/page.tsx, shelf CSS from web/app/v2/hall-of-fame.css | M | M | no (after T1) |
| T16 | Player rankings: collapse controls and the Impact paragraph; compact phone rows; asterisk footnote | tour | apps/tour/app/seasons/[name]/players/page.tsx | M | M | no |
| T17 | Pick'em rows wear the team band | tour | apps/tour/app/seasons/[name]/pickem/MatchupPickRow.tsx, PickemSetRow.tsx | S | M | no |
| T18 | Rules: Jersey 10 headings and an "On this page" index | tour | apps/tour/app/rules/page.tsx, apps/tour/app/globals.css | S | L | no |
| S1 | One .tab-chip primitive for weeks, seeds, tiers and toggles in both repos | both | web/app/globals.css, apps/tour/app/globals.css | M | M | no |
| S2 | Merged-site URL structure (hub at root, /league/*, /tour/*, redirects) | both | new app shell, redirects | L | H | yes |
| S3 | Product switcher in the top bar (two card chips, two-row menu) | both | web/components/SiteNav.tsx, apps/tour/app/layout.tsx | M | H | yes (after S2) |
| S4 | Shared tokens and shell as one package when the repos merge | both | new packages/design-system | L | H | yes (after S2) |
