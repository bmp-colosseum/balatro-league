// Pure wording for the "changed" schedule DM (notify.schedule-change worker in
// queue.ts): tells one player which opponent they lost after a roster change,
// whom they play instead, and that nothing else moved. No Discord, no DB.
import { sanitizeName } from "./sanitize.js";

export function changedScheduleText(divisionName: string, removed: string[], added: string[]): string {
  const names = (xs: string[]) => xs.map((n) => `**${sanitizeName(n)}**`).join(" and ");
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
  parts.push("Everything else on your schedule stays as it was. Here is your current schedule:");
  return `\u{1F504} **Schedule update -- ${divisionName}.** ${parts.join(" ")}`;
}
