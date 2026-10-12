// Pure helpers for CollapsibleDivision's sessionStorage-backed open state
// (components/CollapsibleDivision.tsx) -- no React, no I/O. The component
// does the actual sessionStorage.getItem/setItem calls; these functions own
// the key format and the string <-> boolean mapping so that logic is
// testable without touching sessionStorage at all.

// One key per division id so each division's open/closed state is
// remembered independently (L1: back/reload restores what the player
// expanded instead of always collapsing to the default).
export function divisionOpenStorageKey(divisionId: string): string {
  return `division-open:${divisionId}`;
}

// "1" -> true, "0" -> false, anything else (including null, meaning nothing
// stored yet) -> null so the caller falls back to its own default.
export function parseStoredOpen(raw: string | null): boolean | null {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

// Inverse of parseStoredOpen, for writing.
export function formatStoredOpen(open: boolean): string {
  return open ? "1" : "0";
}
