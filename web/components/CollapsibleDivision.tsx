"use client";

import { useEffect, useState, type ReactNode } from "react";

const PHONE_QUERY = "(max-width: 640px)";

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
  defaultOpenOnPhone,
  divisionName,
  tierRarity,
  isOwnDivision,
  summary,
  children,
}: {
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
    setOpen(phone ? defaultOpenOnPhone : true);
    setReady(true);
  }, [defaultOpenOnPhone]);

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
        onClick={() => setOpen((o) => !o)}
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
