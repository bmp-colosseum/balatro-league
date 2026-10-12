// Tiny pure converter from the sliver of Discord markdown the onboarding
// guide (onboarding-guide.ts) actually uses into safe HTML, so the public
// /how-it-works page can render the SAME section bodies the onboarding DM
// sends without printing literal "**" or "<...>" characters. Deliberately
// narrow -- only what the guide's copy uses:
//   **bold**        -> <strong>bold</strong>
//   <https://url>   -> <a href="https://url" target="_blank" ...>https://url</a>
//   </relative/path> -> <a href="/relative/path">/relative/path</a> (same tab;
//     lets the web-only loader (lib/loaders/how-it-works.ts) point the
//     standings link at "/standings" instead of a second, www-prefixed host
//     -- ux-round4 L10 -- while the bot's onboarding DM still needs the
//     absolute https URL Discord requires)
// Everything else is treated as plain text and HTML-escaped, so this is safe
// to feed into dangerouslySetInnerHTML even though the source strings are
// all author-controlled (never user input).

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Matches **bold** (no nested "*") or a Discord-style suppressed link
// <https://...> / <http://...> (no whitespace or angle brackets inside).
// Short, readable text for a link: raw Discord channel URLs and long paths
// overflow a phone screen, so show what the link is rather than the URL.
export function linkLabel(url: string): string {
  // A same-origin relative path (see TOKEN_RE below) has no host to parse --
  // show it as given.
  if (url.startsWith("/")) return url;
  try {
    const u = new URL(url);
    if (u.hostname === "discord.com" && u.pathname.startsWith("/channels/")) return "open in Discord";
    const host = u.hostname.replace(/^www\./, "");
    return u.pathname === "/" || u.pathname === "" ? host : host + u.pathname;
  } catch {
    return url;
  }
}

const TOKEN_RE = /\*\*([^*]+)\*\*|<(https?:\/\/[^<>\s]+|\/[^<>\s]+)>/g;

export function discordMarkdownToHtml(text: string): string {
  let html = "";
  let lastIndex = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    const index = match.index ?? 0;
    html += escapeHtml(text.slice(lastIndex, index));
    const [full, bold, url] = match;
    if (bold !== undefined) {
      html += `<strong>${escapeHtml(bold)}</strong>`;
    } else if (url !== undefined) {
      const safeUrl = escapeHtml(url);
      // Relative (same-origin) links stay in the same tab -- only an
      // absolute URL (a real jump off the site, e.g. into Discord) opens a
      // new one.
      const isAbsolute = /^https?:\/\//.test(url);
      const attrs = isAbsolute ? ' target="_blank" rel="noopener noreferrer"' : "";
      html += `<a href="${safeUrl}"${attrs}>${escapeHtml(linkLabel(url))}</a>`;
    }
    lastIndex = index + full.length;
  }
  html += escapeHtml(text.slice(lastIndex));
  return html;
}
