# Standings and tiebreaks

Points, scoring modes, the two tiebreak modes with the exact lives rule, the
standings cache, and which files are hand-mirrored between bot and web.

Sources: [src/scoring.ts](../../src/scoring.ts),
[src/standings.ts](../../src/standings.ts),
[src/standings-mode.ts](../../src/standings-mode.ts),
[src/standings-best-n.ts](../../src/standings-best-n.ts),
[src/standings-lives.ts](../../src/standings-lives.ts),
[src/shootout.ts](../../src/shootout.ts),
[src/standings-cache.ts](../../src/standings-cache.ts),
[web/lib/standings-cache.ts](../../web/lib/standings-cache.ts),
[web/lib/shootout-cleanup-core.ts](../../web/lib/shootout-cleanup-core.ts),
[web/scripts/sync-schema.mjs](../../web/scripts/sync-schema.mjs).

## Points

| Result | Winner | Loser |
|---|---|---|
| 2-0 | 3 | 0 |
| 1-1 | 1 each | |

W, D and L count 2-0, 1-1 and 0-2 respectively. A forfeit is written as a
2-0 and scores like one. A voided game is a 0-0 CONFIRMED row: it counts as
played and scores nothing. These numbers are constants in `src/scoring.ts`;
the rules template exposes scoring fields but `templateToSettings` ignores
them, so they cannot be changed from the UI.

## Scoring modes

`Season.scoringMode`, normalised by `src/standings-mode.ts`:

- `all` (default): every result counts.
- `best-n-count`: only each player's best N results count. A result against
  a player who later dropped is still a candidate.
- `best-n-void`: as above, but every pairing and shootout touching a DROPPED
  member is stripped before selection.

N is `scheduled - dropouts`: the division's opponents-per-player (or the
round-robin size minus one) less the number of unreplaced dropped members.
With zero dropouts the best-N engine is bypassed and plain standings are
returned. Results not counted are stored in the cache as `uncounted` and the
site labels them "not counted for standings" (`web/lib/uncounted-core.ts`).

## Tiebreak modes

`Season.tiebreak`, normalised to `chain` (default) or `lives`.

### chain

`sortStandings` in `src/standings.ts`: points, then head-to-head (a 2-0
between the two), then a recorded shootout, then wins, then draws, then name.
Under chain a shootout is effectively required to settle a tie that matters.

### lives

For a group tied on points, `orderLivesPointsGroup` in `src/standings.ts`:

Exactly two players:

1. A confirmed shootout between them decides.
2. Otherwise a 2-0 head-to-head result decides.
3. Otherwise the head-to-head lives difference inside their match decides.
4. Otherwise total net lives across the season decides.
5. Otherwise it is a real tie: both share the rank (1, 2, 2, 4 style).

Three or more players: ordered by total net lives only. Equal net lives is a
real tie and shares the rank. No shootout is asked for in a 3+ way tie.

Each row that was separated this way carries a `tiebreakNote` shown under
the name on the site, one of: shootout decided it; beat or lost to them
head-to-head; head-to-head lives decided it; total net lives decided it;
tied on points and net lives, shares the place.

