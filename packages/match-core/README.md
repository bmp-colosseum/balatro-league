# @balatro/match-core

The shared, **competition-agnostic** 1v1 match engine — extracted from the
Balatro League so the League and Team Tour apps can share it. See
`../../docs/team-tour-design.md` (§2, §11).

## What's in here

- **`prisma/core.prisma`** — schema FRAGMENT (no generator/datasource): `Player`,
  `Match` (no division/set FK — host apps link it from their side), `Game`,
  `GameDeck`, `MatchConfigPreset`, `MatchSession`, + the `MatchStatus` /
  `MatchSessionState` enums. Apps merge this into their own `prisma/` folder
  (Prisma multi-file schema) alongside their `app.prisma`.
- **`src/match-state.ts`** — the pure ban/pick state machine (`GameState`,
  `phaseFor`, `parsePolicy`, lives, …). No Prisma, no Discord — plain TS.

## Status: Phase 0 (scaffolding)

This package is being grown incrementally. Next to port (with a Prisma-client
**injection** pattern so the engine stays framework-agnostic):

- result/DC resolution + writing `Game`/`GameDeck` rows (from the league's
  `match-write` + the winner/DC logic),
- the Discord match-thread render/buttons layer,
- **extend `BanPickPolicy`** for Team Tour's "ban 5 → pick 3 → choose 1 of 3".

The **League app is untouched** — it keeps its own copy of this logic and
deploys exactly as before. It adopts `match-core` later (the deferred league
migration). Team Tour (`apps/tour`) is the first consumer.

## Build

```
npm run typecheck
npm run build
```
