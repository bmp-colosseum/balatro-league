// Tests for renderMatch's game-number dispatch. The bug: a BO5's games 4
// and 5 were silently rendered as "Game 3" because the dispatch hardcoded
// 1/2/3 (see real match cms7q6ggn00c8p92q972x53qv). These lock in that
// games 1..5 all flow through the same derived (gameNum-based) path, and
// that no existing bestOf-2/3 behavior regressed along the way.
import { describe, it, expect } from "vitest";
import type { MatchSession, Player } from "@prisma/client";
import type { EmbedBuilder } from "discord.js";
import { renderMatch } from "./match-render.js";
import { emptyGameState, type GameState } from "./match-session.js";
import type { DeckEntry } from "./match-pool.js";

const P = (id: string, discordId: string, displayName: string): Player =>
  ({ id, discordId, displayName }) as unknown as Player;

const A = P("player-a", "discord-a", "Alice");
const B = P("player-b", "discord-b", "Bob");

const pool = (n = 9): DeckEntry[] => Array.from({ length: n }, (_, i) => ({ deck: `Deck${i}`, stake: "White" }));

// noUncheckedIndexedAccess makes embeds[0] possibly-undefined; every render
// path under test always returns at least one embed, so fail loudly instead
// of asserting on `undefined` if that ever stops being true.
function firstEmbed(embeds: EmbedBuilder[]): EmbedBuilder {
  const embed = embeds[0];
  if (!embed) throw new Error("expected renderMatch to return at least one embed");
  return embed;
}

// Base session with every game slot empty; overrides + gameStates layer in
// exactly the fields a given test needs.
function makeSession(
  overrides: Partial<MatchSession>,
  gameStates: Partial<Record<"game1" | "game2" | "game3" | "game4" | "game5", GameState>> = {},
): MatchSession {
  const base: Record<string, unknown> = {
    id: "match-1",
    playerAId: A.id,
    playerBId: B.id,
    state: "GAME_1_BAN",
    pausedFromState: null,
    pauseInitiatorPlayerId: null,
    resumeInitiatorPlayerId: null,
    pausedAt: null,
    cancelInitiatorPlayerId: null,
    cancelInitiatedAt: null,
    dcInitiatorPlayerId: null,
    version: 0,
    isCasual: false,
    bestOf: 2,
    policy: null,
    customComboProposal: null,
    game1: null,
    game2: null,
    game3: null,
    game4: null,
    game5: null,
    ...overrides,
  };
  for (const [field, state] of Object.entries(gameStates)) {
    base[field] = JSON.stringify(state);
  }
  return base as unknown as MatchSession;
}

describe("renderMatch — BO5 games 4 and 5 render as themselves, not game 3", () => {
  it("GAME_4_BAN renders 'Game 4', not 'Game 3'", () => {
    const game4 = emptyGameState(A.id, pool());
    const session = makeSession({ state: "GAME_4_BAN", bestOf: 5 }, { game4 });
    const { embeds } = renderMatch(session, A, B);
    expect(firstEmbed(embeds).data.title).toBe("🎴 Game 4 — League");
  });

  it("GAME_5_PICK renders 'Game 5' and the picker's turn ping", () => {
    const game5: GameState = {
      ...emptyGameState(B.id, pool()),
      bans: [0, 1, 2, 3, 4, 5, 6], // all 7 bans done -> PICK phase, other player (A) picks
    };
    const session = makeSession({ state: "GAME_5_PICK", bestOf: 5 }, { game5 });
    const { embeds, content, turnKey } = renderMatch(session, A, B);
    expect(firstEmbed(embeds).data.title).toBe("🎴 Game 5 — League");
    expect(content).toBe(`<@${A.discordId}> 🎯 your turn — pick the deck/stake.`);
    expect(turnKey).toBe(A.discordId);
  });

  it("GAME_4_PLAYING pings both players to go play, not silently falling through", () => {
    const game4: GameState = { ...emptyGameState(A.id, pool()), pickedDeckIdx: 0 };
    const session = makeSession({ state: "GAME_4_PLAYING", bestOf: 5 }, { game4 });
    const { content, turnKey } = renderMatch(session, A, B);
    expect(content).toBe(`<@${A.discordId}> <@${B.discordId}> 🃏 play the match, then vote for the winner.`);
    expect(turnKey).toBe("BOTH");
  });

  it("games 4 and 5 get distinct colors from games 1-3 (and from each other)", () => {
    const g4 = makeSession({ state: "GAME_4_BAN", bestOf: 5 }, { game4: emptyGameState(A.id, pool()) });
    const g5 = makeSession({ state: "GAME_5_BAN", bestOf: 5 }, { game5: emptyGameState(A.id, pool()) });
    const g1 = makeSession({ state: "GAME_1_BAN", bestOf: 5 }, { game1: emptyGameState(A.id, pool()) });
    const c1 = firstEmbed(renderMatch(g1, A, B).embeds).data.color;
    const c4 = firstEmbed(renderMatch(g4, A, B).embeds).data.color;
    const c5 = firstEmbed(renderMatch(g5, A, B).embeds).data.color;
    expect(new Set([c1, c4, c5]).size).toBe(3);
    expect(c4).toBeDefined();
    expect(c5).toBeDefined();
  });

  it("COMPLETE tallies wins across all 5 games, not just the first 3", () => {
    const win = (winnerId: string): GameState => ({
      ...emptyGameState(winnerId, pool()),
      pickedDeckIdx: 0,
      winnerId,
    });
    const session = makeSession(
      { state: "COMPLETE", bestOf: 5 },
      {
        game1: win(A.id),
        game2: win(B.id),
        game3: win(A.id),
        game4: win(B.id),
        game5: win(A.id),
      },
    );
    const embed = firstEmbed(renderMatch(session, A, B).embeds);
    // 3-2 Alice, not 2-1 (which is what a "only games 1-3 counted" bug would show).
    expect(embed.data.description).toContain("3-2");
    const field = embed.data.fields?.[0];
    if (!field) throw new Error("expected a Games field on the complete embed");
    expect(field.value.split("\n")).toHaveLength(5);
  });
});

