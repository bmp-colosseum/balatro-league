# Team Tour — Design Doc

_Draft v0.1 — for review. Nothing here is built yet._

A team-based BMP event (Pizza Power Team Tour): captains draft players, teams play
weekly 1v1 best-of-3 sets, regular season → playoffs. Built on a **shared match
core** extracted from the Balatro League app, as its **own application**.

---

## 1. The core insight

A single **set** in Team Tour (player vs player, bo3, white stake, 4 lives, deck
ban/pick, report + confirm, DC rules) is — almost exactly — a **`Match`** in the
league app. The novel part is the **team/league structure** wrapped around the
matches. So the plan is:

- **Extract** the match engine into a shared package (`match-core`).
- **Build** Team Tour as a thin app on top that supplies its own competition
  structure (teams, conferences, weeks, draft, playoffs).
- The League app eventually consumes the same core (incrementally; not required
  for Team Tour to ship).

---

## 2. Architecture: shared core, separate app

### Proposed monorepo layout
```
balatro/                      (workspace root, pnpm/npm workspaces)
  packages/
    match-core/               ← the shared engine
      prisma/core.prisma      ← Player, Match, Game, GameDeck, MatchConfigPreset, …
      src/                    ← ban/pick state machine, lives, result rules,
                                 deck pool/config, DC policy, dispute logic,
                                 Discord match-thread helpers (framework-agnostic TS)
  apps/
    league-bot/  league-web/  ← existing app (migrates onto core later)
    tour-bot/    tour-web/     ← NEW Team Tour app
```

### What lives in `match-core`
- **Models:** `Player`, `Match`, `Game`, `GameDeck`, `MatchConfigPreset` (decks/
  stakes/pool), and the match-session/ban-pick state.
- **Logic:** the guided ban/pick flow, lives capture, win/DC resolution, report →
  confirm → dispute, the deck-pool generator, and the Discord match-thread
  lifecycle. All of this is competition-agnostic.
- **Crucially decoupled:** core `Match` has **no `divisionId`** (that's
  league-specific today). A match knows only its two players, its games, its
  result, and an opaque `contextId` the host app interprets. See §8-A.

### Schema strategy
- Prisma 6 supports a **multi-file schema folder**. Each app's `prisma/` folder =
  a synced copy of `core.prisma` + its own `app.prisma`. A small sync step
  (you already have `sync-schema.mjs`) copies the core fragment into each app.
- **Separate databases per app.** BMP players are global (Discord IDs are stable
  across servers), but the events are independent — Team Tour gets its own DB
  with the core tables + its Team-Tour tables. No shared DB, no cross-event
  coupling.

### Runtime
Each app is still **bot + web** (same split as today). `tour-bot` runs the
`/start-match`-equivalent and Discord plumbing; `tour-web` is the dashboard
(teams, schedule, standings, draft board).

---

## 3. Reuse map

