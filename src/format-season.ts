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
