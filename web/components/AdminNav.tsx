// Secondary nav strip shown on /admin/* pages.

import Link from "next/link";

interface AdminLink {
  href: string;
  label: string;
  exact?: boolean;
}
const ADMIN_LINKS: AdminLink[] = [
  { href: "/admin", label: "Dashboard", exact: true },
  { href: "/admin/seasons", label: "Seasons" },
  { href: "/admin/players", label: "Players" },
  { href: "/admin/rankings", label: "Rankings" },
  { href: "/admin/divisions", label: "Divisions" },
  { href: "/admin/deck-bans", label: "Deck Bans" },
  { href: "/admin/settings", label: "Settings" },
];

export function AdminNav({ activePath }: { activePath: string }) {
  return (
    <div className="subnav">
      <div className="subnav-inner">
        <nav>
          {ADMIN_LINKS.map((link) => {
            const isActive = link.exact
              ? activePath === link.href
              : activePath.startsWith(link.href);
            return (
              <Link key={link.href} href={link.href} className={isActive ? "active" : ""}>
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
