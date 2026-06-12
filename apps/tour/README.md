# @balatro/tour — Team Tour app

Pizza Power **Team Tour** — its own app in this monorepo, built on
`@balatro/match-core`. Design: `../../docs/team-tour-design.md`.

## Status: Phase 0 (schema scaffolded)

- `prisma/schema/core.prisma` — synced copy of the shared match engine schema
  (run `npm run sync:core` after editing `packages/match-core/prisma/core.prisma`).
- `prisma/schema/tour.prisma` — the Team Tour data model (Team, Conference,
  TourSeason, TeamSeason, Roster, Week, Matchup, TourSet, Draft, Playoffs,
  Championship, Award). References core `Player`/`Match` by **id string** (no
  cross-boundary Prisma relations — keeps the core reusable).

The merged schema **validates** (`npm run prisma:validate`).

## Not built yet

- The bot + web runtimes (need the Tour Discord app + its own Postgres DB).
- Engine ports into `match-core` (result/DC resolution, Game/GameDeck writes).
- Draft, pairing negotiation, standings, schedule generation, playoffs.

See the design doc §11 (Phase 0 steps) and §9 (phases).
