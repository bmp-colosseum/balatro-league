// Secondary nav strip shown on /admin/* pages. Five top-level groups plus
// System (Inbox, Matches, Messages, Season tools, Settings, System) replace
// the previous flat 29-link / "System" dropdown layout -- see
// .claude/knowledge/ux-audit/01-findings.md, "Admin: proposed information
// architecture". A group (anything with `children` in nav-links.ts) renders
// as a disclosure exactly like the old "System" dropdown did; a link with
// no `children` renders as a plain nav link (Inbox, Season
// tools). Link definitions come from the shared nav-links module so the
// admin nav, public nav, and ⌘K palette never drift. Async so it can hide
// devOps-only links from non-DevOps users.

import Link from "next/link";
import { auth } from "@/auth";
import { hasDevOpsBinding } from "@/lib/admin";
import { ADMIN_LINKS, type AdminNavLink } from "@/lib/nav-links";
import { unreadDmCount } from "@/lib/loaders/dms";
import { AdminMobileMenu } from "@/components/AdminMobileMenu";

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
  (isActive ? "bg-[var(--bg)] text-[var(--accent-2-text)]" : "text-[var(--muted)] hover:text-foreground");

function DmBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="ml-1.5 inline-flex items-center justify-center rounded-full px-1.5 text-[10px] font-semibold leading-4 text-white"
      style={{ background: "var(--danger)" }}
    >
      {count}
    </span>
  );
}

// One desktop group dropdown (Matches, Settings, System, ...), modeled
// exactly on the original "System" dropdown's <details>/<summary> markup --
// no new disclosure component, per the "reuse that mechanism" instruction.
function GroupDropdown({
  group,
  visibleChildren,
  isActive,
  groupActive,
  unreadDms,
  className = "",
}: {
  group: AdminNavLink;
  visibleChildren: AdminNavLink[];
  isActive: (l: AdminNavLink) => boolean;
  groupActive: boolean;
  unreadDms: number;
  className?: string;
}) {
  if (visibleChildren.length === 0) return null;
  return (
    <details className={"relative " + className}>
      <summary className={"list-none cursor-pointer select-none " + linkClass(groupActive)}>
        {group.label} ▾
      </summary>
      <div className="absolute right-0 top-[calc(100%+6px)] z-50 min-w-[180px] rounded-md border border-border bg-card p-1 shadow-lg">
        {visibleChildren.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={
              "block rounded px-2 py-1.5 text-[13px] " +
              (isActive(link) ? "bg-secondary text-[var(--accent-2-text)]" : "text-foreground hover:bg-secondary")
            }
          >
            {link.label}
            {link.href === "/admin/messages" && <DmBadge count={unreadDms} />}
          </Link>
        ))}
      </div>
    </details>
  );
}

export async function AdminNav({ activePath }: { activePath: string }) {
  const [showDevOps, unreadDms] = await Promise.all([canSeeDevOpsLinks(), unreadDmCount()]);
  const visible = (l: AdminNavLink) => !l.devOpsOnly || showDevOps;
  const isActive = (l: AdminNavLink) => (l.exact ? activePath === l.href : activePath.startsWith(l.href));
  const isGroupActive = (l: AdminNavLink) =>
    isActive(l) || (l.children ?? []).some((c) => visible(c) && isActive(c));

  const mainLinks = ADMIN_LINKS.filter((l) => !l.system);
  const systemGroup = ADMIN_LINKS.find((l) => l.system) ?? null;

  // Plain data for AdminMobileMenu (a client component) -- isActive/visible
  // themselves are functions and can't cross the server/client boundary.
  const toMobileGroup = (l: AdminNavLink) => ({
    ...l,
    active: isGroupActive(l),
    children: (l.children ?? []).filter(visible).map((c) => ({ ...c, active: isActive(c) })),
  });
  const mobileMainGroups = mainLinks.filter(visible).map(toMobileGroup);
  const mobileSystemGroup = systemGroup && visible(systemGroup) ? toMobileGroup(systemGroup) : null;

  return (
    <div className="border-b border-border bg-secondary px-4 py-2 md:px-6">
      {/* Phone-only: every admin link (every group's children + plain
          links), nothing hidden -- see AdminMobileMenu's doc comment.
          Desktop (sm+) keeps the row below. */}
      <div className="mx-auto flex max-w-[1100px] sm:hidden">
        <AdminMobileMenu mainGroups={mobileMainGroups} systemGroup={mobileSystemGroup} unreadDms={unreadDms} />
      </div>
      <nav className="pixel mx-auto hidden max-w-[1100px] flex-wrap items-center gap-2 sm:flex md:gap-3">
        {mainLinks.map((link) =>
          link.children ? (
            <GroupDropdown
              key={link.href}
              group={link}
              visibleChildren={link.children.filter(visible)}
              isActive={isActive}
              groupActive={isGroupActive(link)}
              unreadDms={unreadDms}
            />
          ) : visible(link) ? (
            <Link key={link.href} href={link.href} className={linkClass(isActive(link))}>
              {link.label}
              {link.href === "/admin/messages" && <DmBadge count={unreadDms} />}
            </Link>
          ) : null,
        )}
        {systemGroup && (
          <GroupDropdown
            key={systemGroup.href}
            group={systemGroup}
            visibleChildren={systemGroup.children?.filter(visible) ?? []}
            isActive={isActive}
            groupActive={isGroupActive(systemGroup)}
            unreadDms={unreadDms}
            className="ml-auto"
          />
        )}
      </nav>
    </div>
  );
}
