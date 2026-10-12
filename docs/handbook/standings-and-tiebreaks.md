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

## Zones on the standings table

`web/lib/standings-zone.ts`: a row is in the promote zone if it is promoting
or has clinched up, relegate if relegating or clinched down. On the v2 player
cards this draws as a thin blue (promote) or amber (relegate) left stripe --
same `--info`/`--admin` tokens the v1 table's up/down arrows use -- plus a
dashed divider labelled "Promotion"/"Relegation" (a bare chevron on phones)
below the last promoting row and above the first relegating row. The
per-division key under the table reads "Promotes to X" / "Drops to Y". The
card's rank tile also shows a small lock glyph when a row is mid-season
clinched (not yet decided), and a plain crossed-lines glyph on a tied row
that still needs a shootout -- the latter is suppressed under the "lives"
tiebreak, since the per-row tie footnote already explains the break there.

## Things to know that are not obvious

- Scoring points look configurable in the rules template but are not.
- Under lives, the head-to-head lives check happens between the 2-0
  head-to-head check and total net lives, exactly as listed above.
- A 3+ way tie never asks for a shootout, even on a promotion line.
