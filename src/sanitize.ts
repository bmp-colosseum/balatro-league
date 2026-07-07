import { escapeMarkdown } from "discord.js";

// Escape Discord markdown in a user-controlled name. Display names can contain
// **bold**, _italics_, `code`, ||spoilers||, [masked](links), #headings, etc.,
// which would otherwise break our formatting or inject links/markup into bot
// messages. Wrap a player's displayName with this ANY time it goes into message
// content or an embed title/description/field value.
//
// NOT needed (and should be avoided) for: select-menu option labels, thread
// names, autocomplete choice names, and audit summaries — those are plain text
// and don't render markdown, so escaping there would just add stray backslashes.
export function sanitizeName(name: string): string {
  return escapeMarkdown(name, {
    heading: true,
    bulletedList: true,
    numberedList: true,
    maskedLink: true,
  });
}
