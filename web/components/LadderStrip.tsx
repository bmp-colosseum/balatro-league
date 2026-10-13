// Compact "Ladder" strip for /standings -- the whole league's divisions
// rendered as ONE descending chain (Legendary at the top, down through
// Rare, Uncommon, Common) instead of the parallel-looking groups the
// division cards below might otherwise suggest. Each chip links to that
// division's card further down the page (id="division-<id>", set by
// app/standings/page.tsx). Pure presentation -- ordering, names, and
// neighbors all come from lib/division-ladder.ts' buildLadder; this
// component only renders what it's given.
//
// v2 "Card Table" only, same pattern as every other brand-new block on this
// page (YourDivisionCard, the zone key): off by default, shown only under
// html[data-ui="v2"] (see app/v2/standings-cards.css).

import Link from "next/link";
import type { LadderRung } from "@/lib/division-ladder";
import { rarityIndex, tierColors } from "@/lib/tier-colors";

export function LadderStrip({ ladder }: { ladder: LadderRung[] }) {
  return (
    <div className="card ladder-strip-v2">
      <div className="ladder-strip-title">Ladder</div>
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
  );
}
