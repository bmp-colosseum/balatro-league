# Scheduling and roster changes

How a division's schedule is drawn, and exactly what happens when a player is
added, moved, dropped, reinstated, swapped or replaced.

Sources: [src/schedule.ts](../../src/schedule.ts) (copied to `web/lib/` by
the sync script), [web/lib/lock-schedule.ts](../../web/lib/lock-schedule.ts),
[web/lib/schedule-sync.ts](../../web/lib/schedule-sync.ts),
[web/lib/schedule-regenerate.ts](../../web/lib/schedule-regenerate.ts),
[web/lib/drop-player.ts](../../web/lib/drop-player.ts),
[web/lib/replace-division-player.ts](../../web/lib/replace-division-player.ts),
[web/lib/swap-division-players.ts](../../web/lib/swap-division-players.ts),
[src/schedule-change-text.ts](../../src/schedule-change-text.ts),
[src/schedule-locked.ts](../../src/schedule-locked.ts).

## How a schedule is drawn

There are no weeks and no dates. Each division gets a fixed opponent graph:
every player is assigned the same number of opponents for the whole season
and arranges each match on their own time.

- Target opponents = the graph degree. Default 4, from
  `defaultOpponentsPerPlayer` in `placement_rules`. A division can override
  it (`Division.opponentsPerPlayer`, set on `/admin/divisions`). It is
  clamped to size minus one, so a 5-player division at target 4 is a full
  round robin.
- `generateSchedule` (`src/schedule.ts`): sort players by MMR, seed a
  circulant graph (each player linked to their MMR neighbours), then run
  degree-preserving swaps to minimise the variance of each player's
  sum-of-opponent-MMR. Up to 8 restarts of 100 passes. Seeded PRNG with seed
  1, so the same roster and MMRs give the same draw.
- Avoided pairs (`/admin/avoided-pairs`) are passed as `forbidden`. The
  generator repairs around them when it can; pairs it cannot avoid are listed
  in `ScheduleResult.unavoidable` and shown to the admin.
- "Locked" means the pairings exist as PENDING 0-0 `LEAGUE_BO2` Match rows,
  written by `lockDivisionSchedules` at activation. `Season.scheduleLocked`
  is a fast path; the real test is "does a 0-0 PENDING match exist"
  (`isScheduleLocked` in `src/schedule-locked.ts`).

## The resync, which every roster change goes through

`resyncSeasonSchedules` (`web/lib/schedule-sync.ts`) runs per division:

1. Delete PENDING 0-0 matches that involve someone no longer active.
2. If refilling is allowed and `needsCleanRegenerate` says so, delete every
   `LEAGUE_BO2` match in the division and redraw it from scratch with
   `lockOneDivision`. Affected players get the "regenerated" DM.
3. Otherwise `planDivisionResync` (`src/schedule.ts`) only ADDS pairings
   between two players who both still need a game, up to the target. It never
   removes or replaces a valid existing match. Affected players get the
   "changed" DM.

`needsCleanRegenerate` returns true only when all three hold: at least two
active members, every match in the division is still an unplayed 0-0
PENDING row, and at least one member's current opponent count differs from
the target (capped at size minus one). So:

- Any division with a single result is only ever patched.
- An untouched division is redrawn only if patching would leave it uneven.
  A balanced untouched division is left alone.
- A 6th player joining a full 5-player round robin triggers a redraw
  (this was Season 9, Rare 1).

The rule "nobody ever plays an extra game" is structural: `planDivisionResync`
adds a pairing only where both sides are below their cap. With an odd number
of players short, one player stays one match short.

## Adding a player

`/divisions/{id}`, Admin tools, "Add player by Discord ID", "Add to
division". Mid-season only. The resync then patches or redraws as above and
DMs whoever's opponents changed. Existing results are never touched.

## Dropping a player

Two buttons, on `/divisions/{id}` and on `/profile/{id}`: "Drop and refill"
and "Drop, no new matches". `dropPlayerFromDivision` (`web/lib/drop-player.ts`):

1. Membership becomes DROPPED with `droppedAt` and a reason.
2. Unplayed PENDING matches against the leaver are deleted. Played results
   against the leaver stand (only `status: PENDING` rows are touched).
3. If the season is a best-N mode, the division's count becomes
   `scheduled - droppedMembers`, so the count falls by one per dropped player.
4. Refill: ex-opponents get replacement pairings via the resync, never past
   their slate. No new matches: ex-opponents end one match short.
5. Standings are recomputed and the standings channel refresh is queued. An
   audit row `division.drop` records "opponents refilled" or "no new matches".
6. Discord division role and channel access are NOT removed by a plain drop.

### The DMs (`src/schedule-change-text.ts`)

Two roles, both beginning "Schedule update -- {division}." and ending "Here
is your current schedule:" followed by the player's schedule.

- "changed" goes to players whose own opponents changed: "Your match against
  **X** is off -- they left the division, so if you had a time arranged it no
  longer counts." then either "You now play **Y** instead -- reach out to set
  up a time." or, under best-N, "You now play **Y** instead. That match is
  optional: play it if you can find a time, and if you can't, nobody is
  marked down for it." then "Everything else on your schedule stays as it
  was."
- "notice" goes to everyone else still active in the division: "**X** has
  left the division. Your own matchups have not changed -- keep playing them
  as planned."
- Under best-N both add: "From now on only your best N results count toward
  the standings, so nobody is worse off for having one match fewer."

The sending worker is `notify.schedule-change` in `src/queue.ts`. The test
file `src/schedule-change-text.test.ts` pins the exact strings.

## Reinstating a dropped player

Two buttons that do different things:

- `/profile/{id}`, "Reinstate" (`reinstatePlayer` in
  `web/app/admin/players/actions.ts`): refuses banned players, sets the
  membership ACTIVE, then runs the full resync so the player gets matches
  again, then refreshes standings.
- `/divisions/{id}`, "Reactivate" (`reactivateDivisionMember`): only sets
  the membership ACTIVE. No resync, no standings refresh. The player can sit
  ACTIVE with zero matches until something else triggers a resync.

Use the profile page button. Neither path sends a DM by itself; the resync
may send "changed" DMs.

## Swap and replace (pre-results only)

- "Swap" (`/seasons/{id}`, Roster tools): trades two ACTIVE players between
  two divisions, each inheriting the other's pairings by repointing match
  rows. Refused if either has any non-0-0 match, is banned, or they share a
  division. Division roles are swapped. Sends no DM at all.
- "Replace" (`/divisions/{id}` or `/seasons/{id}`): substitutes a brand-new
  person for a departed active member, handing them the exact pairings.
  Refused if the departed player has a result, if the replacement is already
  in the season or banned, or is not in the guild. Departed becomes DROPPED.
  DMs: the newcomer gets role "new", each surviving opponent gets role
  "opponent" (wording in `src/queue.ts`).

Once a result exists, both are blocked; drop and refill is the tool.

## Hard remove

`/divisions/{id}`, "Remove" (red). Deletes the membership and all of the
player's pairings in that division, with no confirm dialog. Use only to undo
a mistaken add before anything was played.

## Regenerate buttons on /admin/divisions

Under "Advanced schedule tools": "Re-sync schedules" (the resync above, season
wide), "Regenerate whole season", and per division "Regenerate just this
division". The two regenerate actions refuse with `games-already-played` if
any match in scope has a result.

## Things to know that are not obvious

- A plain drop leaves the player's Discord role and channel access in place.
- "Reactivate" on the division page does not give the player a schedule.
- Swap is silent; every other roster change DMs the people affected.
- The draw is deterministic (seed 1). Two admins previewing the same roster
  see the same schedule.
