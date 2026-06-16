// Single source of truth for how a BO2 result reads in a dropdown/confirmation,
// so every surface (report form, admin match actions, per-row overrides,
// disputes) words the same three outcomes identically. Two perspectives:
//   - byName: third-person, for admins acting on two named players
//   - bySelf: first-person, for a player reporting/disputing their own match
// Underlying values stay "2-0" | "1-1" | "0-2"; only the DISPLAY differs.
// Client-safe (pure, no server imports) so client components can use it.

export type ResultStr = "2-0" | "1-1" | "0-2";

// "Alice wins 2–0" / "1–1 draw" / "Bob wins 2–0". `a` is the 2-0 winner side,
// `b` the 0-2 winner side (i.e. playerA / playerB in canonical order, or
// whoever the caller maps to each slot).
export function resultLabelByName(result: ResultStr, a: string, b: string): string {
  if (result === "2-0") return `${a} wins 2–0`;
  if (result === "0-2") return `${b} wins 2–0`;
  return "1–1 draw";
}

// "You beat Bob 2–0" / "1–1 draw" / "Bob beat you 2–0" — from the reporting
// player's point of view.
export function resultLabelBySelf(result: ResultStr, opponent: string): string {
  if (result === "2-0") return `You beat ${opponent} 2–0`;
  if (result === "0-2") return `${opponent} beat you 2–0`;
  return "1–1 draw";
}
