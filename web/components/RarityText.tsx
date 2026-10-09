import type { ReactNode } from "react";
import { rarityIndex } from "@/lib/tier-colors";

// Colors a tier/division name by its tier's rarity everywhere it appears as
// plain text (standings, profiles, admin tables, etc). Server component, no
// client JS -- just a span with a data-rarity hook that the v2 "Card Table"
// stylesheet (app/v2/rarity-text.css) maps onto the Balatro rarity colors.
// Under v1 (no html[data-ui="v2"]) the span is unstyled, so nothing changes
// there. See the matching data-rarity convention on .pill, .division-name,
// and .tier-heading in globals.css.
export function RarityText({
  position,
  as: As = "span",
  className,
  children,
}: {
  position: number;
  as?: "span" | "strong" | "td" | "div";
  className?: string;
  children: ReactNode;
}): ReactNode {
  const classes = className ? `rarity-text ${className}` : "rarity-text";
  return (
    <As className={classes} data-rarity={rarityIndex(position)}>
      {children}
    </As>
  );
}
