"use client";

// Phone-only version of the admin sub-nav (sm:hidden trigger; AdminNav keeps
// its desktop row -- mainLinks inline + "System" dropdown -- unchanged above 640px).
// Every admin link is folded in here, nothing hidden: MJ was explicit every
// admin page is necessary, so this holds mainLinks AND systemLinks in one
// list rather than re-creating the desktop's main/"System" dropdown split -- a
// second nested disclosure inside an already-phone popover would just add
// taps for no benefit on a touch surface.
import Link from "next/link";
import { Menu as MenuIcon } from "lucide-react";
import { Menu, MenuTrigger, MenuContent, MenuLinkItem, MenuSeparator } from "@/components/ui/menu";
import type { AdminNavLink } from "@/lib/nav-links";

// Active state is computed server-side (AdminNav already has `isActive`) and
// passed as a plain `active` flag per link -- a function prop can't cross the
// server/client boundary (this is a client component for the Base UI menu
// interactivity), only plain serializable data and "use server" actions can.
export type AdminMobileNavLink = AdminNavLink & { active: boolean };

export interface AdminMobileMenuProps {
  mainLinks: AdminMobileNavLink[];
  systemLinks: AdminMobileNavLink[];
  unreadDms: number;
}

const triggerClass =
  "flex min-h-11 items-center gap-1.5 rounded px-2 py-1 border-none bg-transparent text-[var(--muted)] transition-colors hover:text-foreground sm:hidden";

const rowClass = "min-h-11";

export function AdminMobileMenu({ mainLinks, systemLinks, unreadDms }: AdminMobileMenuProps) {
  return (
    <Menu>
      <MenuTrigger className={triggerClass}>
        <MenuIcon className="size-4" />
        <span className="text-sm">Admin menu</span>
      </MenuTrigger>
      <MenuContent align="start">
        {mainLinks.map((link) => (
          <MenuLinkItem
            key={link.href}
            closeOnClick
            className={rowClass + (link.active ? " bg-secondary text-[var(--accent-2-text)]" : "")}
            render={<Link href={link.href} />}
          >
            {link.label}
            {link.href === "/admin/dms" && unreadDms > 0 && (
              <span
                className="ml-1.5 inline-flex items-center justify-center rounded-full px-1.5 text-[10px] font-semibold leading-4 text-white"
                style={{ background: "var(--danger)" }}
              >
                {unreadDms}
              </span>
            )}
          </MenuLinkItem>
        ))}
        {systemLinks.length > 0 && (
          <>
            <MenuSeparator />
            {systemLinks.map((link) => (
              <MenuLinkItem
                key={link.href}
                closeOnClick
                className={rowClass + (link.active ? " bg-secondary text-[var(--accent-2-text)]" : "")}
                render={<Link href={link.href} />}
              >
                {link.label}
              </MenuLinkItem>
            ))}
          </>
        )}
      </MenuContent>
    </Menu>
  );
}
