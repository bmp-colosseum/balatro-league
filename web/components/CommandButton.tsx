"use client";

// Clickable affordance for the ⌘K command palette — fires the custom event the
// CommandPalette listens for. Gives mobile/mouse users a way in (and advertises
// the keyboard shortcut).

export function CommandButton() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event("command:toggle"))}
      title="Search / jump to a page (Ctrl/⌘ K)"
      className="flex items-center gap-1.5 rounded border border-border bg-secondary px-2 py-1 text-xs text-[var(--muted)] transition-colors hover:text-foreground"
    >
      <span>Search</span>
      <kbd className="rounded bg-[var(--bg)] px-1 text-[10px] leading-none">⌘K</kbd>
    </button>
  );
}
