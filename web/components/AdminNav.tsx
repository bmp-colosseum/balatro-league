// Secondary nav strip shown on /admin/* pages.
// Async so it can hide the "Rules" link from non-DevOps users.

import Link from "next/link";
import { auth } from "@/auth";
import { hasDevOpsBinding } from "@/lib/admin";

interface AdminLink {
  href: string;
  label: string;
  exact?: boolean;
  devOpsOnly?: boolean;
}
const ADMIN_LINKS: AdminLink[] = [
  { href: "/admin", label: "Dashboard", exact: true },
  { href: "/admin/seasons", label: "Seasons" },
  { href: "/admin/players", label: "Players" },
  { href: "/admin/divisions", label: "Divisions" },
  { href: "/admin/results", label: "Results" },
  { href: "/admin/deck-bans", label: "Deck Bans" },
  { href: "/admin/traits", label: "Traits" },
  { href: "/admin/disputes", label: "Disputes" },
  { href: "/admin/settings", label: "Rules", devOpsOnly: true },
  { href: "/admin/config", label: "Config" },
  { href: "/admin/ops", label: "Ops", devOpsOnly: true },
  { href: "/admin/audit", label: "Audit" },
];

async function canSeeDevOpsLinks(): Promise<boolean> {
  const session = await auth();
  const user = session?.user as { discordId?: string } | undefined;
  const isOwner =
    !!process.env.LEAGUE_OWNER_DISCORD_ID &&
    user?.discordId === process.env.LEAGUE_OWNER_DISCORD_ID;
  if (isOwner) return true;
  return hasDevOpsBinding();
}

export async function AdminNav({ activePath }: { activePath: string }) {
  const showDevOps = await canSeeDevOpsLinks();
  return (
    <div className="border-b border-border bg-secondary px-4 py-2 md:px-6">
      <nav className="mx-auto flex max-w-[1100px] flex-wrap gap-2 md:gap-3">
        {ADMIN_LINKS.filter((l) => !l.devOpsOnly || showDevOps).map((link) => {
          const isActive = link.exact
            ? activePath === link.href
            : activePath.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={
                "rounded px-2.5 py-1 text-[13px] transition-colors " +
                (isActive
                  ? "bg-[var(--bg)] text-[var(--accent-2)]"
                  : "text-[var(--muted)] hover:text-foreground")
              }
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
