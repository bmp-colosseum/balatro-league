"use client";

// Phone-only nav+settings+account menu (sm:hidden on its own trigger -- desktop
// never mounts this at all, it keeps the inline links + gear <details> SiteNav
// already had). Below 640px there isn't room for the 7 primary links, the
// settings gear dropdown, AND the account control on one row (the header used
// to wrap into three bands -- logo, then the links, then search/settings/
// login), so all three fold into this single labelled "Menu" trigger instead,
// same pattern as the Tour site's components/MoreMenu.tsx.
//
// The settings rows dispatch the same server actions the desktop gear menu
// uses (toggleShowBmpMmr etc.) -- passed down as props since this is a client
// component and those actions are defined with "use server" in
// app/preferences/actions.ts; a <form action={...}> works the same here as it
// does in the server-rendered gear <details>.
import Link from "next/link";
import { Menu as MenuIcon, LogIn, LogOut } from "lucide-react";
import { Menu, MenuTrigger, MenuContent, MenuItem, MenuLinkItem, MenuSeparator } from "@/components/ui/menu";
import type { NavLink } from "@/lib/nav-links";

export interface SiteMobileMenuProps {
  links: NavLink[];
  activePath: string;
  showingBmpMmr: boolean;
  showingUsernames: boolean;
  showingDiscordIds: boolean;
  // Discord-username toggle is members-only (verified guild members); Discord-id
  // toggle is admin-only -- mirrors SiteNav's own gating for the desktop gear menu.
  inGuild: boolean;
  isAdmin: boolean;
  isLoggedIn: boolean;
  userName: string | null;
  toggleShowBmpMmr: (formData: FormData) => void | Promise<void>;
  toggleShowUsernames: (formData: FormData) => void | Promise<void>;
  toggleShowDiscordIds: (formData: FormData) => void | Promise<void>;
}

// Real tap target (44px) on a trigger that's icon + visible label -- a bare
// hamburger glyph reads as decoration, not a control, the same reasoning that
// drove Tour's MoreMenu away from an unlabelled "...".
const triggerClass =
  "flex min-h-11 items-center gap-1.5 rounded px-2 py-1 border-none bg-transparent text-[var(--muted)] transition-colors hover:text-foreground sm:hidden";

// Every row gets its own 44px floor -- components/ui/menu.tsx's shared
// MenuItem/MenuLinkItem styling only budgets ~32px (text-sm + py-1.5), fine for
// the mouse-driven desktop dropdowns (AdminNav's "System" dropdown) that reuse the
// same primitives, not fine for a touch popover.
const rowClass = "min-h-11";

export function SiteMobileMenu({
  links,
  activePath,
  showingBmpMmr,
  showingUsernames,
  showingDiscordIds,
  inGuild,
  isAdmin,
  isLoggedIn,
  userName,
  toggleShowBmpMmr,
  toggleShowUsernames,
  toggleShowDiscordIds,
}: SiteMobileMenuProps) {
  return (
    <Menu>
      <MenuTrigger className={triggerClass}>
        <MenuIcon className="size-4" />
        <span className="text-sm">Menu</span>
      </MenuTrigger>
      <MenuContent align="end">
        {links.map((link) => {
          const isActive = link.href === "/admin" ? activePath.startsWith("/admin") : link.href === activePath;
          return (
            <MenuLinkItem
              key={link.href}
              closeOnClick
              className={rowClass + (isActive ? " bg-secondary text-foreground" : "")}
              render={<Link href={link.href} />}
            >
              {link.label}
            </MenuLinkItem>
          );
        })}

        <MenuSeparator />

        {/* Settings toggles: the form wraps the MenuItem (rendered as its submit
            button via `render`) rather than the other way around -- a MenuItem
            wrapping a nested <button> would double up interactive elements and
            break the popover's own keyboard activation path. Same shape as the
            Tour site's MoreMenu sign-out row. */}
        <form action={toggleShowBmpMmr}>
          <input type="hidden" name="next" value={showingBmpMmr ? "0" : "1"} />
          <input type="hidden" name="returnTo" value={activePath || "/"} />
          <MenuItem className={rowClass} nativeButton render={<button type="submit" />}>
            <span className="text-sm">{showingBmpMmr ? "[x]" : "[ ]"}</span>
            <span>Show BMP MMR</span>
          </MenuItem>
        </form>
        {inGuild && (
          <form action={toggleShowUsernames}>
            <input type="hidden" name="next" value={showingUsernames ? "0" : "1"} />
            <input type="hidden" name="returnTo" value={activePath || "/"} />
            <MenuItem className={rowClass} nativeButton render={<button type="submit" />}>
              <span className="text-sm">{showingUsernames ? "[x]" : "[ ]"}</span>
              <span>Show Discord usernames</span>
            </MenuItem>
          </form>
        )}
        {isAdmin && (
          <form action={toggleShowDiscordIds}>
            <input type="hidden" name="next" value={showingDiscordIds ? "0" : "1"} />
            <input type="hidden" name="returnTo" value={activePath || "/"} />
            <MenuItem className={rowClass} nativeButton render={<button type="submit" />}>
              <span className="text-sm">{showingDiscordIds ? "[x]" : "[ ]"}</span>
              <span>Show Discord IDs (admin)</span>
            </MenuItem>
          </form>
        )}

        <MenuSeparator />

        {isLoggedIn ? (
          <MenuLinkItem closeOnClick className={rowClass} render={<Link href="/api/auth/signout" />}>
            <LogOut className="size-4" /> Logout {userName ? `(${userName})` : ""}
          </MenuLinkItem>
        ) : (
          <MenuLinkItem closeOnClick className={rowClass} render={<Link href="/auth/signin" />}>
            <LogIn className="size-4" /> Login with Discord
          </MenuLinkItem>
        )}
      </MenuContent>
    </Menu>
  );
}
