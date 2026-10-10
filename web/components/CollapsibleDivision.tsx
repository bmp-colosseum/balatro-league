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
export function CollapsibleDivision({
  defaultOpenOnPhone,
  summary,
  children,
}: {
  defaultOpenOnPhone: boolean;
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
        <span className="division-summary-text">{summary}</span>
        <span className="division-summary-hide">Hide</span>
      </button>
      <div className="division-body-v2">{children}</div>
    </div>
  );
}
