// Central scoring rules. Keep all "what does N-N mean" logic here so a future rule tweak
// (e.g. switch 1-1 from 1pt to 0.5pt) is a one-file change.

export const POINTS_FOR_2_0_WIN = 3;
export const POINTS_FOR_1_1_DRAW = 1;
export const POINTS_FOR_LOSS = 0;

export type PairingResult = "2-0" | "1-1" | "0-2";

export function parsePairingResult(input: string): PairingResult | null {
  if (input === "2-0" || input === "1-1" || input === "0-2") return input;
  return null;
}

export function pointsFromGames(gamesWonSelf: number, gamesWonOpponent: number): number {
  if (gamesWonSelf === 2 && gamesWonOpponent === 0) return POINTS_FOR_2_0_WIN;
  if (gamesWonSelf === 1 && gamesWonOpponent === 1) return POINTS_FOR_1_1_DRAW;
  if (gamesWonSelf === 0 && gamesWonOpponent === 2) return POINTS_FOR_LOSS;
  // Anything else is malformed — treat as 0 and let callers validate upstream.
  return 0;
}

export function gamesFromResult(result: PairingResult): { a: number; b: number } {
  switch (result) {
    case "2-0":
      return { a: 2, b: 0 };
    case "1-1":
      return { a: 1, b: 1 };
    case "0-2":
      return { a: 0, b: 2 };
  }
}
