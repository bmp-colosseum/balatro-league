---
name: verify
description: Build, run and screenshot the League locally against seeded data
---

# verify

Prove a web change actually works -- a real production build, served
against seeded data shaped like production (4 tiers, 13 divisions), with
screenshots and measurements -- without any production database access. The
sandbox cannot reach the production Postgres: the `.env`/`.env.local`
credentials fail auth from here. This skill is the replacement for "try it
against the real DB."

Everything lives under `web/`: `scripts/verify-env.mjs` (boot), `scripts/shoot.mjs`
(screenshot + measure), `lib/seed-verify.ts` (the seeded dataset),
`app/api/admin/seed-verify/route.ts` (the endpoint that drives it).

## Start

From `web/`:

```
node scripts/verify-env.mjs
```

Run this **in the background** (Bash tool `run_in_background: true`, or `&`
from a shell) -- it is a long-lived supervisor, not a one-shot command. It:

1. Picks two free ports dynamically (Postgres + web) so two agents can run
   this concurrently without colliding.
2. Boots an embedded Postgres (throwaway, `persistent: false`, UTF8 encoding
   forced -- see Gotchas).
3. Runs `prisma migrate deploy` from the **repo root** (`/d/wt-verify`, not
   `web/`) against it -- the root has the real migration history; `web/prisma`
   is a schema-only sync copy with no `migrations/` dir, so `npm start`'s own
   migrate step there is a no-op by design.
4. `next build` then `next start -p <port>` (a real production build, not
   `next dev`).
5. Seeds via one POST to `/api/admin/seed-verify` (see "What gets seeded").
6. Prints `VERIFY_URL=http://localhost:<port>` and blocks forever.

Options: `--skip-build` (reuse the existing `.next`, fast iteration after the
first run), `--players 60`, `--no-open-signups`, `--no-reset`.

It writes `.verify-env-state.json` + `.verify-env.log` in `web/` (gitignored).
If a prior run's state file is already there, start refuses -- `--stop` first.

## Stop

```
node scripts/verify-env.mjs --stop
```

Tears down by the PID this script's own process recorded (`taskkill /pid <it>
/f /t` on Windows, a tree-kill scoped to that one supervisor) -- **never** a
system-wide kill, never `taskkill /IM node.exe`. Always run `--stop` when
you're done, even after a failed run (the server usually stays up for
debugging -- see "If seeding fails" below).

## Shoot

```
node scripts/shoot.mjs /standings --width 390
node scripts/shoot.mjs /divisions/<id> --width 1280 --full --out shots/division-1280.png
```

Reads `VERIFY_URL` from the environment if the target is a relative path (`export
VERIFY_URL=http://localhost:<port>` after start prints it, or pass a full URL).
Prints one JSON line: `overflow` (horizontal scroll past the viewport -- 0 is
clean), `h1Count`, `title`, `canonical`, `robots`, `consoleErrors`. Screenshots
land in `web/shots/` by default (gitignored).

Uses this repo's own `playwright` dependency. If a project doesn't have
`playwright` installed (only `@playwright/test`), set
`PLAYWRIGHT_MODULE_PATH=D:/balatro-team-tour/node_modules/playwright/index.js`
as a documented fallback.

## What gets seeded

One POST to `/api/admin/seed-verify` (ADMIN_TOKEN-gated, same pattern as the
existing `/api/admin/seed-e2e`) builds, via `web/lib/seed-verify.ts`:

