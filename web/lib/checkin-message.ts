// The "still playing?" check-in message sent to silent players. Kept here so the
// test send (web) and the real blast (bot, phase 2) render identical copy.
// Channel references use full jump links (https://discord.com/channels/g/c) —
// a <#id> mention isn't reliably clickable inside a DM.

export interface CheckinMessageOpts {
  name: string;
  seasonLabel: string;
  divisionName: string;
  divisionChannelUrl: string | null; // jump link, or null if unknown
  queueChannelUrl: string | null;
  /** When true, append a note that the real version carries the buttons. */
  isTest?: boolean;
}

export function buildCheckinMessage(o: CheckinMessageOpts): string {
  const divLink = o.divisionChannelUrl
    ? `your division channel — **${o.divisionName}**: ${o.divisionChannelUrl}`
    : `your division channel **${o.divisionName}**`;
  const queueLine = o.queueChannelUrl
    ? ` — or **Queue up** when you're free: ${o.queueChannelUrl}`
    : "";
  const lines = [
    `👋 **Still playing ${o.seasonLabel}?**`,
    ``,
    `Hey **${o.name}** — you're in **${o.divisionName}** but haven't played any matches yet. Just checking you're still up for it!`,
    ``,
    `**If yes:** head to ${divLink}, run \`/schedule\` to see who you play, and message them to set up games${queueLine}.`,
    ``,
    `**If not,** no worries — just let us know so we can sort your spot.`,
  ];
  if (o.isTest) {
    lines.push("", "_🧪 This is a test. The real one players get will have **✅ Still playing** / **🚪 I'm out** buttons below._");
  }
  return lines.join("\n");
}
