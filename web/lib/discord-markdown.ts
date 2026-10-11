// Tiny pure converter from the sliver of Discord markdown the onboarding
// guide (onboarding-guide.ts) actually uses into safe HTML, so the public
// /how-it-works page can render the SAME section bodies the onboarding DM
// sends without printing literal "**" or "<...>" characters. Deliberately
// narrow -- only what the guide's copy uses:
//   **bold**        -> <strong>bold</strong>
//   <https://url>   -> <a href="https://url">https://url</a>
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
  try {
    const u = new URL(url);
    if (u.hostname === "discord.com" && u.pathname.startsWith("/channels/")) return "open in Discord";
    const host = u.hostname.replace(/^www\./, "");
    return u.pathname === "/" || u.pathname === "" ? host : host + u.pathname;
  } catch {
    return url;
  }
}

const TOKEN_RE = /\*\*([^*]+)\*\*|<(https?:\/\/[^<>\s]+)>/g;

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
      html += `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(linkLabel(url))}</a>`;
    }
    lastIndex = index + full.length;
  }
  html += escapeHtml(text.slice(lastIndex));
  return html;
}
