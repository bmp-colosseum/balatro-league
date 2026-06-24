// The "still playing?" check-in message sent to silent players. Kept here so the
// test send (web) and the real blast (bot, phase 2) render identical copy.
// Channel references use full jump links (https://discord.com/channels/g/c) —
// a <#id> mention isn't reliably clickable inside a DM.

export interface CheckinMessageOpts {
  name: string;
  divisionName: string;
  divisionChannelUrl: string | null; // jump link, or null if unknown
  supportChannelUrl: string | null; // jump link to #league-support
  seasonEndsAt?: Date | null; // when set, the message states the deadline
  /** When true, append a note that the real version carries the buttons. */
  isTest?: boolean;
}

// League staff to contact if you're NOT continuing.
const STAFF_CONTACTS = ["152639712937508869", "486508153991593984"];

export function buildCheckinMessage(o: CheckinMessageOpts): string {
  const divCh = o.divisionChannelUrl ? `your division channel (${o.divisionChannelUrl})` : "your division channel";
  const supportRef = o.supportChannelUrl ? `#league-support (${o.supportChannelUrl})` : "#league-support";
  const staff = STAFF_CONTACTS.map((id) => `<@${id}>`).join(" or ");
  const lines = [
    `Hey ${o.name}, quick check-in. You're in ${o.divisionName} but we haven't seen you play or post this season. Still up for it?`,
    ``,
    `If you are: head to ${divCh}, run \`/schedule\` to see who you play, and message them to set up games.`,
  ];
  if (o.seasonEndsAt) {
    const unix = Math.floor(o.seasonEndsAt.getTime() / 1000);
    lines.push(``, `Season ends <t:${unix}:D> (<t:${unix}:R>), so get your games in before then.`);
  }
  lines.push(
    ``,
    `Still in? Tap **Still playing** below.`,
    `Not playing this season? Let ${staff} know, or open a ticket with \`/support\` in ${supportRef}.`,
    ``,
    `(Don't reply to this DM, it isn't monitored.)`,
  );
  if (o.isTest) {
    lines.push(``, `_(Test — the real one has a "Still playing" button under it.)_`);
  }
  return lines.join("\n");
}
