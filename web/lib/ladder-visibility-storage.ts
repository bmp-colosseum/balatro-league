// Pure helpers for LadderStrip's localStorage-backed show/hide state
// (components/LadderStrip.tsx) -- no React, no I/O. The component does the
// actual localStorage.getItem/setItem calls; these functions own the key
// and the string <-> boolean mapping so that logic is testable without
// touching localStorage at all.
//
// localStorage (not sessionStorage like CollapsibleDivision's
// division-open-storage.ts) -- the ladder toggle is meant to stick across
// browser restarts, not just the current tab/session, per the "remembered
// per browser" requirement.

// One key for the whole site: there is only one ladder strip (not one per
// division), so no namespacing by id is needed, unlike
// division-open-storage.ts's divisionOpenStorageKey.
export const LADDER_HIDDEN_STORAGE_KEY = "ladder-hidden";

// "1" -> true (hidden), "0" -> false (shown), anything else (including null,
// meaning nothing stored yet) -> null so the caller falls back to its own
// default (shown).
export function parseStoredLadderHidden(raw: string | null): boolean | null {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

// Inverse of parseStoredLadderHidden, for writing.
export function formatStoredLadderHidden(hidden: boolean): string {
  return hidden ? "1" : "0";
}
