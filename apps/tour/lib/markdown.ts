// Render a news post body written in Discord-flavored Markdown (bold/italic/strikethrough,
// inline code + code blocks, block quotes, lists, headings, links) to HTML. Names are pasted
// straight from Discord, so we first auto-link known team/player names (as Markdown links) and
// then hand the whole thing to marked, so both features compose. Authors are admins only, so
// the resulting HTML is trusted (rendered via dangerouslySetInnerHTML).
import { marked } from "marked";
import { buildNameLinker } from "./linkify";

export function renderPostMarkdown(body: string, entities: { name: string; href: string }[]): string {
  const linker = buildNameLinker(entities);
  const withLinks = linker(body)
    .map((s) => (s.href ? `[${s.text}](${s.href})` : s.text))
    .join("");
  // breaks: single newline -> <br> (Discord treats a lone newline as a line break);
  // gfm: strikethrough, autolinks, etc.
  return marked.parse(withLinks, { async: false, breaks: true, gfm: true }) as string;
}
