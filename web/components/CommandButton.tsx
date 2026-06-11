"use client";

// Clickable affordance for the ⌘K command palette — fires the custom event the
// CommandPalette listens for. Gives mobile/mouse users a way in (and advertises
// the keyboard shortcut). Icon-only on phones; full label + ⌘K hint on sm+.

import { Search } from "lucide-react";

export function CommandButton() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event("command:toggle"))}
      title="Search / jump to a page (Ctrl/⌘ K)"
      aria-label="Search"
      className="flex items-center gap-1.5 rounded border border-border bg-secondary px-2 py-1 text-xs text-[var(--muted)] transition-colors hover:text-foreground"
    >
      <Search className="size-3.5" />
      <span className="hidden sm:inline">Search</span>
      <kbd className="hidden rounded bg-[var(--bg)] px-1 text-[10px] leading-none sm:inline-flex">⌘K</kbd>
    </button>
  );
}
