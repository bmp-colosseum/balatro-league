// Pure core for the shared-shell product switcher (components/ProductSwitcher.tsx,
// folded into components/SiteMobileMenu.tsx on phone) -- the two-row menu that lets a
// visitor jump between Balatro League and Pizza Power Team Tour. See
// design-system/MASTER.md and .claude/knowledge/ux-cohesion/01-findings.md section b.
// Ported from the Tour site's own lib/product-switcher-core.ts -- same shape, with
// the rows' roles swapped: THIS app is the League, so the League row is always the
// current one and the Tour row never fabricates a live stat it has no access to.
//
// Zero-import, no react/next -- callers render this plain data in their own shell.
// Each product's URL is a real cross-site navigation (two separate Next.js apps on
// two subdomains, not client-side routes), so a plain <a>, not next/link's <Link>,
// is the right element at the call site.

export interface ProductSwitcherRow {
  key: "league" | "tour";
  label: string;
  /** Short descriptive line under the label -- never fabricated per-season stats
   *  for the OTHER product (this app has no access to the Tour's live data), so
   *  the Tour row stays a stable, true-on-any-day description. */
  sub: string;
  /** Stable one-line pitch for what the product IS, independent of season state --
   *  the menu's rendered second line (components/ProductSwitcher.tsx,
   *  components/SiteMobileMenu.tsx). Distinct from `sub`, which carries the
   *  current-row's live "Now viewing <season>" status when one is known; that
   *  status is already surfaced elsewhere (the header's own season pill), so the
   *  switcher's second line is free to always show this stable description instead. */
  description: string;
  href: string;
  /** This app IS this product -- the switcher highlights it instead of describing
   *  "the active season" (which only this app knows) for the OTHER product. */
  current: boolean;
}

const LEAGUE_URL = "https://balatroleague.com";
const TOUR_URL = "https://tour.balatroleague.com";

const LEAGUE_DESCRIPTION = "Individual player league. Divisions, promotion and relegation, every season.";
const TOUR_DESCRIPTION = "Balatro team tournament. Draft a roster, play weekly matchups, make the playoffs.";

/**
 * Builds the switcher's two rows, League always first. `activeSeasonName` is
 * the League's own active season label (already resolved server-side, e.g.
 * components/SiteNav.tsx's loadActiveSeasonSummary()) -- null when no season
 * is marked active yet.
 */
export function productSwitcherRows(activeSeasonName: string | null): ProductSwitcherRow[] {
  return [
    {
      key: "league",
      label: "Balatro League",
      sub: activeSeasonName ? `Now viewing ${activeSeasonName}` : "Standings, divisions and seasons",
      description: LEAGUE_DESCRIPTION,
      href: LEAGUE_URL,
      current: true,
    },
    {
      key: "tour",
      label: "Team Tour",
      sub: "Team standings and brackets",
      description: TOUR_DESCRIPTION,
      href: TOUR_URL,
      current: false,
    },
  ];
}