- **An active season**: `owenLadder(80)` -> 1 Legendary + 4 Rare + 4 Uncommon +
  4 Common = **13 divisions**, matching what ux-audit observed in production
  Season 9 (`.claude/knowledge/ux-audit/01-findings.md`). Default
  promote/relegate counts (1 up/down per division boundary). `tiebreak: "lives"`
  (Season 9's actual setting), mixed played/unplayed matches (`playFraction
  0.65` -- the rest are real PENDING fixtures from the schedule lock, not just
  absent pairs). A deterministic 3-player scenario is hand-crafted into one
  division: two clean 2-0s plus a 1-1 draw between the two leaders, with
  different `winnerLives` on each side of that draw -- so the points-tie
  footnote and the net-lives tiebreak text both reliably render, instead of
  depending on random match outcomes.
- **A finished season**: fully played (`playFraction 1`), then ended via the
  real `endSeasonCore` -- gives `/seasons` a FINISHED card with a champion and
  an entry on `/hall-of-fame`.
- **Players with match history and earned traits**: persona-driven match
  generation (reused from `lib/seed-e2e.ts`'s `seedMatchesForSeason`) gives
  each player a varied pick/ban history; traits are computed lazily from that
  history the first time a profile page loads (no separate seeding needed).
- **The open-signups toggle**: `openSignups: true` (default) leaves one OPEN
  `SignupRound` with a small newcomer roster, so `/join` shows the "signups
  open" state; `openSignups: false` leaves none (the between-seasons state).

Reseed with different shape: `--players 60` (owenLadder gives 1/3/3/3 = 10
divisions below 78 signups), `--no-open-signups`, `--no-reset` (keep prior
verify-* data instead of wiping it first).

## Pages worth checking

- `/` , `/standings` (the merged standings page)
- `/divisions/<id>` -- pass a seeded division id (returned by the seed POST's
  JSON as `tieDivisionId`, or read any `Division.id` from the DB)
- `/seasons` (archive -- should show one ACTIVE + one FINISHED card)
- `/join` (signups-open state, toggle with `--no-open-signups`)
- `/hall-of-fame`

## Gates (same ones the dev-agent leaf contract expects)

```
cd web && npx tsc --noEmit -p .
npx vitest run src web/lib          # from repo root
cd web && npm run build
cd web && npx playwright test e2e/mobile.spec.ts   # now on dynamic ports
```

`npx playwright test` boots its OWN embedded Postgres (separate from
verify-env.mjs's) via `e2e/server.mjs` -- both now pick free ports
dynamically (`scripts/lib/get-free-port.mjs`), so an e2e run and a
verify-env run (or two agents each running one) no longer collide on a
hardcoded port.

## What "verified" means for a leaf

Before reporting a UI/behavior change done:

1. Screenshot the affected page(s) at **390px** (phone) and **1280px**
   (desktop) via `shoot.mjs`.
2. Include both JSON measurement lines in the report (`overflow` must be 0 or
   near it; `consoleErrors` should be empty unless pre-existing/expected).
3. State the acceptance numbers the task asked for in your own words (e.g.
   "13 divisions, 4 tiers, tie footnote renders on Legendary" ) -- don't just
   paste a screenshot and call it done.
4. Run `--stop` when finished so the next agent isn't blocked by a stale
   `.verify-env-state.json`.

## Gotchas

- **No production DB from the sandbox.** `.env`/`.env.local`'s
  `DATABASE_URL` will not authenticate here. Always use verify-env's embedded
  Postgres, never try to point at production.
- **UTF8 encoding, not the Windows default.** `embedded-postgres`'s `initdb`
  on Windows defaults to the OS codepage (WIN1252), which then fails to apply
  any migration containing a non-Latin1 character -- e.g. a `COMMENT ON
  COLUMN` generated from a Prisma schema doc-comment that quotes the "^/v"
  promote/relegate arrows. Both `scripts/verify-env.mjs` and
  `e2e/server.mjs` now pass `initdbFlags: ["--encoding=UTF8", "--locale=C"]`
  to force it. If you ever hand-roll a THIRD embedded-Postgres caller, copy
  that flag too.
- **Activation locks the schedule -- seed results before you activate.**
  `performSeasonActivation` always calls `lockDivisionSchedules`, which
  pre-creates PENDING matches for a 4-regular opponent graph (idempotent --
  "existing matches are never touched"). `seedMatchesForSeason`
  (`lib/seed-e2e.ts`, reused by `seed-verify.ts`) blind-`create()`s a result
  per played pair instead of finding-or-updating, so if you activate
  (locking the schedule) BEFORE seeding match results, any pair the graph
  also happens to pick collides with a unique-constraint error. `seed-verify.ts`
  seeds results first, then activates -- if you add another seed path that
  calls both, keep that order, or fix the root cause in `seedMatchesForSeason`
  itself (out of scope here since it's shared with the real e2e test).
- **web's own `prisma migrate deploy` is a no-op.** `web/prisma/schema.prisma`
  is synced from the repo root by `scripts/sync-schema.mjs`, but
  `migrations/` is never synced -- `web`'s own `npm start` migrate step
  silently finds zero migrations. `verify-env.mjs` runs migrate deploy from
  the repo root instead, where the real migration history lives.
- **ASCII only** in anything you write back to the repo (code, commit
  messages, this file). No smart quotes, no em-dashes, no emoji.
- **Handbook rule**: any change a player or admin could notice updates the
  matching `docs/handbook/` page in the same commit (see root `CLAUDE.md`).
  verify-env itself is a dev tool, not player/admin-facing, so it's exempt --
  but a UI change you verify with it probably isn't.
- **Never a system-wide kill.** `--stop` only ever targets the PID this
  script's own process wrote to its state file. Don't reach for
  `taskkill /IM node.exe` or `pkill node` even if a run looks stuck -- other
  agents' Next/Postgres/e2e processes are very likely running on the same
  machine at the same time.
