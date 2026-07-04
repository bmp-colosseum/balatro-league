# Team Tour — Design Doc

_v0.3 — Phase 0 underway. Source-grounded pass: every live sheet in
`D:\STuffinside` (TT10 rules + a completed 20-team season + the `alltime/`
cross-season DB) was mined and folded in. New detail and **corrections to v0.2**
live in **§12**; the operational truth there overrides the earlier sketch where
they conflict._

Pizza Power **Team Tour**: captains draft players, teams play weekly 1v1
best-of-X sets, regular season → playoffs, persisting across seasons (rings,
Hall of Fame). Built on a **shared match core** extracted from the Balatro
League app, as its **own application**.

---

## 0. Decisions locked (rounds 1–4)

| # | Decision | Choice |
|---|---|---|
| Match coupling | Core `Match` is **competition-agnostic** (no `divisionId`); host app links it | ✅ Decouple fully |
| League migration | League moves onto the core **later**, not now | ✅ Later |
| Hosting | **Fully separate** — own Railway services + DB + Discord bot token | ✅ Separate |
| Seeds | Seed = **draft pick order** (committee-set draft order, lowest picks first) | ✅ |
| Draft UX | **Live async draft tool** (your-turn pings, multi-day) | ✅ |
| Pairings | **Guided ±2-seed negotiation tool**, with **TO override** for dead-ends | ✅ |
| Set length | **Variable** (Bo-X, default per season — Bo3 or Bo5; players may agree higher) | ✅ |
| Schedule | **Auto-generate** (round-robin + rival week + cross-conf + seeded week) | ✅ |
| Conferences | **Configurable N** per season (names + team counts vary) | ✅ |
| Match flow | **Bot guided flow AND manual `/report`** both supported | ✅ |
| Stake/deck | **Reuse the league `MatchConfigPreset`** system (white-stake + ban policy = a preset) | ✅ |
| Subs | **TO swaps a player**; lineups versioned per week | ✅ |
| Captain self-pick | Captain **picks themselves** at their seed round during the draft | ✅ |
| Repo | **Monorepo** — this repo (`BalatroLeague`) is the root. `packages/match-core` + `apps/tour` are added **alongside** the existing league; the league stays at its current paths (keeps deploying) and migrates into `apps/league` **later** (per the League-migration decision) | ✅ |
| Cross-season | **Model season-spanning now** (Player/Team/Championship/Award), build the cross-season views (Hall of Fame, all-time LB, rings, H2H) in Phase 3 | ✅ |
| Officials/casters | **Skip for season 1** → Phase 3 | ✅ |
| Signups | **Tour-specific signup** (capture availability/timezone + captain-volunteer flag) feeding the draft pool | ✅ |
| BMP MMR | **Display only** — independently scrape BMP rank (shared `balatromp` util) to show on profiles / help captains; **not** used for seeding | ✅ |
| Set length | **Per-season config** with a default (Bo3 or Bo5); players may agree higher per set | ✅ |

**All major design decisions are settled.** The doc is ready to drive Phase 0.

> **Transitional layout (so the live league never breaks):** Phase 0 adds
> `packages/match-core` and `apps/tour` next to the existing `src/` + `web/`.
> The league keeps deploying from its current paths unchanged; moving it into
> `apps/league/` (and updating Railway build paths) is a separate, later step.

---

## 1. The core insight & terminology

A **Set** (1v1, best-of-X, deck ban/pick, lives, report→confirm, DC rules) ≈ a
league **`Match`**. We extract that engine and wrap Team Tour structure around it.
**We adopt the event's own terms** to avoid confusion:

| Team Tour term | Our model | Notes |
|---|---|---|
| **Game** | core `Game` | one Balatro game |
| **Set** | core `Match` (wrapped by `TourSet`) | a 1v1 best-of-X between two players |
| **Matchup** | `Matchup` | a team-vs-team week; N parallel Sets; majority of Set wins takes it |
| **Week** | `Week` | round-robin / rival / cross-conf / seeded / playoff |

---

## 2. Architecture: shared core, separate app

```
balatro/ (workspace, npm/pnpm workspaces)
  packages/match-core/
    prisma/core.prisma   ← Player, Match, Game, GameDeck, MatchConfigPreset
    src/                 ← ban/pick state machine, lives, win/DC resolution,
                            report→confirm→dispute, deck-pool gen, Discord
                            match-thread helpers (framework-agnostic TS)
  apps/
    league-bot / league-web   ← existing app (adopts core LATER)
    tour-bot   / tour-web     ← NEW Team Tour app (its own DB + Discord bot)
```

- **Core `Match` is competition-agnostic** — no `divisionId`. Tour links via
  `TourSet.matchId`; the league links from its side when it migrates.
- **Schema:** Prisma multi-file folder — each app's `prisma/` = synced `core.prisma`
  + its own `app.prisma`. (Reuse the existing `sync-schema.mjs` idea.)
- **Per-app DB.** Tour gets its own database. Players are identified by Discord ID
  (global), but the events don't share storage.
- Each app is **bot + web** — but for the Tour, **web is the primary surface** and
  Discord is the identity/notify/match-execution layer. Full architecture (surface
  split, read models, real-time, `tour-core`/`tour-db`, UX targets) is **§13**.

---

## 3. Reuse map

| Need | Status |
|---|---|
| 1v1 best-of-X, deck ban/pick, lives, report→confirm, disputes | ✅ core |
| Deck/stake config (white + ban policy) | ✅ core `MatchConfigPreset` |
| DC ruleset (pre/post a threshold turn → replay / forfeit) | ✅ core DC policy (threshold configurable) |
| Bot guided flow **and** manual `/report` | ✅ both exist |
| Audit, profiles, Discord channel/role bootstrap | ✅ reusable |
| Teams, conferences, weeks, matchups, draft, pairings, playoffs | ❌ new |
| Per-week lineups, rivals, coinflip, officials, awards, cross-season | ❌ new |

**Ban policy note:** TT's "ban 5 → pick 3 → choose 1 of 3" is a different *shape*
than the league's current ban policy. The core policy needs a small extension to
express it. (Phase 0.)

---

## 4. Data model (sketch — `tour/app.prisma` + cross-season)

### Season-spanning identity
```prisma
model Player   { id; discordId @unique; displayName; /* + balatromp link */ }
model Team     { id; name; /* persists across seasons; per-season via TeamSeason */ }
```

