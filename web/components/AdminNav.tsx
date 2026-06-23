// Secondary nav strip shown on /admin/* pages. High-frequency links sit in the
// always-visible row; rarely-touched settings/devops tools live behind a
// "System ▾" menu. Link definitions come from the shared nav-links module so the
// admin nav, public nav, and ⌘K palette never drift. Async so it can hide
// devOps-only links from non-DevOps users.

import Link from "next/link";
import { auth } from "@/auth";
import { hasDevOpsBinding } from "@/lib/admin";
import { ADMIN_LINKS, type AdminNavLink } from "@/lib/nav-links";

async function canSeeDevOpsLinks(): Promise<boolean> {
  const session = await auth();
  const user = session?.user as { discordId?: string } | undefined;
  const isOwner =
    !!process.env.LEAGUE_OWNER_DISCORD_ID &&
    user?.discordId === process.env.LEAGUE_OWNER_DISCORD_ID;
  if (isOwner) return true;
  return hasDevOpsBinding();
}

const linkClass = (isActive: boolean) =>
  "rounded px-2.5 py-1 text-[13px] transition-colors " +
  (isActive ? "bg-[var(--bg)] text-[var(--accent-2)]" : "text-[var(--muted)] hover:text-foreground");

export async function AdminNav({ activePath }: { activePath: string }) {
  const showDevOps = await canSeeDevOpsLinks();
  const visible = (l: AdminNavLink) => !l.devOpsOnly || showDevOps;
  const isActive = (l: AdminNavLink) => (l.exact ? activePath === l.href : activePath.startsWith(l.href));
  const mainLinks = ADMIN_LINKS.filter((l) => !l.system && visible(l));
  const systemLinks = ADMIN_LINKS.filter((l) => l.system && visible(l));
  const systemActive = systemLinks.some(isActive);

  return (
    <div className="border-b border-border bg-secondary px-4 py-2 md:px-6">
      <nav className="pixel mx-auto flex max-w-[1100px] flex-wrap items-center gap-2 md:gap-3">
        {mainLinks.map((link) => (
          <Link key={link.href} href={link.href} className={linkClass(isActive(link))}>
            {link.label}
          </Link>
        ))}
        {systemLinks.length > 0 && (
          <details className="relative ml-auto">
            <summary className={"list-none cursor-pointer select-none " + linkClass(systemActive)}>
              System ▾
            </summary>
            <div className="absolute right-0 top-[calc(100%+6px)] z-50 min-w-[180px] rounded-md border border-border bg-card p-1 shadow-lg">
              {systemLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={
                    "block rounded px-2 py-1.5 text-[13px] " +
                    (isActive(link)
                      ? "bg-secondary text-[var(--accent-2)]"
                      : "text-foreground hover:bg-secondary")
                  }
                >
                  {link.label}
                </Link>
              ))}
            </div>
          </details>
        )}
      </nav>
    </div>
  );
}
