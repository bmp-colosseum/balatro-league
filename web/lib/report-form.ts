// Shared parser for the player-facing report form (ReportForm). Every report
// entry point — /report, /profile, /divisions, /me — submits the same FormData
// keys (opponentId, result, deck, stake, livesGame1/2), so they all parse them
// the same way here and hand identical args to reportSetFromWeb. Keeps the
// surfaces from drifting in what they capture.

import type { ReportResultStr } from "@/lib/report";

export interface ParsedReportForm {
  opponentId: string;
  result: ReportResultStr;
  deck: string | null;
  stake: string | null;
  lives: { game1: number | null; game2: number | null };
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

export function parseReportForm(formData: FormData): ParsedReportForm {
  const opponentId = String(formData.get("opponentId") ?? "").trim();
  const result = String(formData.get("result") ?? "") as ReportResultStr;
  const deck = String(formData.get("deck") ?? "").trim() || null;
  const stake = String(formData.get("stake") ?? "").trim() || null;
  const lives = {
    game1: parseLivesField(formData, "livesGame1"),
    game2: parseLivesField(formData, "livesGame2"),
  };
  const valid = !!opponentId && ["2-0", "1-1", "0-2"].includes(result);
  return { opponentId, result, deck, stake, lives, valid };
}
