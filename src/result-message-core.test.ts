import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  buildConfirmedResultBlocks,
  buildReportMessageBlocks,
  confirmedFooterLine,
  confirmedGameLine,
  confirmedGamesLines,
  confirmedHeaderText,
  confirmedMetaLine,
  type GameLineInput,
} from "./result-message-core.js";

function game(overrides: Partial<GameLineInput> = {}): GameLineInput {
  return {
    num: 1,
    deck: "Red Deck",
    stake: "Gold",
    deckEmoji: null,
    stakeEmoji: null,
    winnerName: null,
    winnerLives: null,
    ...overrides,
  };
}

describe("confirmedMetaLine", () => {
  it("renders the season and division header", () => {
    expect(confirmedMetaLine({ seasonLabel: "Season 3", divisionName: "Legendary 1" })).toBe(
      "### Season 3 - Legendary 1",
    );
  });
});

describe("confirmedHeaderText", () => {
  it("names the winner first on a sweep", () => {
    expect(confirmedHeaderText({ playerAName: "Alice", playerBName: "Bob", gamesWonA: 2, gamesWonB: 0 })).toBe(
      "**Alice beats Bob** 2-0",
    );
  });

  it("names the actual winner first even when player B won", () => {
    expect(confirmedHeaderText({ playerAName: "Alice", playerBName: "Bob", gamesWonA: 0, gamesWonB: 2 })).toBe(
      "**Bob beats Alice** 2-0",
    );
  });

  it("renders a draw with player A first", () => {
    expect(confirmedHeaderText({ playerAName: "Alice", playerBName: "Bob", gamesWonA: 1, gamesWonB: 1 })).toBe(
      "**Alice draws Bob** 1-1",
    );
  });
});

describe("confirmedGameLine", () => {
  it("renders deck/stake, winner, and lives when all are present", () => {
    expect(
      confirmedGameLine(
        game({ num: 1, deck: "Red Deck", stake: "Gold", deckEmoji: "<:deck_red:1>", stakeEmoji: "<:stake_gold:2>", winnerName: "Alice", winnerLives: 3 }),
      ),
    ).toBe("<:deck_red:1><:stake_gold:2> 1. Red Deck / Gold - **Alice** (3 lives left)");
  });

  it("omits the icon prefix when no emoji is uploaded", () => {
    expect(confirmedGameLine(game({ num: 2, winnerName: "Bob" }))).toBe("2. Red Deck / Gold - **Bob**");
  });

  it("omits the lives suffix when lives were not captured", () => {
    expect(confirmedGameLine(game({ num: 3, winnerName: "Alice", winnerLives: null }))).toBe(
      "3. Red Deck / Gold - **Alice**",
    );
  });

  it("omits the winner clause entirely when there is no winner", () => {
    expect(confirmedGameLine(game({ num: 4, winnerName: null }))).toBe("4. Red Deck / Gold");
  });

  it("falls back to a placeholder combo when deck/stake are missing but a winner is recorded", () => {
    expect(confirmedGameLine(game({ num: 5, deck: null, stake: null, winnerName: "Alice" }))).toBe(
      "5. _combo not recorded_ - **Alice**",
    );
  });

  it("returns null when neither combo nor winner is recorded", () => {
    expect(confirmedGameLine(game({ deck: null, stake: null, winnerName: null }))).toBeNull();
  });
});

describe("confirmedGamesLines", () => {
  it("joins multiple game lines with newlines", () => {
    expect(
      confirmedGamesLines([game({ num: 1, winnerName: "Alice" }), game({ num: 2, winnerName: "Bob" })], null),
    ).toBe("1. Red Deck / Gold - **Alice**\n2. Red Deck / Gold - **Bob**");
  });

  it("skips games with nothing recorded", () => {
    expect(
      confirmedGamesLines([game({ num: 1, winnerName: "Alice" }), game({ deck: null, stake: null, winnerName: null })], null),
    ).toBe("1. Red Deck / Gold - **Alice**");
  });

  it("falls back to the legacy reported combo when there are no Game rows", () => {
    expect(confirmedGamesLines([], "Blue Deck / White")).toBe("Played: Blue Deck / White");
  });

  it("returns null when there are no games and no fallback combo", () => {
    expect(confirmedGamesLines([], null)).toBeNull();
  });
});

describe("confirmedFooterLine", () => {
  it("renders the match id as Discord small text", () => {
    expect(confirmedFooterLine("abc123")).toBe("-# Match abc123");
  });
});

