"use client";

import { useEffect, useState, type ReactNode } from "react";
import { divisionOpenStorageKey, formatStoredOpen, parseStoredOpen } from "@/lib/division-open-storage";

const PHONE_QUERY = "(max-width: 640px)";

// Reads a division's remembered open state from sessionStorage. Returns
// null when nothing is stored yet (first visit this tab), so the caller
// falls back to its own default.
function readStoredOpen(divisionId: string): boolean | null {
  try {
    return parseStoredOpen(window.sessionStorage.getItem(divisionOpenStorageKey(divisionId)));
  } catch {
    // Private-mode / storage-disabled browsers: behave as if nothing is stored.
    return null;
  }
}

function writeStoredOpen(divisionId: string, open: boolean): void {
  try {
    window.sessionStorage.setItem(divisionOpenStorageKey(divisionId), formatStoredOpen(open));
  } catch {
    // Ignore write failures (quota, private mode); the toggle still works
    // for this page view, it just won't be remembered.
  }
}

// A division card body that collapses to a one-line summary on phones only.
// It used to be a native <details>, but Chrome hides a closed details'
// content in a way page CSS cannot override, so desktop showed an empty
// card for every division that started collapsed. The server renders
// everything open (right for desktop, search engines and no-JS). On a
// phone, divisions marked closed-by-default hide their body through CSS
// (data-ready="0") until this mounts, after which state owns the toggle.
//
// The one toggle button plays two roles depending on data-open, purely via
// CSS (both spans always render so v1/SSR/no-JS never see a layout shift):
//   closed -> the full collapsed-summary row (division name in its tier
//             colour, a faint leader/progress line, a chevron)
//   open   -> a small "Hide" chip that overlaps the card header strip
//             instead of a second full-width band repeating the header
export function CollapsibleDivision({
  divisionId,
  defaultOpenOnPhone,
  divisionName,
  tierRarity,
  isOwnDivision,
  summary,
  children,
}: {
  // Stable id used as the sessionStorage key so back/reload restores what
  // the player expanded instead of always falling back to the default.
  divisionId: string;
  defaultOpenOnPhone: boolean;
  divisionName: string;
  // 0-3, see lib/tier-colors.ts' rarityIndex -- colours the collapsed name.
  tierRarity: number;
  // The viewer's own division gets gold instead of its tier colour, same
  // "gold = you" convention as the rest of v2 (see YourDivisionCard).
  isOwnDivision: boolean;
  // Faint one-line meta, e.g. "Birb leads . 2/10" or "none played" --
  // see lib/standings-cards-core.ts' divisionSummaryLine.
  summary: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const phone = window.matchMedia(PHONE_QUERY).matches;
    const stored = phone ? readStoredOpen(divisionId) : null;
    setOpen(phone ? stored ?? defaultOpenOnPhone : true);
    setReady(true);
  }, [defaultOpenOnPhone, divisionId]);

  function toggle(): void {
    setOpen((o) => {
      const next = !o;
      if (window.matchMedia(PHONE_QUERY).matches) {
        writeStoredOpen(divisionId, next);
      }
      return next;
    });
  }

  return (
    <div
      className="division-details-v2"
      data-open={open ? "1" : "0"}
      data-ready={ready ? "1" : "0"}
      data-phone-default={defaultOpenOnPhone ? "open" : "closed"}
    >
      <button
        type="button"
        className="division-summary-v2"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="division-summary-collapsed">
          <span
            className="division-summary-name pixel"
            data-rarity={isOwnDivision ? undefined : tierRarity}
            data-own={isOwnDivision ? "1" : undefined}
          >
            {divisionName}
          </span>
          <span className="division-summary-meta">{summary}</span>
          <svg className="division-summary-chevron" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="division-summary-expanded">Hide</span>
      </button>
      <div className="division-body-v2">{children}</div>
    </div>
  );
}
