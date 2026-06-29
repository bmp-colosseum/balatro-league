// Shared parser for the player-facing report form (ReportForm). Every report
// entry point — /report, /profile, /divisions, /me — submits the same FormData
// keys (opponentId, result, deck1/stake1/livesGame1, deck2/stake2/livesGame2),
// so they all parse them the same way here and hand identical args to
// reportSetFromWeb. Decks/stakes are PER GAME (they differ each game). Keeps the
// surfaces from drifting in what they capture.

import type { ReportResultStr, ReportGameInput } from "@/lib/report";

export interface ParsedReportForm {
  opponentId: string;
  result: ReportResultStr;
  // Per-game detail: index 0 = game 1, 1 = game 2.
  games: { game1: ReportGameInput; game2: ReportGameInput };
  // True when opponentId is present and result is one of the three valid
  // scores — callers redirect with an error when false.
  valid: boolean;
}

function parseLivesField(formData: FormData, name: string): number | null {
  const raw = String(formData.get(name) ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function str(formData: FormData, name: string): string | null {
  return String(formData.get(name) ?? "").trim() || null;
}

// Per-game winner's-lives from a dispute form (same field names as the report
// form). Shared so the /report and /profile dispute actions parse identically.
export function parseDisputeLives(formData: FormData): { game1: number | null; game2: number | null } {
  return {
    game1: parseLivesField(formData, "livesGame1"),
    game2: parseLivesField(formData, "livesGame2"),
  };
}

export function parseReportForm(formData: FormData): ParsedReportForm {
  const opponentId = String(formData.get("opponentId") ?? "").trim();
  const result = String(formData.get("result") ?? "") as ReportResultStr;
  // Per-game combos. Fall back to the legacy single deck/stake fields for game 1
  // so an older cached form still records something sensible.
  const games = {
    game1: {
      deck: str(formData, "deck1") ?? str(formData, "deck"),
      stake: str(formData, "stake1") ?? str(formData, "stake"),
      lives: parseLivesField(formData, "livesGame1"),
    },
    game2: {
      deck: str(formData, "deck2"),
      stake: str(formData, "stake2"),
      lives: parseLivesField(formData, "livesGame2"),
    },
  };
  const valid = !!opponentId && ["2-0", "1-1", "0-2"].includes(result);
  return { opponentId, result, games, valid };
}
