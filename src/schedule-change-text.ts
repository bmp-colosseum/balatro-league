// Pure wording for the "changed" schedule DM (notify.schedule-change worker in
// queue.ts): tells one player which opponent they lost after a roster change,
// whom they play instead, and that nothing else moved. No Discord, no DB.
import { sanitizeName } from "./sanitize.js";

export interface ScheduleNoticeExtra {
  // Who left (shown in the division-wide notice).
  departedName?: string;
  // Under best-N scoring: how many results now count for everyone in the division.
  countBest?: number;
}

function bestNLine(countBest: number | undefined): string | null {
  if (!countBest || countBest < 1) return null;
  return `From now on only your best ${countBest} results count toward the standings, so nobody is worse off for having one match fewer.`;
}

const names = (xs: string[]) => xs.map((n) => `**${sanitizeName(n)}**`).join(" and ");

// Division-wide notice for members whose own matchups did not change.
export function divisionNoticeText(divisionName: string, departedName: string, countBest: number | undefined): string {
  const parts = [
    `**${sanitizeName(departedName)}** has left the division. Your own matchups have not changed -- keep playing them as planned.`,
  ];
  const line = bestNLine(countBest);
  if (line) parts.push(line);
  parts.push("Here is your current schedule:");
  return `\u{1F504} **Schedule update -- ${divisionName}.** ${parts.join(" ")}`;
}

export function changedScheduleText(
  divisionName: string,
  removed: string[],
  added: string[],
  extra: ScheduleNoticeExtra = {},
): string {
  const parts: string[] = [];
  if (removed.length > 0) {
    parts.push(
      `Your match against ${names(removed)} is off -- ${removed.length === 1 ? "they left" : "they have left"} the division, so if you had a time arranged it no longer counts.`,
    );
  }
  if (added.length > 0) {
    parts.push(`You now play ${names(added)} instead -- reach out to set up a time.`);
  }
  if (parts.length === 0) parts.push("One of your matchups changed.");
  parts.push("Everything else on your schedule stays as it was.");
  const line = bestNLine(extra.countBest);
  if (line) parts.push(line);
  parts.push("Here is your current schedule:");
  return `\u{1F504} **Schedule update -- ${divisionName}.** ${parts.join(" ")}`;
}
