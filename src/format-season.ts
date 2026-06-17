// Canonical user-facing label for a Season. The DB stores `number`
// (required, unique) and `subtitle` (optional). Display is:
//   "Season {number}"                 if no subtitle
//   "Season {number} — {subtitle}"   if a subtitle is set
//
// Use this anywhere the season appears in audit messages, Discord
// embeds, channel topics, etc. — direct `season.subtitle` reads should
// only happen in admin edit forms where the raw value is the point.

export interface SeasonLabelInput {
  number: number;
  subtitle: string | null;
}

export function formatSeasonLabel(season: SeasonLabelInput): string {
  const base = `Season ${season.number}`;
  return season.subtitle ? `${base} — ${season.subtitle}` : base;
}

// Canonical division label. Numbered: "<Tier> 1", "<Tier> 2", "<Tier> 3", …
// A tier with a single division is just "<Tier>". Mirrors web/lib/format-season.ts.
export function formatDivisionName(tierName: string, groupNumber: number, divisionCount: number): string {
  if (divisionCount <= 1) return tierName;
  return `${tierName} ${groupNumber}`;
}
