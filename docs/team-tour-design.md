# Team Tour — Design Doc

_v0.2 — for review. Nothing built yet. Updated from the live event docs in
`D:\STuffinside` (TT10 rules + a completed 20-team season's sheets)._

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
- Each app is **bot + web** as today.

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

### Weeks, matchups, sets
```prisma
model Week {
  id; seasonId; number Int;
  kind WeekKind;             // ROUND_ROBIN|RIVAL|CROSS_CONF|SEEDED|PLAYOFF
  opensAt; deadlineAt;       // sets scheduled by Thu 11:59 ET
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
model DraftPick { id; draftId; round; pickIndex; teamSeasonId; playerId String?; }
```

### Playoffs
```prisma
model PlayoffEntry { id; seasonId; teamSeasonId; seed Int; viaWildcard Boolean; }
model PlayoffSeries{ id; seasonId; round PlayoffRound; teamAId; teamBId; matchupId String?; }
```

### Cross-season (the `alltime/` layer)
```prisma
model Championship { id; seasonId; teamId; }              // "rings"
model Award        { id; seasonId; kind AwardKind; playerId?; teamId?; meta Json; }
// AwardKind: MVP|ROOKIE|COMEBACK|CAPTAIN|MOST_IMPROVED|BEST_SET|BIGGEST_STEAL
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

(The live sheet only sorts on matchups — note: _"tie breakers are not programmed
correctly."_ We implement the full chain. Variable Bo-X is normalized for the game
tiebreaker.)

---

## 6. Core flows

### 6.1 Draft (snake, async)
Committee sets team draft order (lowest seed picks first). Snake forward/reverse
per round. On your turn: pick from the pool → next captain pinged. **Captain picks
themselves** on their seed round. Each pick's order = that player's intra-team seed.

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
Per season: in-conference **round-robin**, **Rival Week** (each team vs its pre-draft
rival), **Cross-Conference Week**, **Seeded Week** (#1 vs #last, mirrored). Generator
adapts to conference sizes; TOs can tweak.

### 6.5 Playoffs
Qualify **top-2 per conference + best-record wildcards** (→ 8). Seed by the §5 chain.
**Re-seed by choice:** #1 picks its opponent from seeds 5–8, #2 from the rest, …;
#1 and #2 placed on opposite sides. Single-elim **QF → SF → Final** over 3 weeks,
still full team matchups.

### 6.6 Officials / casters ("Advantages")
A pool of officials assignable per Matchup (`Matchup.officialPlayerId`). Optional —
who casts/streams/holds the send advantage. **Likely Phase 3+.**

---

## 7. Not code — policy / TO discretion
Conduct, warnings, extensions, stream-sniping, sub approvals, mid-set coaching,
restart etiquette — human judgment. At most a lightweight **warning log** later. We
**surface** (e.g. un-scheduled sets past the Thursday deadline) but don't
auto-enforce.

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
  schema + TO tools to make teams, seed via draft order, **auto-generate schedule**,
  and **3-level standings + tiebreakers**. Sets via core; draft + pairings by hand at
  first. → runnable event.
- **Phase 2 — captain tooling:** live **snake draft** + **guided pairing
  negotiation** (coinflip, ±2, TO override).
- **Phase 3 — the rest:** playoffs (wildcards + re-seed-by-choice), self-scheduling +
  deadlines, officials/casters, **cross-season** (rings, Hall of Fame, all-time LB,
  awards, H2H history).

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

_If you're a new conversation: read this doc top-to-bottom, then continue from
"Next" below. All design decisions are settled (§0, §10). The **league app
(`src/` + `web/`) is intentionally untouched** and still deploys — don't move or
modify it; Team Tour is additive._

**Done (Phase 0):**
- ✅ `packages/match-core/` — `prisma/core.prisma` (competition-agnostic engine
  schema) + `src/match-state.ts` (pure ban/pick state machine). Typechecks.
- ✅ `apps/tour/prisma/schema/` — `core.prisma` (synced copy) + `tour.prisma`
  (full Team Tour model). Merged schema **validates**. `npm run sync:core` keeps
  the core fragment in sync.
- ✅ Verified the league bot + web typecheck and its 26 tests pass — untouched.

**Next (in order):**
1. Port the Prisma-dependent engine into `match-core` with a **client-injection**
   pattern (result/DC resolution + `Game`/`GameDeck` writes, from the league's
   `match-write` + winner/DC logic).
2. **Extend `BanPickPolicy`** + `phaseFor` for Team Tour's **ban-5 → pick-3 →
   choose-1-of-3** (currently the league pattern).
3. Stand up the **Tour Discord app (bot token) + its own Postgres DB** → then
   scaffold `apps/tour` bot + web runtimes and `prisma generate`.
4. Phase 1 features: teams/draft-order seeding, **auto schedule generation**,
   **3-level standings + tiebreakers**.
5. Phase 2: live snake **draft** + guided **pairing negotiation** (coinflip, ±2).
6. Phase 3: playoffs (wildcards + re-seed-by-choice), scheduling deadlines,
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
