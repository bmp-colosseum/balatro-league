// Compact "Ladder" strip for /standings -- the whole league's divisions
// rendered as ONE descending chain (Legendary at the top, down through
// Rare, Uncommon, Common) instead of the parallel-looking groups the
// division cards below might otherwise suggest. Each chip links to that
// division's card further down the page (id="division-<id>", set by
// app/standings/page.tsx). Mostly pure presentation -- ordering, names, and
// neighbors all come from lib/division-ladder.ts' buildLadder -- plus one
// bit of client state: a "Hide ladder" / "Show ladder" chip in the panel
// header that collapses the strip to its one-line header, remembered
// per browser (lib/ladder-visibility-storage.ts, localStorage) so a return
// visit keeps whatever the player last chose. Default is SHOWN.
//
// "use client" (not a server component) purely to own that toggle state --
// same shape as CollapsibleDivision.tsx's open/ready state, including its
// data-ready convention: the server/first-paint render always shows the
// strip (ready="0", hidden="0" -- the default), and only once mounted does
// it switch to whatever's actually stored. That means a return visit with
// "hidden" previously chosen still sees a brief flash of the shown strip
// before the effect below applies the real state -- same accepted
// limitation CollapsibleDivision has for its own non-default case, see its
// header comment. There's no per-row data here that needs the server (no
// auth, no DB), so this costs nothing beyond that one JS bundle.
//
// v2 "Card Table" only, same pattern as every other brand-new block on this
// page (YourDivisionCard, the zone key): off by default, shown only under
// html[data-ui="v2"] (see app/v2/standings-cards.css).

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { LadderRung } from "@/lib/division-ladder";
import { rarityIndex, tierColors } from "@/lib/tier-colors";
import {
  LADDER_HIDDEN_STORAGE_KEY,
  formatStoredLadderHidden,
  parseStoredLadderHidden,
} from "@/lib/ladder-visibility-storage";

// Reads the ladder's remembered show/hide state from localStorage. Returns
// null when nothing is stored yet (first visit this browser), so the
// caller falls back to its own default (shown).
function readStoredHidden(): boolean | null {
  try {
    return parseStoredLadderHidden(window.localStorage.getItem(LADDER_HIDDEN_STORAGE_KEY));
  } catch {
    // Private-mode / storage-disabled browsers: behave as if nothing is stored.
    return null;
  }
}

function writeStoredHidden(hidden: boolean): void {
  try {
    window.localStorage.setItem(LADDER_HIDDEN_STORAGE_KEY, formatStoredLadderHidden(hidden));
  } catch {
    // Ignore write failures (quota, private mode); the toggle still works
    // for this page view, it just won't be remembered.
  }
}

export function LadderStrip({ ladder }: { ladder: LadderRung[] }) {
  const [hidden, setHidden] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setHidden(readStoredHidden() ?? false);
    setReady(true);
  }, []);

  function toggle(): void {
    setHidden((h) => {
      const next = !h;
      writeStoredHidden(next);
      return next;
    });
  }

  return (
    <div className="card ladder-strip-v2" data-hidden={hidden ? "1" : "0"} data-ready={ready ? "1" : "0"}>
      <div className="ladder-strip-header">
        <div className="ladder-strip-title">Ladder</div>
        <button
          type="button"
          className="ladder-strip-toggle"
          aria-expanded={!hidden}
          onClick={toggle}
        >
          {hidden ? "Show ladder" : "Hide ladder"}
        </button>
      </div>
      <div className="ladder-strip-body">
        <div className="ladder-strip-row">
          {ladder.map((rung, i) => {
            const tc = tierColors(rung.tierPosition);
            return (
              <span key={rung.id} className="ladder-strip-item">
                <Link
                  href={`#division-${rung.id}`}
                  className="pill ladder-strip-chip"
                  data-rarity={rarityIndex(rung.tierPosition)}
                  style={{ background: tc.bg, color: tc.fg }}
                  title={`${rung.name} -- rung ${rung.ladderPosition}`}
                >
                  {rung.name}
                </Link>
                {i < ladder.length - 1 && (
                  <svg
                    className="ladder-strip-arrow"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    width={14}
                    height={14}
                  >
                    <path
                      d="M7 10l5 5 5-5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </span>
            );
          })}
        </div>
        <p className="muted ladder-strip-note">
          One ladder: the top of each division promotes into the division above it, the bottom relegates into the one below.
        </p>
      </div>
    </div>
  );
}