The v2 "Card Table" standings merge a tie group's per-row notes into one
footnote (`groupTiebreakNotes` in `web/lib/standings-cards-core.ts`), naming
every tied player once. That merged footnote is isFinal-aware: "decided it"
wording only appears once the division is complete (every scheduled match
played) or every member of the tie is already individually clinched
(`StandingsRowExtras.clinchStatus`) -- otherwise it uses present-tense,
non-final wording instead ("net lives currently separate them (+3 / -3)",
"a shootout currently separates them", "is currently ahead/behind them
head-to-head", "head-to-head lives ... currently separate them"), since more
matches could still shift the numbers or the tie group's membership before
the division ends. A real, unbreakable tie ("shares the place") never takes
"decided it" wording in either state -- nothing was decided. The mechanism
is carried as structured data (`StandingRow.tiebreakKind`/`tiebreakValues`,
set alongside `tiebreakNote`) rather than re-parsed from the sentence; not
mirrored to the bot, since only the web's merged footnote needs it.

"Net lives" is the winner's remaining lives, entered after each game in the
match flow (see [matches-and-results.md](matches-and-results.md)), summed
with sign across a player's counted games.

### When a shootout is owed

`shootoutsNeeded` flags a pair only when an exactly-two-way tie straddles a
promotion or relegation line. When a division has every match CONFIRMED,
`runShootoutCheck` (`src/shootout.ts`) DMs both players and pings the division
channel, once per pair (marker row `shootout_notified:{division}:{pair}`).
Under `lives` the message says the shootout is optional and the shared rank
stands otherwise; under `chain` it is needed. Players play it with
`/start-match mode:shootout`, which writes a `SHOOTOUT_BO1` match.

### Shootout clean-up

`/admin/standings-preview`, "Shootout clean-up". When a season moves to
`lives`, admin-recorded showdowns that pick the same winner lives would pick
are redundant. `planShootoutCleanup` (`web/lib/shootout-cleanup-core.ts`)
sorts each one into deletable ("same") or keep ("lives-disagree",
"lives-tied", "no-lives-data", "player-reported"). Only admin-recorded rows
(`recordedBy` null) are ever deletable.

## The standings cache

`DivisionStandings.rowsJson` holds `{ rows, badge, uncounted }` per division.

- Write: `recomputeDivisionStandings(divisionId)` after anything that writes
  a match. Both the bot (`src/standings-cache.ts`) and the web
  (`web/lib/standings-cache.ts`) write the same table, so either side's
  write is seen by the other.
- Read: always through `loadDivisionStandings` (and
  `loadDivisionScoringBadge` in the same request). A cold read computes and
  stores. Web adds `loadManyDivisionStandings`, `loadDivisionUncounted`,
  `refreshStandingsCacheIfWarm` and `loadDivisionStandingsFresh`.
- Never rank from match rows directly. Season 8 ended that way and re-broke
  shootout ties alphabetically; `loadDivisionStandingsFresh` exists so
  end-season forces a recompute first.
- The bot's standings channel render recomputes before every post as a
  self-healing net (`src/standings-channel-content.ts`).
- `src/standings-cache.integration.test.ts` boots an embedded Postgres,
  seeds a division and checks recompute then load returns sorted rows.

## Mirrored files

The bot and the web each have their own copy of shared logic. Two mechanisms
keep them aligned.

### Synced automatically by `web/scripts/sync-schema.mjs`

Runs in `web`'s `postinstall` and via `pnpm sync-schema`. Copies from the
root into `web/`, stripping `.js` import extensions: `prisma/schema.prisma`,
`src/data/match-defaults.json`, `src/data/balatro-info.json`, and the files
`elowen.ts`, `schedule.ts`, `owen-placement.ts`, `match-pool.ts`,
`deck-pool-config-core.ts`, `standings-mode.ts`, `onboarding-guide.ts`,
`auto-signups-core.ts`, plus the deck and stake images. Edit the `src/` copy
only; the web copy is overwritten.

### Mirrored by hand (edit both, same commit)

These differ only by import paths, comments and side-specific helpers, and
each carries a header saying so:

- `standings.ts`
- `standings-best-n.ts` ("Mirrors web/lib/standings-best-n.ts EXACTLY")
- `standings-lives.ts`
- `standings-cache.ts`
- `uncounted-core.ts`
- `league-settings.ts` ("a hand-kept mirror ... not one of sync-schema.mjs's
  synced files")

No test enforces these pairs. Run `diff` on each pair after touching one.
The header comment in `web/lib/standings-best-n.ts` still says nothing calls
it; that is stale, both caches wire it in via `selectStandingsEngine`.

## The ladder

Divisions are not parallel groups -- every division in a season sits on ONE
ladder, ordered tier position ascending, then `Division.groupNumber`
ascending within a tier (`web/lib/division-ladder.ts`'s `buildLadder` --
same ordering convention every loader already queried by, just given a name):
Legendary at the top, then Rare 1, Rare 2, ..., Uncommon 1,
..., Common 1, ..., Common N at the bottom. The top of a division promotes
into the division directly above it on the ladder (even across a tier
boundary); the bottom relegates into the division directly below. A
division's own promotion/relegation COUNTS (`promoteCount`/`relegateCount`)
are set by hand per division by the organiser -- `buildLadder` only orders
divisions and reports each one's neighbors, it never derives or changes
those counts. The top division overall never promotes; the bottom never
relegates (both counts read as 0 there regardless of what's stored).

Surfaced on `/standings` (a compact "Ladder" strip above the division
cards), on each division page's hero ("Rung N of M . Up: X . Down: Y"), and
in the onboarding guide (`src/onboarding-guide.ts`'s "the-ladder" section,
mirrored to `web/lib/onboarding-guide.ts`).

## Zones on the standings table

`web/lib/standings-zone.ts`: a row is in the promote zone if it is promoting
or has clinched up, relegate if relegating or clinched down. On the v2 player
cards this draws as a thin gold (promote) or neutral grey-hatched (relegate)
left stripe -- the `--zone-promote`/`--zone-relegate` tokens (gold accent /
`--paper-faint` hatch, see `app/globals.css`), deliberately NEITHER a tier
color (`--common`/`--uncommon`/`--rare`/`--legendary`) nor the old
`--info`/`--admin` pairing, which clashed with the Common tier's own blue --
plus a dashed divider in the same two colors, with a real up-chevron
(promote) or down-chevron (relegate) SVG punched through it right before the
label (`DivisionStandingsTable`'s `BoundaryLabel`, not CSS `content:
attr(...)`, so the divider itself says what it is instead of relying on
color alone). The label reads "Promotion to X" / "Relegation to Y" (the bare
word when no neighbor name is known, "Top of the ladder" for the single
division at the very top of the whole ladder, nothing when relegate is 0;
phones drop the word and keep just the chevron). The per-division key under
the table reads the same "Promotion to X" / "Relegation to Y" wording with a
matching gold/grey swatch. The card's rank tile also shows a small lock
glyph in the same gold/grey hue -- SOLID (filled lock, solid ring) once a
row is decided or mid-season clinched, OUTLINED/DASHED (open lock, dashed
ring) while a row merely sits in the promotion/relegation spot today with
nothing guaranteed yet (`lib/standings-zone.ts`' `zoneCertainty`) -- and a
plain crossed-lines glyph on a tied row that still needs a shootout -- the
latter is suppressed under the "lives" tiebreak, since the per-row tie
footnote already explains the break there.

The page-level "Key" disclosure (`/standings`) shows two miniature REAL
player-card fragments (`DivisionStandingsTable`'s `ZoneKeySample`, not a bare
color swatch) demonstrating the stripe + dashed divider + chevron for
promotion and relegation, plus the line "The dashed line is the cut-off.
Players above a promotion line go up to the named division; below a
relegation line go down." -- added 2026-10 after feedback that a bare color
swatch didn't make it obvious the cut-off color was what the legend was
pointing at.

## Things to know that are not obvious

- The season archive (`/seasons/[id]`) draws the same shared
  `DivisionStandingsTable` rows as `/standings` and `/divisions/[id]` --
  avatars, tier-coloured rank tiles, and the dashes/"None played" zero-state
  for a division with zero confirmed matches, derived from `every row's
  played === 0` rather than a separate confirmed-pairing count (see
  `app/seasons/[id]/page.tsx`'s `PublicSummary`). Before this it drew plain
  initials, black rank tiles, and a misleading rank-1/0-PTS row for every
  player in an unplayed active-season division.
- Scoring points look configurable in the rules template but are not.
- Under lives, the head-to-head lives check happens between the 2-0
  head-to-head check and total net lives, exactly as listed above.
- A 3+ way tie never asks for a shootout, even on a promotion line.