| Team Tour needs | Status |
|---|---|
| 1v1 best-of-3 with deck ban/pick | ✅ core (ban/pick is configurable; "ban 5 / pick 3 / choose 1" is a policy) |
| 4 lives capture | ✅ core (`Game.winnerLives`) |
| White stake + deck pool | ✅ core (one `MatchConfigPreset`) |
| Report + react-to-confirm | ✅ core |
| DC before/after PvP ante 2 | ✅ core DC policy (maps to crash-before/after rules) |
| Disputes, audit, profiles, Discord bootstrap | ✅ reusable |
| Bot-run ban/pick (vs TT's "flip a coin") | ✅ **upgrade** — TT players get a real guided flow |
| Teams, conferences, weeks, matchups | ❌ new |
| Snake draft | ❌ new |
| Weekly captain pairing negotiation | ❌ new |
| Team standings + tiebreakers | ❌ new (match primitives reusable) |
| Playoffs bracket + seed selection | ❌ new |
| Self-scheduling (#schedules), deadlines | ❌ new (lightweight) |

---

## 4. Team Tour data model (sketch — `tour/app.prisma`)

```prisma
model Team {
  id           String   @id @default(cuid())
  seasonId     String
  conferenceId String
  name         String
  captainId    String              // Player.id
  members      TeamMember[]
  // … colors / logo later
}

model Conference {
  id        String  @id @default(cuid())
  seasonId  String
  name      String                 // "East", "West"
  teams     Team[]
}

model TeamMember {
  id        String  @id @default(cuid())
  teamId    String
  playerId  String
  seed      Int                    // 1..9 within the team (from BMP S2 MMR)
  isCaptain Boolean @default(false)
  @@unique([teamId, playerId])
}

model TourSeason {
  id            String   @id @default(cuid())
  name          String
  teamSize      Int                // 7 or 9
  setsToWin     Int                // 4 (of 7) or 5 (of 9)
  weeks         Week[]
  state         TourState          // DRAFTING | REGULAR | PLAYOFFS | DONE
}

model Week {
  id          String        @id @default(cuid())
  seasonId    String
  number      Int                  // 1..7 regular, then playoffs
  kind        WeekKind             // ROUND_ROBIN | CROSS_CONF | SEEDED | PLAYOFF
  opensAt     DateTime?
  deadlineAt  DateTime?            // sets must be scheduled by Thu 11:59 EST
  matchups    TeamMatchup[]
}

model TeamMatchup {
  id          String   @id @default(cuid())
  weekId      String
  teamAId     String
  teamBId     String
  sets        Set[]
  // derived: setsWonA / setsWonB → winner when one hits setsToWin
}

// A single player-vs-player set inside a team matchup. Wraps a core Match.
model Set {
  id            String  @id @default(cuid())
  teamMatchupId String
  matchId       String? @unique     // ← core Match (null until played)
  playerAId     String              // Team A's player (seed S)
  playerBId     String              // Team B's player (within ±2 seeds)
  seedSlot      Int                 // ordering / pairing slot
  status        SetStatus           // PROPOSED | SCHEDULED | PLAYED | FORFEIT
  scheduledAt   DateTime?
}

// Draft
model Draft {
  id        String  @id @default(cuid())
  seasonId  String
  order     String[]               // captain/team ids in snake order
  picks     DraftPick[]
  state     DraftState
}
model DraftPick {
  id        String  @id @default(cuid())
  draftId   String
  round     Int
  pickIndex Int
  teamId    String
  playerId  String?                // null until made
}

// Playoffs
model PlayoffSlot {
  id        String  @id @default(cuid())
  seasonId  String
  seed      Int
  teamId    String?
  opponentTeamId String?           // 1-seed picks from 5–8, etc.
}
```

(Names/fields illustrative — we'll firm them up.)

---

## 5. Core flows

### 5.1 Draft (snake)
- TOs set captain order (lowest-seed captain picks first).
- Snake: round 1 forward, round 2 reverse, … Each captain reserves their own seed
  slot. Bot/web UI: on your turn, pick from the available pool; auto-advance.
- Spans days (timezones) — so it's **async with a "your pick" ping**, not a live
  timer. Output: `TeamMember` rows with seeds.

### 5.2 Weekly pairing negotiation
- For a `TeamMatchup`, captains alternate proposing players (Cap A proposes,
  Cap B responds with their player, then Cap B proposes, …) until all slots
  filled. Constraint: opponents within **±2 seeds**.
- UI: a captain-only board per matchup; propose → opponent confirms → `Set` rows
  created. Validation enforces the ±2-seed rule and prevents double-booking.

### 5.3 Playing a set
- Pure **core**: `/start-match`-equivalent in `tour-bot`, bo3, white-stake preset,
  4 lives, ban-5/pick-3/choose-1 policy. Produces a core `Match`; `Set.matchId`
  links it.

### 5.4 Reporting → team week score
- Set result rolls up: `TeamMatchup.setsWonA/B`. When a team hits `setsToWin`,
  the week is decided. Results still go through core report+confirm.

### 5.5 Standings & tiebreakers
Per conference, by **week record** (W/L), then:
1. Set record (win% across individual sets)
2. Games won vs lost within sets
3. In-conference record

(All derivable from `TeamMatchup` + `Set` + `Match`/`Game`.)

### 5.6 Playoffs
- Top N per conference (+ wildcards). Seed by the tiebreaker chain above.
- **Seed-based selection:** 1-seed picks its opponent from seeds 5–8, then 2-seed
  from the rest, etc. → `PlayoffSlot`. Then it's normal weeks for 3 weeks.

### 5.7 Scheduling
- Lightweight: a `#schedules` form / web form writes `Set.scheduledAt`; a deadline
  check (Thu 11:59 EST) flags un-scheduled sets for TO attention (auto-forfeit is
  TO discretion, so we *surface* it, not auto-apply).

---

## 6. Not code — policy / TO discretion
Conduct, warnings, extensions, stream-sniping, sub approvals, mid-set coaching,
restart etiquette — all human-judgment, case-by-case. At most we add a small
**warning log** (who/why/when) later. We do **not** automate enforcement.

---

## 7. Phased build plan
- **Phase 0 — extraction:** carve `match-core` out of the league (decouple `Match`
  from `Division`; set up the workspace + schema sync). Biggest one-time cost.
- **Phase 1 — admin MVP:** Team/Conference/Week/TeamMatchup/Set schema + TO tools
  to make teams, seed players, generate the weekly schedule, and view **team
  standings**. Sets played via core. Draft + pairings done by hand. → a runnable
  event.
- **Phase 2 — captain tooling:** snake **draft** + **weekly pairing negotiation**
  (the high-value automation).
- **Phase 3 — the rest:** self-scheduling + deadlines, **playoffs** bracket + seed
  selection, cross-conf/seeded-week schedule generation.

---

## 8. Open decisions (need your call)
- **A. Match ↔ competition link.** Make core `Match` competition-agnostic (no
  `divisionId`; host app links via its own table — Tour's `Set`, League's join).
  This is the key extraction decision and the main cost of "shared core." Agree?
- **B. Does the League actually migrate onto core now, or later?** Recommend
  **later** — extract core *for Tour*, leave the league running as-is, migrate it
  when convenient. Avoids destabilizing a live league.
- **C. Seeds & MMR.** Seeds come from "BMP S2 ranked MMR." Do we pull MMR via the
  existing balatromp scraper, or do TOs enter seeds manually? (MVP: manual.)
- **D. Team size.** Model supports 7 or 9 via `teamSize`/`setsToWin`. Lock per
  season at create time. OK?
- **E. Hosting.** Separate Railway services + DB + Discord app for Team Tour
  (its own bot token). Confirm.

---

## 9. First concrete step (proposed)
Once §8 is settled: stand up the workspace + `match-core` package boundary
(Phase 0) **or**, if you'd rather see value first, prototype Phase 1's schema +
standings in a throwaway branch to validate the data model before the extraction.
