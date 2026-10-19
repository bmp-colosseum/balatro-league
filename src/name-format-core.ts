// One place that decides how a player-controlled name is rendered into Discord.
// Pure: no imports. Never hand-roll escaping at a call site; pick a mode from this table.
//
//   Surface                                              Helper      Limit
//   ---------------------------------------------------  ----------  -----------
//   message content                                      nameMd      2000
//   embed description                                    nameMd      4096
//   embed field VALUE                                    nameMd      1024
//   embed title / author name / footer text              namePlain   256/256/2048
//   embed field NAME                                     namePlain   256
//   thread / channel names                               namePlain   100
//   select-menu label / description / placeholder        namePlain   100/100/150
//   button label                                         namePlain   80
//   autocomplete choice name                             namePlain   100
//
// Doc status (checked 2026-10-18 via doc-fetcher):
//   - Limits above: https://docs.discord.com/developers/resources/message
//     (Embed Limits), .../components/reference, .../resources/channel,
//     .../interactions/application-commands.
//   - Markdown in description and field value is the long-standing behaviour but
//     the current developer docs do not state it, and they say NOTHING about
//     title, author, footer or field name. Those are treated as plain text: if a
//     surface does render markdown, a plain name only loses its styling, whereas
//     escaping on a surface that does not render it leaves visible backslashes.
//   - nameMd uses its own per-character escaper instead of discord.js escapeMarkdown:
//     escapeMarkdown leaves unescaped `**` pairs inside long asterisk runs and has
//     no option for a leading `>` (blockquote). Same output for ordinary names.
//
// Mention neutralising (both modes): `@everyone`, `@here`, and the `<@...>`,
// `<@&...>`, `<#...>` tokens are defanged by swapping the `@` / `#` for its
// fullwidth twin (U+FF20 / U+FF03). The swap keeps the string length unchanged,
// so namePlain can promise "never longer than the input". The bot Client also
// defaults to allowedMentions { parse: [] }; this is the second line of defence
// for surfaces where an allowlist is not set.
//
// nameMd is NOT idempotent (a second pass doubles backslashes). Apply it exactly
// once, at the point the name enters a string that is sent to Discord.

const FULLWIDTH_AT = "\uFF20";
const FULLWIDTH_HASH = "\uFF03";

function defangMentions(name: string): string {
  return name.replace(/(?<=<)[@#]|@(?=everyone|here)/gi, (m) =>
    m === "#" ? FULLWIDTH_HASH : FULLWIDTH_AT,
  );
}

const INLINE_MARKUP = /[\\*_~`|[]/g;
const LINE_START_MARKUP = /^([ \t]*)([#>-])/gm;
const LINE_START_NUMBER = /^([ \t]*\d+)\./gm;

/** For message content, embed descriptions and embed field values. */
export function nameMd(name: string): string {
  return defangMentions(name)
    .replace(INLINE_MARKUP, "\\$&")
    .replace(LINE_START_MARKUP, "$1\\$2")
    .replace(LINE_START_NUMBER, "$1\\.");
}

/** For every surface that does not render markdown. Trimmed, never longer than `name`. */
export function namePlain(name: string): string {
  return defangMentions(name).trim();
}

export interface JoinNamesOptions {
  /** Maximum length of the returned string. */
  max: number;
  mode: "md" | "plain";
}

/**
 * Join names with ", ". If the list does not fit in `max` characters, keep as
 * many leading names as fit and append " and N more". The result is never longer
 * than `max` (a `max` too small for even the suffix hard-slices the result).
 */
export function joinNames(names: readonly string[], opts: JoinNamesOptions): string {
  const fmt = opts.mode === "md" ? nameMd : namePlain;
  const formatted = names.map(fmt);
  const full = formatted.join(", ");
  if (full.length <= opts.max) return full;
  for (let keep = formatted.length - 1; keep >= 1; keep--) {
    const candidate = `${formatted.slice(0, keep).join(", ")} and ${formatted.length - keep} more`;
    if (candidate.length <= opts.max) return candidate;
  }
  return `and ${formatted.length} more`.slice(0, Math.max(0, opts.max));
}

/**
 * Join already-formatted lines with newlines within `max` characters. When they
 * do not all fit, keep the leading lines that do and end with "_...and N more_".
 * For one-name-per-line posts (standings, schedule fields).
 */
export function fitLines(lines: readonly string[], max: number): string {
  const full = lines.join("\n");
  if (full.length <= max) return full;
  for (let keep = lines.length - 1; keep >= 1; keep--) {
    const candidate = `${lines.slice(0, keep).join("\n")}\n_...and ${lines.length - keep} more_`;
    if (candidate.length <= max) return candidate;
  }
  return `_...and ${lines.length} more_`.slice(0, Math.max(0, max));
}