### Per-season competition
```prisma
model TourSeason {
  id; name; teamSize Int; setsToWin Int; defaultBestOf Int;
  state TourState;            // SIGNUPS|DRAFTING|REGULAR|PLAYOFFS|DONE
}
model Conference { id; seasonId; name; }            // names vary per season

model TeamSeason {                                   // a team's entry in a season
  id; seasonId; teamId; conferenceId; captainPlayerId;
  seed Int;                                          // team seed = captain's draft seed
  rivalTeamSeasonId String?;                         // pre-draft chosen rival (Rival Week)
}
model Roster {                                       // per-WEEK lineup snapshot (subs)
  id; teamSeasonId; weekBlock String;                // "W1-4" | "W5-8" | "PLAYOFFS"
  entries RosterEntry[];
}
model RosterEntry { id; rosterId; playerId; seed Int; isCaptain Boolean; }
```

### Signups (the draft pool)
```prisma
model Signup {                                       // hybrid signup → committee curates
  id; seasonId;
  discordId; displayName String?;                    // discordId = the KEY; name is a snapshot
  timezone String?; availability String?;            // COARSE soft helper only (§14.4)
  willingToCaptain Boolean; bmpHandle String?;       // BMP rank = display-only (§0)
  status SignupStatus;                               // PENDING|APPROVED|REJECTED|WITHDRAWN
}
// APPROVED signups = the pool. Player rows are upserted (by discordId) at draft
// time, when TourSet/Match need core Player.id; DraftPick.playerId is that id.
```

### Weeks, matchups, sets
```prisma
model Week {
  id; seasonId; number Int;
  kind WeekKind;             // ROUND_ROBIN|RIVAL|CROSS_CONF|SEEDED|PLAYOFF
  opensAt; deadlineAt;       // sets PLAYED by Sun 23:59 ET (see §12.1)
}
model Matchup {              // team vs team, one week
  id; weekId; teamSeasonAId; teamSeasonBId;
  sendFirst String?;         // who sends first (coinflip; higher seed auto in playoffs)
  officialPlayerId String?;  // assigned caster/official ("Advantages")
  // derived: setsWonA/B → winner at setsToWin
}
model TourSet {              // a 1v1 best-of-X inside a Matchup
  id; matchupId; matchId String? @unique;   // ← core Match (null until played)
  playerAId; playerBId; seedA Int; seedB Int;
  bestOf Int;
  status SetStatus;          // PROPOSED|SCHEDULED|REPORTED|CONFIRMED|DISPUTED|FORFEIT
  scheduledAt;
}
```

### Draft
```prisma
model Draft     { id; seasonId; order String[]; state DraftState; }   // snake order of teams
model DraftPick { id; draftId; round; pickIndex; teamSeasonId; playerId String?;
                  onClockAt DateTime?; pickedAt DateTime?; }          // cosmetic clock (no deadline)
```

### Playoffs
```prisma
model PlayoffEntry { id; seasonId; teamSeasonId; seed Int; viaWildcard Boolean; }
model PlayoffSeries{ id; seasonId; round PlayoffRound; teamAId; teamBId; matchupId String?; }
```

### Cross-season (the `alltime/` layer)
```prisma
model Championship  { id; seasonId; teamId; }             // "rings"
// Awards are custom + MULTI-SLOT (built 2026-07-03): a preset `kind` OR a custom `title` +
// optional `description`, with one or more AwardRecipient slots (player XOR team + note).
model Award          { id; seasonId; kind AwardKind?; title?; description?; sortIndex; recipients[]; playerId?; teamId?; meta Json?; }
model AwardRecipient { id; awardId; playerId?; teamId?; note?; sortIndex; }  // onDelete Cascade
// AwardKind presets: MVP|ROOKIE|COMEBACK|CAPTAIN|MOST_IMPROVED|BEST_SET|BIGGEST_STEAL.
// LEGACY imported awards keep their single recipient in Award.playerId/teamId/meta.team; the read
// models fold "recipients else legacy" so imports render with no data migration.
// Best-Set meta = the set; Biggest-Steal meta = draft pick #.
// All-time leaderboard, Hall of Fame, H2H history, draft classes = derived views.
```

(Illustrative — fields firm up in Phase 0/1.)

---

## 5. Standings & tiebreakers

Per conference, W–L at **three levels**: **Matchups (weeks)**, **Sets**, **Games**.
Tiebreaker order (from the rules):
1. **Matchup record** (primary)
2. **Set record** (W% across 1v1 sets)
3. **Game record** within sets
4. **In-conference record**
5. **Head-to-head**

Computed at three grains, all derived from per-set + per-game results + the
weekly roster (the **derivation pipeline** is spelled out in §12.3). The
game-record level uses **G% (game-win %)** as the comparable metric, and variable
set lengths are normalized to Bo3 terms first — the exact table is in **§12.4**.

(The live sheet only sorts on matchups — note: _"tie breakers are not programmed
correctly."_ We implement the full chain.)

---

## 6. Core flows

### 6.1 Draft (snake, async)
Committee sets team draft order (lowest seed picks first). Snake forward/reverse
per round. On your turn: pick from the pool → next captain pinged. **Captain picks
themselves** in their **committee-set self-pick round** — "the round they are
seeded to be selected" (TT10 rules), a per-captain valuation in `1..rounds`. (NOT
the team's draft position: real seasons have more teams than player-rounds — e.g.
18 teams, 7 rounds — so most captains' draft seed exceeds the round count. The
self-pick round is supplied as data to `buildDraft`.) Each pick's order = that
player's intra-team seed (= the round).

### 6.2 Weekly pairings (guided ±2-seed + coinflip)
Per Matchup: a **coinflip** sets who sends first (higher seed auto-wins in
playoffs). Captains alternate **propose → respond**; the responder may only pick a
player **within ±2 seeds** of the proposed one. Tool tracks used players, validates
±2, creates `TourSet`s. **TO override** for dead-ends/subs.

### 6.3 Playing + reporting a set
Through the tour-bot guided flow (ban/pick + lives + winner vote → recorded) **or**
manual `/report`; results post to `#results` and require **both players to confirm**
(reaction or button) → Set `CONFIRMED`. Disputes via core.

