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
  seasonEndsAt?: Date | null; // when set, the message states the deadline
  /** When true, append a note that the real version carries the buttons. */
  isTest?: boolean;
}

export function buildCheckinMessage(o: CheckinMessageOpts): string {
  const divLink = o.divisionChannelUrl
    ? `your division channel — **${o.divisionName}**: ${o.divisionChannelUrl}`
    : `your division channel **${o.divisionName}**`;
  const lines = [
    `👋 **Still playing ${o.seasonLabel}?**`,
    ``,
    `Hey **${o.name}** — just checking in! We haven't seen you post in your division channel (**${o.divisionName}**) and you haven't played any matches yet this season. No worries at all — just making sure you're still up for it!`,
    ``,
    `**If yes — getting your matches played is on you.** Head to ${divLink}, run \`/schedule\` to see who you play, and **message your opponents directly to set up games.** Don't wait for them to come to you.`,
  ];
  if (o.queueChannelUrl) {
    lines.push(
      `You can *also* **Queue up** when you're online (${o.queueChannelUrl}) and I'll pair you with a free opponent — but that's a bonus, **not a substitute for reaching out and scheduling.**`,
    );
  }
  if (o.seasonEndsAt) {
    const dateStr = o.seasonEndsAt.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
    lines.push(``, `⏳ **The season ends ${dateStr}** — all your matches need to be played before then.`);
  }
  lines.push(``, `**If not,** no worries — just let us know so we can sort your spot.`);
  if (o.isTest) {
    lines.push("", "_🧪 This is a test. The real one players get will have **✅ Still playing** / **🚪 I'm out** buttons below._");
  }
  return lines.join("\n");
}
