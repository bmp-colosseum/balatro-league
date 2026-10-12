"use client";

import { useEffect } from "react";

export interface SeasonDateSyncDate {
  iso: string;
  // The UTC-formatted text formatDate() (web/lib/season-window-text.ts)
  // baked into the server-rendered section body for this date -- what's
  // actually sitting in the DOM today, so this can find it verbatim.
  fallback: string;
}

export interface SeasonDateSyncProps {
  // DOM id of the section whose text should be scanned (how-it-works/page.tsx
  // gives the "seasons" section id="seasons").
  sectionId: string;
  dates: SeasonDateSyncDate[];
}

// After hydration, swaps the server-rendered (UTC) season start/end dates
// baked into a guide section's body for the viewer's own-timezone rendering
// -- the same Intl.DateTimeFormat call LocalDateTime.tsx uses for
// /standings' SeasonWindow -- so the public /how-it-works guide agrees with
// /standings instead of reading a day off for viewers behind UTC (see
// .claude/knowledge/ux-round3/01-findings.md finding 7).
//
// Does a plain DOM text swap rather than re-rendering the section, so the
// shared guide wording in lib/onboarding-guide.ts (also used verbatim by the
// bot's onboarding DM) is never duplicated here. Renders nothing itself --
// mount it anywhere on the page, it finds its target section by id.
export function SeasonDateSync({ sectionId, dates }: SeasonDateSyncProps) {
  useEffect(() => {
    if (dates.length === 0) return;
    const root = document.getElementById(sectionId);
    if (!root) return;
    for (const { iso, fallback } of dates) {
      const parsed = new Date(iso);
      if (Number.isNaN(parsed.getTime())) continue;
      const local = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(parsed);
      if (local === fallback) continue;
      replaceTextOnce(root, fallback, local);
    }
  }, [sectionId, dates]);

  return null;
}

// Replaces the first occurrence of `from` with `to` among the subtree's text
// nodes. The guide's date substrings never split across markup (the
// "seasons" section's window-line text carries no **bold**/<url> tokens), so
// a single text node always holds the whole match.
function replaceTextOnce(root: HTMLElement, from: string, to: string): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? "";
    const index = text.indexOf(from);
    if (index !== -1) {
      node.textContent = text.slice(0, index) + to + text.slice(index + from.length);
      return;
    }
  }
}