describe("buildConfirmedResultBlocks", () => {
  const base = {
    seasonLabel: "Season 4",
    divisionName: "Rare 2",
    divisionUrl: "https://www.balatroleague.com/divisions/d1",
    playerAName: "Alice",
    playerBName: "Bob",
    matchId: "match1",
    games: [] as GameLineInput[],
    fallbackCombo: null as string | null,
  };

  it("links the header to the division page and has no forfeit line by default", () => {
    const blocks = buildConfirmedResultBlocks({ ...base, gamesWonA: 2, gamesWonB: 0, forfeit: false });
    expect(blocks.metaLine).toBe("### Season 4 - Rare 2");
    expect(blocks.headerLine).toBe("## [**Alice beats Bob** 2-0](https://www.balatroleague.com/divisions/d1)");
    expect(blocks.gamesLine).toBeNull();
    expect(blocks.footerLine).toBe("-# Match match1");
  });

  it("appends the forfeit wording under the header on a DQ win", () => {
    const blocks = buildConfirmedResultBlocks({ ...base, gamesWonA: 2, gamesWonB: 0, forfeit: true });
    expect(blocks.headerLine).toBe(
      "## [**Alice beats Bob** 2-0](https://www.balatroleague.com/divisions/d1)\n_Win by forfeit / DQ._",
    );
  });

  it("renders a draw", () => {
    const blocks = buildConfirmedResultBlocks({ ...base, gamesWonA: 1, gamesWonB: 1, forfeit: false });
    expect(blocks.headerLine).toBe("## [**Alice draws Bob** 1-1](https://www.balatroleague.com/divisions/d1)");
  });

  it("includes the per-game breakdown when Game rows are present", () => {
    const blocks = buildConfirmedResultBlocks({
      ...base,
      gamesWonA: 2,
      gamesWonB: 0,
      forfeit: false,
      games: [game({ num: 1, winnerName: "Alice", winnerLives: 2 }), game({ num: 2, winnerName: "Alice" })],
    });
    expect(blocks.gamesLine).toBe("1. Red Deck / Gold - **Alice** (2 lives left)\n2. Red Deck / Gold - **Alice**");
  });
});

describe("buildReportMessageBlocks", () => {
  const base = {
    divisionName: "Uncommon 1",
    reporterName: "Alice",
    opponentName: "Bob",
    opponentMention: "<@123> (@bob)",
    reporterIsA: true,
    gamesWonA: 2,
    gamesWonB: 0,
  };

  it("PENDING: reports from the reporter's point of view and pings the opponent", () => {
    const blocks = buildReportMessageBlocks({ ...base, status: "PENDING" });
    expect(blocks.metaLine).toBe("### Uncommon 1");
    expect(blocks.headerLine).toBe("## Alice reports 2-0 over Bob");
    expect(blocks.bodyLine).toBe(
      "<@123> (@bob), please **Confirm** or **Dispute** within 2 minutes. Auto-confirms if no response.",
    );
    expect(blocks.comboLine).toBeNull();
  });

  it("PENDING: includes the combo line when one was captured", () => {
    const blocks = buildReportMessageBlocks({ ...base, status: "PENDING", combo: { deck: "Red Deck", stake: "Gold" } });
    expect(blocks.comboLine).toBe("Played: Red Deck / Gold");
  });

  it("CONFIRMED: shows the sweep verdict and scoreline", () => {
    const blocks = buildReportMessageBlocks({ ...base, status: "CONFIRMED" });
    expect(blocks.headerLine).toBe("## **Alice swept**");
    expect(blocks.bodyLine).toBe("Alice **2-0** Bob");
  });

  it("CONFIRMED: shows the draw verdict", () => {
    const blocks = buildReportMessageBlocks({ ...base, status: "CONFIRMED", gamesWonA: 1, gamesWonB: 1 });
    expect(blocks.headerLine).toBe("## **Alice and Bob drew 1-1**");
  });

  it("CONFIRMED: credits the opponent when they are the one who swept", () => {
    const blocks = buildReportMessageBlocks({ ...base, status: "CONFIRMED", gamesWonA: 0, gamesWonB: 2 });
    expect(blocks.headerLine).toBe("## **Bob swept**");
  });

  it("AUTO_CONFIRMED: adds the auto-confirm note", () => {
    const blocks = buildReportMessageBlocks({ ...base, status: "AUTO_CONFIRMED" });
    expect(blocks.headerLine).toBe("## **Alice swept**");
    expect(blocks.bodyLine).toBe("Alice **2-0** Bob\n_Auto-confirmed after 2 minutes -- opponent didn't respond._");
  });

  it("DISPUTED: pings the opponent and mentions the helper ping", () => {
    const blocks = buildReportMessageBlocks({ ...base, status: "DISPUTED" });
    expect(blocks.headerLine).toBe("## Match disputed");
    expect(blocks.bodyLine).toBe(
      "Alice **2-0** Bob\n<@123> (@bob) disputed the result. A helper has been pinged in the thread below.",
    );
  });

  it("scoreline always orders reporter's games first regardless of A/B seat", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(true, false),
        fc.constantFrom(
          [2, 0] as const,
          [0, 2] as const,
          [1, 1] as const,
        ),
        (reporterIsA, [gamesWonA, gamesWonB]) => {
          const blocks = buildReportMessageBlocks({
            ...base,
            status: "CONFIRMED",
            reporterIsA,
            gamesWonA,
            gamesWonB,
          });
          const reporterGames = reporterIsA ? gamesWonA : gamesWonB;
          const opponentGames = reporterIsA ? gamesWonB : gamesWonA;
          expect(blocks.bodyLine).toBe(`Alice **${reporterGames}-${opponentGames}** Bob`);
        },
      ),
    );
  });
});
