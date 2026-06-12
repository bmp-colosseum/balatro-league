// @balatro/match-core — the shared 1v1 match engine.
//
// What's here today (Phase 0, growing): the pure ban/pick state machine. The
// schema fragment lives at `prisma/core.prisma`. Prisma-dependent helpers
// (writing Game/GameDeck rows, result resolution) get ported next with a
// client-injection pattern so the engine stays framework-agnostic.

export * from "./match-state.js";