### 6.4 Schedule generation
Per season: in-conference **round-robin** (circle method), **Rival Week** (each
team vs its pre-draft rival), **Cross-Conference Week**, **Seeded Week** (#1 vs
#last, mirrored). Generator adapts to conference sizes — **byes for odd team
counts** — and TOs can tweak. (The `TD*work` tabs are the TO's manual round-robin
scratch we're automating; mechanics in §12.6.)

### 6.5 Playoffs
Qualify **top N per conference** (TO-confirmed: **top 4 each** → 8 with 2
conferences; configurable `perGroup`/`fieldSize`). Seed by the §5 chain — **weeks →
sets → game WIN-RATE** (rate, not raw count, so more 2-0 sweeps outrank more 2-1s
when sets tie). Single-elim **QF → SF → Final**, one round per week (8 → 4 → 2),
full team matchups. (Re-seed-by-choice was an earlier proposal; the live rule is
straight seed-by-the-chain. `competition-core` supports both — `qualify` +
`standardBracketPairings`.)

### 6.6 Officials / casters ("Advantages")
A pool of officials assignable per Matchup (`Matchup.officialPlayerId`). Optional —
who casts/streams/holds the send advantage. **Likely Phase 3+.**

---

## 7. Not code — policy / TO discretion
Conduct, warnings, extensions, stream-sniping, sub approvals, mid-set coaching,
restart etiquette — human judgment. At most a lightweight **warning log** later. We
**surface** (e.g. un-played sets past the Sunday-night ET deadline, §12.1) but
don't auto-enforce.

---

## 8. DC ruleset (configurable, from the docs)
Reconnect → continue. DC **before** the threshold (pre-PvP / pre-turn-3, per season)
with no reconnect → **replay the game**. DC **at/after** the threshold → **the
disconnector forfeits that game**. Malicious DC / server issues → TO discretion.
Maps onto the core DC policy with a configurable threshold.

---

## 9. Phased build plan
- **Phase 0 — extraction:** carve out `match-core` (decouple `Match` from
  `Division`, workspace + schema sync, extend ban policy for ban-5/pick-3/choose-1).
- **Phase 1 — admin MVP:** Season/Conference/TeamSeason/Roster/Week/Matchup/TourSet
  schema + TO tools to make teams, seed via draft order, **auto-generate schedule**
  (round-robin + byes, §12.6), and the **stats pipeline** (§12.3): **3-level
  standings + tiebreakers**, **Bo-X→Bo3 normalization** (§12.4), **G% + overall
  cross-conf seeding** (§12.5), per-player season stats + rosters views. Sets via
  core; draft + pairings by hand at first. → runnable event.
- **Phase 2 — captain tooling:** live **snake draft** + **guided pairing
  negotiation** (coinflip, ±2, TO override).
- **Phase 3 — the rest:** playoffs (wildcards + re-seed-by-choice), self-scheduling +
  deadlines, officials/casters ("Advantages", §7-validated), and the full
  **cross-season `alltime/` layer** (§12.7) — Game Log as source of truth, Drafts,
  Awards (7 kinds), Player/Team LB, Hall of Fame, Ring/Finals/Playoff/Season
  counters, Draft Classes, Rookie Rankings, player-vs-player Matchup History.
- **Out of scope (noted, not planned):** the **Daily Grid / "DojoGrids"** puzzle
  game (§12.8) — a separate attribute-guessing app, not part of the Team Tour.

---

## 10. Resolved (was "open")
- **Cross-season:** model season-spanning entities now, build the views in Phase 3.
- **Officials/casters:** skip season 1 → Phase 3.
- **Set length:** per-season config + default; per-set override by agreement.
- **Signups:** **Tour-specific** signup — capture **availability/timezone** and a
  **captain-volunteer** flag, feeding the draft pool.
- **BMP rank:** scrape independently (shared `balatromp` util), **display only** —
  not used for seeding (seeds = draft order).

## 11b. BUILD STATUS — resume here

> **⚠️ CURRENT STATE / HANDOFF: see [`apps/tour/HANDOFF.md`](../apps/tour/HANDOFF.md)
> first.** It's the up-to-date snapshot (read-side showcase complete, write-side
> partial, identity tools, deploy prepped, open items, gotchas). The status notes
> below predate the "showcase-first" pivot and are partly historical.

_If you're a new conversation: read this doc top-to-bottom, then continue from
"Next" below. All design decisions are settled (§0, §10). The **league app
(`src/` + `web/`) is intentionally untouched** and still deploys — don't move or
modify it; Team Tour is additive._

### ⭐ Overnight-build handoff (read me first)

**A working website exists at `localhost:4000`**, serving the real imported history
(**4 seasons** — 3 Swiss + **TT10 conferences** · 76 teams · 355 players · 2007 sets
+ TT10's 70 team matchups). To run it (from `apps/tour`): `npm run dev:db` (terminal
1) + `npx next dev -p 4000` (terminal 2). Data persists in `apps/tour/.dev-db`;
`npm run import` (alltime) + `npm run dev:db` then `node scripts/import/run-tt10.mjs`
(TT10) repopulate from the sheets.

**Live pages:** `/` (season cards w/ champions + format badges) · `/seasons/[name]`
(standings via `competition-core` + champion-run bracket OR projected top-4 bracket
for conf seasons; conferences shown as labeled tables) · `/teams` (all-time team LB) ·
`/teams/[id]` (roster + per-player records) · `/players` (all-time LB) ·
`/players/[id]` (career + per-season + head-to-head) · `/hall-of-fame` (all champions
+ runs). Full click-through navigation + nav header.

**TT10 conference season** ✅ imported the clean way (conferences ← Standings, team
matchups ← Work block 1; `Matchup` gained score fields + a matchup-based standings
path). Renders as real 2-conference (Pluto/Eris) standings + a projected top-4
bracket (qualify → seed → QF, exercised on real data).

**Write/admin side ✅ (API-driven — user principle: NO bespoke logic in scripts).**
All logic lives in `apps/tour/lib/services/` (`seasons.ts` CRUD, `import.ts` ingest);
**API routes** (`/api/admin/seasons` GET/POST/DELETE, `/api/admin/import?type=...`)
AND **server actions** AND a thin CLI all call the SAME services — one impl, many
entry points. `/admin` dashboard (dev-admin via `TOUR_DEV_ADMIN=1`; real auth =
NextAuth Discord + RoleBinding later) has a create-season form + import buttons.
Sheet PARSERS are reusable utils in `lib/import/`; the old import `.mjs` scripts were
deleted (logic moved into the service).

**Repo health:** all green — match-core 13 / competition-core 14 / tour-core 29
tests, league typecheck + 26 tests (untouched), Tour web production-builds (8 routes).

**Deferred — needs you (NOT bugs):**
- **TT10 player rosters** — root `Team Rosters` has a drifting column-block layout
  (fragile); TT10 has team-level standings + bracket but no per-player pages yet.
- **Awards** — `alltime/Awards.html` is a messy multi-block sheet spanning 12
  seasons (only 3 imported); needs careful per-category parsing. (§27)
- **Historical formats/splits** — the 3 alltime seasons are tagged SWISS (correct
  single tables) until you confirm which were conferences + provide the splits.
- **Write/admin** (TO logging, draft/pairing live tools) — needs the **Tour Discord
  OAuth creds + bot token** (public read works now).

**Still all uncommitted** — big coherent body of work (3 packages + web app + import
pipeline + schema + workspace + docs); recommend committing (held off per earlier ask).

**Done (Phase 0):**
- ✅ `packages/match-core/` — `prisma/core.prisma` (competition-agnostic engine
  schema) + `src/match-state.ts` (pure ban/pick state machine). Typechecks.
- ✅ `apps/tour/prisma/schema/` — `core.prisma` (synced copy) + `tour.prisma`
  (full Team Tour model). Merged schema **validates**. `npm run sync:core` keeps
  the core fragment in sync.
- ✅ Verified the league bot + web typecheck and its 26 tests pass — untouched.
- ✅ Ported the Prisma-dependent engine into `match-core` (was "Next 1"):
  `src/result.ts` (`resolveSeriesResult` — pure per-game→series tally:
  `gamesWonA/B`, `winnerId`, `hadDc`) + `src/match-write.ts` (`writeMatchGame` /
  `writeMatchGames` over an **injected** `MatchWriteClient` instead of importing a
  client — each app supplies its own generated PrismaClient). Ban attribution is
  now policy-derived (was the league's hardcoded `>= 4`). Exported from `index.ts`;
  match-core typechecks. League left untouched (still uses its own `src/match-write.ts`
  until the later League-migration step).
- ✅ Generalized `BanPickPolicy` into a **data-driven step list** (was "Next 1"):
  a policy is now `{ poolSize, steps[] }` where each step is `{ kind: BAN|PICK|
  CHOOSE, by: FIRST|SECOND, count }`. `phaseFor` walks the steps. Presets:
  `LEAGUE_POLICY` (1/3/3 bans → second chooses), **`TOUR_POLICY` (ban 5 → pick 3
  → choose 1 of 3)**, `FREE_DECK_POLICY` (no steps → straight to PLAYING).
  `GameState` gained `candidates[]` (the nominated "pick 3"); `choosableCombos`
  picks final from candidates-or-survivors; `banOwner` derives attribution from
  the BAN steps. **13 unit tests** (`match-state.test.ts` + `result.test.ts`) green
  via match-core's own `vitest run`. Build excludes tests (`tsconfig.build.json`).
  > NB: the TT10 `Rules.html` "play on any static pack" line is stale Super Auto
  > Pets boilerplate — the structured ban/pick is the real intended flow.
- ✅ **Source-grounding pass (v0.3):** mined every live sheet (rules, `Info`,
  `Advantages`, `signups`, `Work`, `TD*work`, full `alltime/` DB) and folded the
  findings + corrections into **§12** + §5/§6.4/§9. Surfaced the Sunday-deadline
  fix, the Bo-X→Bo3 table, the stats-derivation pipeline, the round-robin/bye
  schedule mechanic, the full cross-season catalog, and an out-of-scope Daily-Grid
  feature. **Read §12 before starting Phase 1 schema work** — it pins down the math.
- ✅ **Architecture locked (§13):** web-first + Discord; derive-on-read stats with a
  pure tiebreaker comparator in a new pure `packages/tour-core`; SSE + Postgres
  `LISTEN/NOTIFY` real-time; shared `packages/tour-db`; NextAuth Discord; thin
  adapters. Three signature UX surfaces (Draft Board, Pairing Tool, Set Hub) are the
  build targets. **Read §13 before scaffolding `apps/tour`.**
- ✅ **User experience mapped (§14):** full per-persona journeys + moments of truth +
  locked experience decisions (hybrid signup; availability is a **soft helper, not a
  scheduling gate** — people just DM each other; captain/TO resolves dead-ends; TO
  gets flagged on awkward-timezone pairings). **Read §14 — it's the "build the right
  thing" record** that the schema + `tour-core` serve.

- ✅ **`packages/tour-core` started (pure domain, Phase-1 critical path):**
  `bo-x.ts` (Bo-X→Bo3 normalization, §12.4 — formula reproduces the whole table),
  `standings.ts` (`rankConference` — the §5 tiebreaker comparator the live sheet got
  wrong), `schedule.ts` (circle-method round-robin + byes + special-week assembly,
  §6.4/§12.6). **23 unit tests** green via its own `vitest run`; typechecks; build
  excludes tests. **Still TODO in tour-core:** ±2 pairing validation, snake draft
  order + self-pick, playoff qualify + re-seed-by-choice.

- ✅ **`packages/competition-core` — generic competition kernel** (decided mid-build:
  a shared framework so League + Tour are *config*, justified mainly by **shared
  cross-app stats**). Contracts (Participant/Fixture/Format/ContestResult-metrics/
  Tiebreaker) + standings engine + tiebreak builders + formats (round-robin/
  groupStage/bracket) + progression (qualify+wildcards/seed/re-seed-by-choice/
  promo-relegation). **14 tests**, incl. an end-to-end proof of the full
  conferences→round-robin→standings→qualify→seed→bracket flow. The Tour §5 chain
  and the League points model both fall out as config.
- ✅ **Migrated `tour-core` onto `competition-core`** — deleted its duplicate
  round-robin + `rankConference`; it now consumes the kernel and holds only
  Tour-specific bits (TOUR_TIEBREAKERS, special-week orchestration, Bo-X, …).
  Cross-package resolution is transitional (tsconfig `paths` + vitest alias → src);
  proper **npm-workspace** wiring is still pending (§11 step 1). All 3 packages green
  (match-core 13 / competition-core 14 / tour-core 12 tests).

- ✅ **`tour-core` pure domain complete (Phases 1–2):** added `draft.ts` (snake
  order, intra-team seed = round, captain self-pick at their draft-seed round; no
  deadline/autodraft — async, clock is cosmetic) and `pairing.ts` (±2 propose→
  respond with used-player tracking, `eligibleResponses`, alternating proposer
  from the coinflip, **dead-end detection via perfect ±2 bipartite matching** →
  TO override). **25 tests** green. So `tour-core` now = bo-x · TOUR_TIEBREAKERS ·
  special-week schedule · draft · pairing; playoff qualify/seed/re-seed live in
  `competition-core`.

- ✅ **Cross-package season simulation** (`tour-core/season.test.ts`): a full mini
  season composes both packages end-to-end — schedule (w/ seeded week) → simulated
  results → TOUR_TIEBREAKERS standings → qualify (berths+wildcards) → seed →
  bracket, plus snake draft + a ±2 pairing to completion. It caught + fixed a real
  draft bug: captain self-pick is a **committee-set round** ("seeded to be
  selected"), not `round === draftSeed` (which strands captains when teams >
  rounds, the normal case — see §6.1). **All 3 packages green: 56 tests**
  (match-core 13 / competition-core 14 / tour-core 29 [+season sim]).

- ✅ **npm workspaces + local dev (was "Next 1"):** root `package.json` now declares
  `workspaces: ["packages/*","apps/*"]`; all `@balatro/*` link via node_modules.
  Packages adopt the **internal-packages pattern** (`exports`/`types` → `src`), so
  there's **no build step** for dev/typecheck/test — the transitional `paths`/alias
  hack is **removed**. League verified unaffected (typecheck + 26 tests). Tour Prisma
  client generates to a **custom output** (`apps/tour/prisma/generated/client`) so it
  never clobbers the league's. **Local dev DB works with no Docker**: `npm run dev:db`
  (embedded Postgres 18.4) → `npm run db:push` — verified the Tour schema materializes
  into a real Postgres. `.env.example` + `apps/tour` README document the loop.
- ✅ **Authorization model locked (§13.7):** TO/admin gated by **Discord roles →
  `RoleBinding` → tier** (OWNER/TO/HELPER/DEVOPS — mirrors the league, Tour's own
  guild). Captain/player gated by **season data** (`captainPlayerId` / `RosterEntry`).
  Bot **mirrors data → cosmetic Discord roles** (`TourSeason.playerRoleId` /
  `captainRoleId`) so captain-only channels work. Added `RoleBinding` + `PermissionTier`
  + the role-id fields to `tour.prisma`; validates + client regenerates.

- ✅ **Historical data import — increment 1 (the team/roster spine):** `apps/tour/
  scripts/import/` parses the Google-Sheets exports (a positional-grid HTML parser
  + a Team-Rosters parser) and upserts into the local DB. Loaded **3 seasons, 56
  teams, 536 roster entries, 330 distinct players** (cross-season identity via a
  sentinel `legacy:<slug>` Discord id — links to real accounts later). Idempotent;
  ran end-to-end against the embedded Postgres. Placeholders to refine next:
  conference split, real team seeds, and **results (Game Log / Work) + the playoff
  bracket** — which feed standings + the bracket UI (the user's first-goal trio:
  ingest data · log on the web · bracket).

- ✅ **Import increment 2 — results + standings:** Game Log → **2007 sets** (core
  `Match` w/ gamesWon + standalone `TourSet`, season-tagged via new
  `seasonId`/`importKey`/nullable `matchupId`). Fixed the embedded-PG **WIN1252→UTF8**
  cluster (names with Unicode controls). **`npm run standings`** derives a season's
  team table via `competition-core` + the §5 chain — verified Season 3 ranks
  correctly (matchup→set→game). DB now holds 3 seasons · 56 teams · 355 players ·
  2007 sets, all local. Remaining refinements: real conference splits + team seeds,
  and the **playoff bracket** (needs the Playoffs sheet, not in Game Log).

- ✅ **Web app live (Next.js 16):** `apps/tour` is now the Next web app (turbopack
  root = monorepo; `transpilePackages` for the `@balatro/*` workspace packages).
  Pages `/` (seasons) + `/seasons/[name]` (standings derived live via
  `competition-core`) **build and render real data** off the local DB — verified
  Season 3 ranks (WashedBucklers #1 … Stakes and Stones #20). Also switched the
  three domain packages to **bundler resolution + extensionless imports** so tsc,
  vitest, AND turbopack all resolve them (was NodeNext `.js`); all 60 package tests
  still green; league untouched.

- ✅ **Playoff rules confirmed (TO) + bracket rendering:** seed by **weeks → sets →
  game WIN-RATE** (already built); qualify **top 4 per conference → 8 → 4 → 2**
  single-elim. Format **varies by season** (Swiss vs conferences) → added
  `SeasonFormat`/`conferenceCount`/`playoffTeams` to `TourSeason`. The sheets only
  record the **champion's path**, so imported **Hall of Fame → 9 PlayoffSeries**
  (3 seasons × QF/SF/Final, 0 unmatched) and the **Championship-Run bracket renders**
  on the season page above the standings. Full both-sides bracket works for live
  seasons (engine records all results).

- ✅ **Player stats pages:** `lib/stats.ts` derives career set/game records, seasons
  played, and **rings** (finals winners' rosters) from TourSet/Match/Roster/
  PlayoffSeries. **`/players`** all-time leaderboard (set %, min 10 sets) +
  **`/players/[id]`** career page with per-season breakdown — rendering real data
  (e.g. Thomas: 91.3% sets across 3 seasons). The "ton of back stats" foundation —
  any further stat is another reduction over the same data.

- ✅ **Format-aware import (Swiss OR conferences):** `scripts/import/seasons.config.mjs`
  tags each season `SWISS | CONFERENCES`; `parse-conferences.mjs` extracts
  conference→team from a Standings sheet (proven: root Standings → Pluto 10 / Eris 10).
  `importRosters` sets `TourSeason.format` + creates/assigns real conferences
  (SWISS = one pool); the standings page labels each conference when >1; empty
  conferences auto-cleaned on re-import. The 3 alltime seasons are tagged SWISS
  (correct single tables). To import a conference season: add a config entry +
  point at its Standings sheet.

- ✅ **Team pages + full clickable navigation:** `lib/team.ts` derives a team's
  season roster (seeds/captain) + each player's set/game record + team totals.
  `/teams/[id]` page; standings team names link to it; roster players link to their
  career pages. Nav graph complete: season → team → player → per-season. Local site
  runs at **localhost:4000** (`npm run dev:db` + `npx next dev -p 4000`).

- ✅ **Design system aligned to the league (Tailwind 4 + shadcn/ui):** `apps/tour`
  now runs the same stack as `web/` — Tailwind 4 (`@tailwindcss/postcss`), shadcn
  components copied verbatim (`button/card/badge/input/label/sonner/dialog/command`),
  `@base-ui/react`, `lucide-react` (all emoji → icons), `sonner`, and **Silkscreen**
  pixel headings. Theme tokens (`:root` gold `#f1c40f` + blurple `#5865f2`) mapped via
  `@theme inline` onto shadcn `--color-*`; a few utility classes (`.card/.bracket/
  .season-card`) stay in `globals.css` exactly as the league does. NOTE: install
  frontend deps with the dev server **stopped** (a running dev server lock-races the
  install → silent no-op → 500s until reinstalled + restarted).

- ✅ **Richer read-side stat surfaces:** player pages have headline **stat cards** +
  a **set-win% by season** bar chart (`recharts`, client component); team pages have
  stat cards. **Head-to-head** is now the full opponent list in a **sortable** table
  (set + game records, win%, filter). **Standings** are a shared **sortable**
  `StandingsTable` (canonical rank frozen; added M%/Set%/Game% columns) — every table
  on the site is now the same sortable component (consistent-UX).

- ✅ **⌘K command palette (`cmdk`):** nav Search button + ⌘/Ctrl-K open a dialog that
  jumps to any page / season / team / player. Backed by `lib/search.ts` →
  `/api/search` (lean id+name index, lazy-loaded on first open). Service-layer rule
  honored (logic in `lib/`, thin API wrapper).

**Next (in order):**
1. Import the **TT10 Pluto/Eris conference season** (Standings + Work sheets) to
   exercise the conference path end-to-end. More stat surfaces (H2H matrix, awards,
   deck stats). **TO logging/editing** write paths (needs Discord OAuth; public read
   works now).
2. Stand up the **Tour Discord app (bot token)** → scaffold `apps/tour` bot + web
   runtimes (local Postgres + client already work; just needs the token).
3. Phase 1 features: teams/draft-order seeding, **auto schedule generation**,
   **3-level standings + tiebreakers** (wired to the `tour-core`/`competition-core`
   functions above).
4. Phase 2: live snake **draft** + guided **pairing negotiation** (coinflip, ±2) —
   the engine exists in `tour-core`; this phase is the live web surfaces over it.
5. Phase 3: playoffs (wildcards + re-seed-by-choice), scheduling deadlines,
   officials/casters, cross-season (rings, Hall of Fame, all-time LB, awards).

## 11. Phase 0 — concrete first steps
1. Convert the repo to an **npm workspace** (root `package.json` with `workspaces:
   ["packages/*", "apps/*"]`); league `src/`+`web/` stay where they are for now.
2. Scaffold **`packages/match-core`**: move the framework-agnostic match engine
   (ban/pick state machine, lives, win/DC resolution, deck-pool gen) + `core.prisma`
   (Player, Match, Game, GameDeck, MatchConfigPreset). **Decouple `Match` from
   `Division`** (drop the FK; host links from its side).
3. **Extend the ban policy** to express **ban-5 → pick-3 → choose-1-of-3**.
4. Scaffold **`apps/tour`** (bot + web) depending on `match-core`, with its own
   Prisma schema (`core.prisma` synced + `tour.prisma`) and its own DB.
5. Stand up the Tour Discord app (bot token) + Railway services when ready to deploy.

---

## 12. Source-grounded detail (folded from the live sheets — v0.3)

Everything here was read off the real 20-team season in `D:\STuffinside` (+ its
`alltime/` cross-season DB). Where it conflicts with the earlier sketch, **this
section wins.**

### 12.1 Corrections to v0.2
- **Deadline = Sunday night ET, not Thursday.** `Rules.html`: sets must be played
  by Sunday night ET so captains plan the next week Monday. Weekly cadence:
  matchups set early week → **sets played by Sun 23:59 ET** → standings + next
  pairings Monday. (Fixed in §4 + §7.)
- **No "play any static pack."** That `Rules.html` line is un-ported Super Auto
  Pets boilerplate; the real Balatro flow is the structured **ban 5 → pick 3 →
  choose 1 of 3** (already built as `TOUR_POLICY` in `match-core`).
- **Signups captured names only** in the source — availability / timezone /
  captain-volunteer are *our* enhancement (locked §10), not mirrored from the event.
- **Awards list verified:** §4's 7 `AwardKind`s exactly match `Awards.html`.
- **"Advantages" verified:** one assigned official/caster **per matchup** (row =
  week #, the two teams, one person) → `Matchup.officialPlayerId` is correct.

### 12.2 Per-season config (observed values vary)
This season ran **`teamSize` = 11** (→ 11 sets per matchup, **`setsToWin` = 6**),
**`defaultBestOf` = 5** (players may agree higher), and **N conferences of varying
size** (e.g. a 6-team conference alongside larger ones; the rules doc describes an
18-team/7 season — all per-season). The `TourSeason` fields already cover this; the
schedule generator must handle uneven conference sizes (§12.6).

### 12.3 Stats derivation pipeline (`Work.html`)
Four blocks, **all derived** from per-set + per-game results + the weekly roster
(who's on which team that week):

1. **Per-set (atomic):** `Week, P1, P1 games won, P2 games won, P2, set winner`
   → this **is** a `TourSet` + its core `Match`/`Game` rows. Source of truth.
2. **Per-matchup/week (team):** `T1/T2 sets won, matchup winner (≥ setsToWin),
   T1/T2 games won` → derived `Matchup` result.
3. **Team aggregate:** `Matches W-L, Sets W-L, Games W-L, G% (game-win %)` →
   standings + seeding.
4. **Player aggregate:** `Set W-L, Game W-L` → player stats.

**Schema implication:** "a player's set/game record" and "a team's match/set/game
record + G%" must be **pure derivations** of `Game.winnerId` + `Roster`
(player→team per week) + `TourSet`→`Matchup`→`Week`. No denormalized truth needed;
build cached aggregates the way the league does `standings-cache`.

### 12.4 Bo-X → Bo3 normalization (`Info.html`, "credits to dsc")
For the **game-level tiebreaker**, every set is normalized to Bo3 terms so variable
lengths compare fairly:

| Set length | Win threshold | Loser credited a game if they reached | Result |
|---|---|---|---|
| Bo3 | 2 | 1 win (2-1) | **2-1**, else **2-0** |
| Bo5 | 3 | 2 wins (3-1 or 3-2) | **2-1**, else (3-0) **2-0** |
| Bo7 | 4 | 3 wins (4-2 or 4-3) | **2-1**, else **2-0** |

Rule: **winner → 2; loser → 1 iff they reached (threshold − 1) wins, else 0.**

### 12.5 Derived views / surfaces (Phase 1–2 visible artifacts)
- **Standings** (per conference): 3-level W-L (Matches / Sets / Games), full §5 chain.
- **Overall Seeding** (cross-conference): seed by the chain incl. **G%**; drives
  **Seeded Week** (#1 v #last) and **playoff seeding**.
- **Player Stats** (per season): per-player Set & Game W-L, ranked.
- **Team Rosters** (per season): each player's seed(s), captain flag, week/set records.
- **Playoff Race**: top-2-per-conf + best-record wildcards.

### 12.6 Schedule generation (`TD*work` tabs)
**Round-robin (circle method) within each conference**; conferences of varying size;
**byes (`#N/A`) for odd counts**. Plus the special weeks: **Rival** (pre-draft
rivals), **Cross-Conference**, **Seeded** (#1 v #last, mirrored). The `TD*work` tabs
are the TO's manual round-robin scratch — the generator automates it; TO override stays.
(The live **player ±2 pairing** is *not* in these sheets — it's done by hand in
Discord per §6.2; that's the Phase-2 tool to build.)

### 12.7 Cross-season `alltime/` layer (Phase 3 — far bigger than §4 sketched)
**Atomic record = `Game Log`** (`Season, P1, P1 score, P2 score, P2, P1 seed,
P2 seed, bracket`) — the cross-season source of truth; every view below derives
from it + `Drafts` + `Awards`.

- **Stored records:** Game Log · Drafts (captain + round-by-round picks per season)
  · Awards (7 **player-level** kinds: MVP, Rookie of Season, Comeback, Captain of
  Season, Best Set, Biggest Steal, Most Improved).
- **Derived views:** Player LB (all-time: set%/game%, rings, avg seed, seed
  differential, min-10-sets cut) · Team LB (per team-season) · Player Seasons ·
  Player Stats (career: seasons, rookie season, championships, finals/playoffs made,
  captain Y/N) · Team Stats · Team Rosters · **Hall of Fame** (champion narratives,
  wk1-7 + QF/SF/F) · **Matchup History** (**player-vs-player** H2H matrix) ·
  Ring / Finals / Playoff / Season counters (per player) · Draft Classes · Rookie
  Rankings.
- **Identity:** the sheets key on **player name + season int** (no GUIDs). Our model
  keys cross-season on **`Player.discordId`**; `Team` persists while `TeamSeason`
  re-forms each season. ~3 seasons of history exist today (columns scaffolded to 13).

### 12.8 Out of scope — the Daily Grid / "DojoGrids" puzzle
`Daily DG` / `DojoGrids` / `Grid DB` are a **separate** game: a daily 3×3
"guess the player who matches these 3 attributes" puzzle, backed by a `Grid DB` of
~30 boolean player attributes (champion, has-been-a-1-seed, positive set %, name is
animal-related, played-season-X, …). It's **independent of tournament play** (a
player can be in the grid without ever playing the Tour). **Not part of the Team
Tour build** — recorded here only so it isn't mistaken for one. Could be a Phase 4+
side-app if ever wanted.

### 12.9 Operational checklist (was implicit)
- **Discord surfaces:** `#results` (report → **both players react to confirm**),
  `#schedule` (post times / streams). Channel + role bootstrap reuses core helpers.
- **Deploy:** separate Railway services (bot + web) + own Postgres + own bot token
  (locked §0). Needs a `DATABASE_URL` and a Tour bot token before `prisma generate`.
- **Shared `balatromp` util:** the BMP-rank scraper (display-only, §0/§10) is
  extracted/shared, not reimplemented.

---

## 13. System architecture (locked — v0.3)

### 13.1 Decisions locked
| # | Decision | Choice |
|---|---|---|
| Primary surface | **Web-first + Discord** | Web is the primary surface (draft, pairing, scheduling, standings, stats, admin); Discord = identity + notifications + match execution |
| Stats read model | **Derive on read** | `Game` rows are the only source of truth; SQL views/query fns shape aggregates; **tiebreaker chain is a pure comparator in `tour-core`**; no denormalized cache (matview is the escalation path) |
| Real-time | **SSE + Postgres `LISTEN/NOTIFY`** | one-way board broadcasts after POSTed actions; bot `NOTIFY`s on confirm so web updates live; no new infra |
| Domain logic | **Pure `packages/tour-core`** | all logic pure + unit-tested (mirrors `match-core`); web actions + bot handlers are thin shells |
| Schema/client | **Shared `packages/tour-db`** | synced `core.prisma` + `tour.prisma` + generated client, consumed by both `apps/tour/web` and `/bot` |
| Auth | **NextAuth Discord OAuth** | same as league web; `Player.discordId` is the join key. **TO/admin via Discord roles → `RoleBinding` tier** (reuses league); **captain/player by season data**; bot mirrors data → cosmetic Discord roles for channel access (§13.7) |

### 13.2 Why web-first (the reframe)
The league is Discord-first because a league match is a self-contained 1v1. The
Tour's hard interactions — multi-day **snake draft**, two-captain **±2 pairing**,
**lineups/subs**, **3-level + all-time stats** — are collaborative, stateful, and
visual: miserable as Discord button-spam, delightful as live web surfaces. Discord
keeps what it's genuinely best at (login, pings, the guided ban/pick thread +
report→react→confirm).

Surface map:

| Job | Home |
|---|---|
| Signup / profile / BMP rank | Web |
| **Snake draft** | Web (live) |
| **±2 pairing negotiation** | Web (live, 2-party) |
| Schedule the 1v1 (overlap availability) | Web + Discord ping |
| Play + report a set | **Discord** (match-core flow) |
| Standings / stats / all-time | Web (recharts) |
| TO admin (season, schedule-gen, overrides, playoffs) | Web |

### 13.3 Topology
```
packages/
  match-core        ✅ pure 1v1 MATCH engine (ban/pick, result, write)
  competition-core  ✅ pure generic COMPETITION kernel (the structure around
                       matches): Participant/Fixture/Format, metric-based
                       ContestResult, standings engine + composable tiebreaker
                       chain, formats (round-robin/groupStage/bracket),
                       progression (qualify+wildcards/seed/by-choice/promo-releg).
                       League + Tour both become CONFIG over it. No Prisma/Discord.
  tour-core         ★ Tour-specific config/logic ON competition-core: the §5
                       tiebreaker chain (TOUR_TIEBREAKERS), special-week schedule
                       orchestration, Bo-X→Bo3 (balatro), ±2 pairing, draft.
  tour-db           ★ synced prisma schema + generated client (shared)
apps/tour/
  web   Next.js 16 (NextAuth Discord, shadcn/base-ui, recharts, sonner) — primary surface
  bot   Discord.js — threads, pings, report/confirm, identity sync
        both → Postgres (Railway); realtime via LISTEN/NOTIFY
```
**Layering rule:** thin adapter (web server-action / bot handler) → pure
`tour-core` function → Prisma write. Everything testable without a DB or Discord.

### 13.4 `tour-core` responsibilities (all pure, unit-tested)
- **Schedule generation** — round-robin (circle method) per conference + byes
  (§12.6); inserts Rival / Cross-Conf / Seeded weeks.
- **Standings** — shape aggregate rows (Matches/Sets/Games + G%) + the **tiebreaker
  comparator** (matchup → set → game% → in-conf → H2H, §5).
- **Bo-X → Bo3 normalization** (§12.4).
- **±2 pairing** — propose/respond validation, used-player tracking, dead-end detection.
- **Draft** — snake order, captain self-pick at their seed round, autodraft fallback.
- **Playoffs** — top-2-per-conf + wildcard qualification, re-seed-by-choice.

### 13.5 Read models
Source of truth = `Game` (+ `Roster` for player→team/week, `TourSet`→`Matchup`→
`Week`). Aggregates derived on read via SQL views/query fns; the tiebreaker sort is
the pure comparator above (H2H needs pairwise lookups → not SQL). Data is kilobytes
(~150 sets / ~750 games per season) so this is a **correctness**, not a perf,
decision. Matview-refresh-on-confirm is the escalation path, not the v1.

### 13.6 Real-time
SSE from Next.js route handlers, fanned out via Postgres `LISTEN/NOTIFY` channels
(e.g. `draft:<seasonId>`, `pairing:<matchupId>`, `standings:<seasonId>`).
Optimistic POST → server writes + `NOTIFY` → all subscribers re-render. The bot
`NOTIFY`s on result-confirm so standings/stats update without a refresh.

### 13.7 Identity & roles (authorization model)
NextAuth Discord OAuth (reuse league `web/auth.ts`, `identify` scope). Then a
deliberate **split — Discord roles for org tiers, competition data for everything
season-specific**:

| Who | Gated by | Mechanism |
|---|---|---|
| **TO / admin** | **Discord roles → tier** (reuses the league pattern) | `RoleBinding` (discordRoleId → `PermissionTier` OWNER/TO/HELPER/DEVOPS) in `tour.prisma`; web fetches the user's guild roles (bot REST lookup) and resolves the highest tier. OWNER also env-pinnable. The Tour has its **own guild + rows**. |
| **Captain** | **Data** | `TeamSeason.captainPlayerId` (by `discordId`) — the web's source of truth (knows *which* team). |
| **Player / participant** | **Data** | an APPROVED `Signup` / a `RosterEntry` this season. |
| **Spectator** | nothing | standings/stats/schedules are public read. |

**Discord roles are also mirrored from the data by the bot** (not the auth source —
the *channels* source): each season the bot provisions a **`TourSeason.playerRoleId`**
(every rostered player) and **`captainRoleId`** (captains), so Discord can have
**captain-only channels** etc. The data stays authoritative; the bot keeps the
Discord roles in sync as rosters/subs change.

So: a captain-only Discord channel is gated by the `captainRoleId` role; a
captain-only *web* page is gated by `captainPlayerId` — same truth, two surfaces.

**Identity is Discord-ID-first** (matches the existing league): `Player.discordId`
is the stable key everywhere — cross-season joins, signups, audit. **Display names
are display-only**, pulled live from Discord, and are *never* used as keys. (The
source sheets keyed on player *name* with no IDs, §12.7 — fragile; we don't.) The
one deliberate name we keep is `Signup.bmpHandle` (the Balatro-MP username needed to
scrape rank). Web signup is Discord OAuth → we get the ID for free and upsert the
`Player` (the league captures **no** timezone/availability — that's net-new here).

### 13.8 Signature UX surfaces (the "as easy as possible" targets)
1. **Draft Board** (live) — searchable pool with inline **BMP rank + availability/
   timezone**; snake-order rail; your-turn highlight + clock; queue-a-pick;
   auto-flag captain self-pick; autodraft on timeout. Discord: "🟢 on the clock → link".
2. **Pairing Tool** (live, 2-captain) — coinflip sets send-first; alternate
   propose→respond; proposing player @seed S highlights only **±2-eligible, unused**
   opponents; pick fills a `TourSet` cell in the matchup grid; used players grey out;
   **TO override** on any cell. (Interactive, constraint-enforced `TD*work` grid.)
3. **Set Hub** (the player's "what do I do") — "You vs X this week (due Sun ET)."
   Shows opponent + a **soft availability hint** (rough overlap, only if both filled
   the grid) + status (Unscheduled → Scheduled → Played → Confirmed). Actions:
   **[Mark scheduled for …]** (one tap to record a time they agreed in DM/thread)
   and **[Start match]** → spins the Discord guided ban/pick thread → report → both
   confirm → standings update live. Scheduling is **human**; the system only assists
   + flags (see §14.4).

---

## 14. User experience & journeys (the "build the right thing" record)

The product goal: **make every participant's job as easy as possible.** This
section is the experiential spec — the journeys and the moments that make or break
them — that the schema, `tour-core`, and surfaces (§13) serve.

### 14.1 Personas
- **Player** — the volume user; most participants are *only* players.
- **Captain** — a player + three hard jobs: draft, weekly pairing, lineup/subs.
- **TO / admin** — runs the event; today a spreadsheet hero, tomorrow review/approve.
- **Spectator / caster ("Advantages")** — public read; casters assigned per matchup.

### 14.2 Locked experience decisions
| Topic | Choice |
|---|---|
| Signup | **Hybrid** — players self-serve (Discord OAuth + form); committee curates/approves the final pool before the draft |
| Availability | **Coarse / general** only — a nullable `timezone` + free-form `availability` note on `Signup`. People won't fill more than rough availability, and they mostly just DM each other; it's a **soft hint + the TO awkward-tz flag (§14.4)**, never a schedule |
| Schedule dead-ends | **Captain/TO resolves** (mediate / extend / sub). System surfaces early; humans decide |
| Awkward timezones | System **flags low/no-overlap pairings to TOs** proactively so they can sub/mediate before the week rots |
| Draft pacing | **No enforced pick deadline** — the draft is async, captains pick whenever. But `DraftPick.onClockAt`/`pickedAt` drive a **cosmetic "on the clock for 2h 14m" timer** + fun pick-duration stats (a clock is fun, not a gate) |

### 14.3 Moments of truth (where it's won or lost)
1. **Signup < 60s** — incl. the availability grid (15s, optional but encouraged).
2. **Getting drafted feels like belonging** — instant team + captain + teammates + seed.
3. **"Who do I play, by when"** — zero ambiguity each week.
4. **Play uses the proven Discord flow** — web hands off to match-core, invisibly.
5. **Your 1v1 visibly moved the team** — the emotional hook of *team* tour.
6. **Captain pairing is constraint-enforced** — illegal ±2 pairings are unreachable.
7. **TO reviews, system computes** — correct tiebreakers (vs the live sheet's wrong ones).
8. **Careers persist** — rings, all-time LB, H2H bring people back across seasons.

### 14.4 Scheduling philosophy (calibrated)
The system does **not** try to schedule for people. It: (a) states the matchup +
**Sunday-ET deadline**, (b) shows a **soft overlap hint** when both grids exist,
(c) lets either player **record the agreed time in one tap**, (d) **nudges** both +
their captain as the deadline nears if still unscheduled, and (e) **flags
awkward/zero-overlap timezone pairings to the TO early**. Resolution (extend, sub,
mediate) is always **human** (captain → TO). Availability is an assist and a
problem-detector, never a gate.

### 14.5 Experience doctrine ("as easy as possible")
1. **One link, one click** — every Discord ping deep-links to the exact action.
2. **Compute to assist & to catch problems — don't force flows through it** (the
   availability lesson: help, don't gate).
3. **Constraints are guardrails, not rules to memorize** — illegal states unreachable.
4. **Right surface for the job** — web for collaborative/visual, Discord for play +
   pings; no worse-version-in-both.
5. **Live, not refresh** — drafts / pairings / standings stream (SSE).
6. **The team is the hero; careers persist.**
