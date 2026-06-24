// "Still playing?" activity check-in message. KEEP IN SYNC with
// web/lib/checkin-message.ts (the web test-send uses that copy; the bot's real
// blast uses this one). Pure — no imports, so it's trivially duplicated.
// Channel references use full jump links — a <#id> mention isn't reliably
// clickable inside a DM.

export interface CheckinMessageOpts {
  name: string;
  divisionName: string;
  divisionChannelUrl: string | null;
  supportChannelUrl: string | null;
  seasonEndsAt?: Date | null;
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
