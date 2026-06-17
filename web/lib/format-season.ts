// Canonical user-facing label for a Season. Mirrors src/format-season.ts
// on the bot side — same logic, kept in sync by hand since there's no
// shared package. The DB stores `number` (required, unique) and
// `subtitle` (optional); display is:
//   "Season {number}"                 if no subtitle
//   "Season {number} — {subtitle}"   if a subtitle is set

export interface SeasonLabelInput {
  number: number;
  subtitle: string | null;
}

export function formatSeasonLabel(season: SeasonLabelInput): string {
  const base = `Season ${season.number}`;
  return season.subtitle ? `${base} — ${season.subtitle}` : base;
}

// Canonical division label. Numbered: "<Tier> 1", "<Tier> 2", "<Tier> 3", …
// A tier with a single division is just "<Tier>". Mirrors src/format-season.ts.
export function formatDivisionName(tierName: string, groupNumber: number, divisionCount: number): string {
  if (divisionCount <= 1) return tierName;
  return `${tierName} ${groupNumber}`;
}

// Pick the next available number for a brand-new season. Caller is
// responsible for the actual DB write — this just suggests the value.
export async function nextSeasonNumber(prisma: { season: { aggregate: (args: { _max: { number: true } }) => Promise<{ _max: { number: number | null } }> } }): Promise<number> {
  const agg = await prisma.season.aggregate({ _max: { number: true } });
  return (agg._max.number ?? 0) + 1;
}
