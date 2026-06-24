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
  supportChannelUrl: string | null; // jump link to #league-support
  seasonEndsAt?: Date | null; // when set, the message states the deadline
  /** When true, append a note that the real version carries the buttons. */
  isTest?: boolean;
}

export function buildCheckinMessage(o: CheckinMessageOpts): string {
  const divCh = o.divisionChannelUrl ? `your division channel (${o.divisionChannelUrl})` : "your division channel";
  const supportRef = o.supportChannelUrl ? `#league-support (${o.supportChannelUrl})` : "#league-support";
  const lines = [
    `Hey ${o.name}, quick check-in. You're in ${o.divisionName} but we haven't seen you play or post this season. Still up for it?`,
    ``,
    `If you are: head to ${divCh}, run \`/schedule\` to see who you play, and message them to set up games.`,
  ];
  if (o.queueChannelUrl) {
    lines.push(`You can also Queue up (${o.queueChannelUrl}) when you're around and I'll pair you with whoever's free.`);
  }
  if (o.seasonEndsAt) {
    const unix = Math.floor(o.seasonEndsAt.getTime() / 1000);
    lines.push(``, `Season ends <t:${unix}:D> (<t:${unix}:R>), so get your games in before then.`);
  }
  lines.push(``, `Not playing this season? Hit "I'm out" below and we'll free up your spot.`);
  lines.push(``, `Don't reply here (it's not monitored), just use the buttons. Need help? Run \`/support\` in ${supportRef}.`);
  if (o.isTest) {
    lines.push(``, `_(Test — the real one has "Still playing" / "I'm out" buttons under it.)_`);
  }
  return lines.join("\n");
}
