// @balatro/tour-core — pure Team Tour domain logic (design §13.4). No Prisma, no
// Discord: plain functions over plain data, unit-tested like @balatro/match-core.
// Web server-actions and the bot are thin shells that load rows, call these, write.
//
// Built (Phase-1 critical path):
//  - bo-x      Bo-X → Bo3 normalization for the game tiebreaker (§12.4)
//  - standings the §5 tiebreaker comparator (rankConference)
//  - schedule  round-robin (circle method) + byes + special weeks (§6.4/§12.6)
//
// Next: ±2 pairing validation, snake draft order, playoff (re)seed.

export * from "./bo-x";
export * from "./standings";
export * from "./schedule";
export * from "./draft";
export * from "./pairing";
export * from "./fantasy";
