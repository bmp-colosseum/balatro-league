"use client";

// Phone-only version of the admin sub-nav (sm:hidden trigger; AdminNav keeps
// its desktop row -- plain links inline + per-group dropdowns -- unchanged
// above 640px). Every admin link is folded in here, nothing hidden: MJ was
// explicit every admin page is necessary, so each group's children are
// listed flat under a label header rather than a second nested disclosure
// inside an already-phone popover, which would just add taps for no benefit
// on a touch surface.
import Link from "next/link";
import { Menu as MenuIcon } from "lucide-react";
import { Menu, MenuTrigger, MenuContent, MenuLinkItem, MenuSeparator } from "@/components/ui/menu";
import type { AdminNavLink } from "@/lib/nav-links";

// Active state is computed server-side (AdminNav already has `isActive`) and
// passed as a plain `active` flag per link -- a function prop can't cross the
// server/client boundary (this is a client component for the Base UI menu
// interactivity), only plain serializable data and "use server" actions can.
// `Omit<..., "children">` drops AdminNavLink's own (untyped-for-mobile)
// `children?: AdminNavLink[]` field before re-adding it below -- otherwise
// the two conflicting `children` types intersect instead of the narrower
// one winning, and child links lose their `active` flag under inference.
export type AdminMobileNavLink = Omit<AdminNavLink, "children"> & { active: boolean };
export type AdminMobileNavGroup = AdminMobileNavLink & { children: AdminMobileNavLink[] };

export interface AdminMobileMenuProps {
  mainGroups: AdminMobileNavGroup[];
  systemGroup: AdminMobileNavGroup | null;
  unreadDms: number;
}

const triggerClass =
  "flex min-h-11 items-center gap-1.5 rounded px-2 py-1 border-none bg-transparent text-[var(--muted)] transition-colors hover:text-foreground sm:hidden";

const rowClass = "min-h-11";

function GroupRows({ group, unreadDms }: { group: AdminMobileNavGroup; unreadDms: number }) {
  if (group.children.length > 0) {
    return (
      <div>
        <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
          {group.label}
        </div>
        {group.children.map((link) => (
          <MenuLinkItem
            key={link.href}
            closeOnClick
            className={rowClass + (link.active ? " bg-secondary text-[var(--accent-2-text)]" : "")}
            render={<Link href={link.href} />}
          >
            {link.label}
            {link.href === "/admin/messages" && unreadDms > 0 && (
              <span
                className="ml-1.5 inline-flex items-center justify-center rounded-full px-1.5 text-[10px] font-semibold leading-4 text-white"
                style={{ background: "var(--danger)" }}
              >
                {unreadDms}
              </span>
            )}
          </MenuLinkItem>
        ))}
      </div>
    );
  }
  return (
    <MenuLinkItem
      closeOnClick
      className={rowClass + (group.active ? " bg-secondary text-[var(--accent-2-text)]" : "")}
      render={<Link href={group.href} />}
    >
      {group.label}
    </MenuLinkItem>
  );
}

export function AdminMobileMenu({ mainGroups, systemGroup, unreadDms }: AdminMobileMenuProps) {
  return (
    <Menu>
      <MenuTrigger className={triggerClass}>
        <MenuIcon className="size-4" />
        <span className="text-sm">Admin menu</span>
      </MenuTrigger>
      <MenuContent align="start">
        {mainGroups.map((group, i) => (
          <div key={group.href}>
            {i > 0 && <MenuSeparator />}
            <GroupRows group={group} unreadDms={unreadDms} />
          </div>
        ))}
        {systemGroup && systemGroup.children.length > 0 && (
          <div>
            <MenuSeparator />
            <GroupRows group={systemGroup} unreadDms={unreadDms} />
          </div>
        )}
      </MenuContent>
    </Menu>
  );
}
