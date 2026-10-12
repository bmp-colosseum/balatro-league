"use client";

// The brand mark, front-left in the top bar (components/SiteNav.tsx): two CSS card
// chips side by side (League's own chip, raised -- the active product here -- and
// the Tour's pizza chip behind it) plus the wordmark. Clicking/tapping the whole
// cluster opens the two-row League/Tour menu described in design-system/MASTER.md
// and .claude/knowledge/ux-cohesion/01-findings.md section b -- the same two rows
// components/SiteMobileMenu.tsx folds into the phone popover, both built from
// lib/product-switcher-core.ts's plain row data so the two surfaces can never
// disagree about the label/href. Ported from the Tour site's own
// components/ProductSwitcher.tsx with the chips' roles swapped (League is the
// active/raised chip here) and the button reset to plain nav-coloured text
// instead of a filled gold button -- this trigger replaces the old plain
// Link-to-"/" brand mark, so it keeps that mark's look (text-foreground,
// hover:opacity-80), not the global `button` rule's solid fill (globals.css,
// @layer base) that a bare <button> gets by default.
import { Pizza, ChevronDown } from "lucide-react";
import { Menu, MenuTrigger, MenuContent, MenuLinkItem } from "@/components/ui/menu";
import { productSwitcherRows } from "@/lib/product-switcher-core";

export function ProductSwitcher({ activeSeasonName }: { activeSeasonName: string | null }) {
  const rows = productSwitcherRows(activeSeasonName);
  return (
    <Menu>
      <MenuTrigger
        className="brand flex min-h-11 items-center gap-2 border-none bg-transparent p-0 shadow-none rounded-none text-foreground hover:no-underline hover:opacity-80 sm:min-h-0"
        aria-label="Switch between Balatro League and Team Tour"
      >
        <span className="ps-mark" aria-hidden="true">
          <span className="ps-chip ps-chip-paper" />
          <span className="ps-chip ps-chip-pizza">
            <Pizza className="ps-chip-icon" />
          </span>
        </span>
        {/* Text hides below sm -- the mark alone keeps the trigger recognizable and
            tappable while freeing enough width for the season pill, Menu trigger,
            search, and account control to fit one row at 390px. */}
        <span className="hidden sm:inline">Balatro League</span>
        <ChevronDown className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
      </MenuTrigger>
      <MenuContent align="start">
        {rows.map((row) => (
          // A real cross-site navigation (two separate Next.js apps on two
          // subdomains) -- a plain <a>, not next/link's <Link>, which can't route
          // there client-side anyway.
          <MenuLinkItem key={row.key} closeOnClick render={<a href={row.href} />}>
            <span className="flex min-w-0 flex-col">
              <span style={{ fontWeight: row.current ? 700 : 400 }}>{row.label}</span>
              <span className="muted truncate" style={{ fontSize: 12 }}>
                {row.sub}
              </span>
            </span>
          </MenuLinkItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