describe("renderMatch — CHOOSE_FIRST tiebreaker wording generalizes correctly", () => {
  it("BO2's game 2 is never called a 'decider'/'tiebreaker' (ties are a valid final result)", () => {
    const session = makeSession(
      { state: "GAME_2_CHOOSE_FIRST", bestOf: 2 },
      { game1: { ...emptyGameState(A.id, pool()), pickedDeckIdx: 0, winnerId: A.id } },
    );
    const { content, turnKey } = renderMatch(session, A, B);
    expect(content).toBe(`<@${B.discordId}> 🎯 you lost game 1 — pick who bans first in game 2.`);
    expect(turnKey).toBe(B.discordId);
  });

  it("BO3's game 3 IS the tiebreaker", () => {
    const session = makeSession(
      { state: "GAME_3_CHOOSE_FIRST", bestOf: 3 },
      { game2: { ...emptyGameState(A.id, pool()), pickedDeckIdx: 0, winnerId: B.id } },
    );
    const { content, turnKey } = renderMatch(session, A, B);
    expect(content).toBe(`<@${A.discordId}> 🎯 game 3 tiebreaker — pick who bans first.`);
    expect(turnKey).toBe(A.discordId);
  });

  it("BO5's game 4 is NOT the tiebreaker (series may still continue to game 5)", () => {
    const session = makeSession(
      { state: "GAME_4_CHOOSE_FIRST", bestOf: 5 },
      { game3: { ...emptyGameState(A.id, pool()), pickedDeckIdx: 0, winnerId: A.id } },
    );
    const { content } = renderMatch(session, A, B);
    expect(content).toBe(`<@${B.discordId}> 🎯 you lost game 3 — pick who bans first in game 4.`);
  });

  it("BO5's game 5 IS the tiebreaker", () => {
    const session = makeSession(
      { state: "GAME_5_CHOOSE_FIRST", bestOf: 5 },
      { game4: { ...emptyGameState(A.id, pool()), pickedDeckIdx: 0, winnerId: B.id } },
    );
    const { content } = renderMatch(session, A, B);
    expect(content).toBe(`<@${A.discordId}> 🎯 game 5 tiebreaker — pick who bans first.`);
  });
});

describe("renderMatch — WAITING_ACCEPT still pings the invitee", () => {
  it("pings player B to accept/decline", () => {
    const session = makeSession({ state: "WAITING_ACCEPT" });
    const { content, turnKey } = renderMatch(session, A, B);
    expect(content).toBe(`<@${B.discordId}> 🎴 match invite from <@${A.discordId}> — accept or decline.`);
    expect(turnKey).toBe(B.discordId);
  });
});
