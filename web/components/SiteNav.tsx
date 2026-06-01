// Shared site nav. Server component — reads session + admin tier from helpers.

import Link from "next/link";
import { auth } from "@/auth";
import { isAdminUser } from "@/lib/admin";

const PUBLIC_LINKS = [
  { href: "/standings", label: "Standings" },
  { href: "/players", label: "Players" },
  { href: "/seasons", label: "Past seasons" },
] as const;

export async function SiteNav({ activePath }: { activePath: string }) {
  const session = await auth();
  const isLoggedIn = !!session?.user;
  const user = session?.user as { name?: string | null } | undefined;
  const isAdmin = isLoggedIn ? await isAdminUser() : false;

  const links: { href: string; label: string }[] = [...PUBLIC_LINKS];
  if (isLoggedIn) {
    links.push({ href: "/report", label: "Report match" });
    links.push({ href: "/me", label: "My profile" });
  }
  if (isAdmin) links.push({ href: "/admin", label: "Admin" });

  return (
    <header className="site-nav">
      <h1>🃏 Balatro League</h1>
      <nav>
        {links.map((link) => {
          const isActive =
            link.href === "/admin"
              ? activePath.startsWith("/admin")
              : link.href === activePath;
          return (
            <Link key={link.href} href={link.href} className={isActive ? "active" : ""}>
              {link.label}
            </Link>
          );
        })}
      </nav>
      <span style={{ marginLeft: "auto", display: "flex", gap: 12, alignItems: "center" }}>
        <Link
          href="/settings"
          title="Settings"
          aria-label="Settings"
          className={activePath === "/settings" ? "active" : ""}
          style={{ fontSize: 18, lineHeight: 1, textDecoration: "none" }}
        >
          ⚙️
        </Link>
        {isLoggedIn ? (
          <>
            <Link href="/me" style={{ color: "var(--text)" }}>
              {user?.name ?? "(unknown)"}
            </Link>
            <Link href="/api/auth/signout" className="muted" style={{ fontSize: 12 }}>
              logout
            </Link>
          </>
        ) : (
          <Link href="/auth/signin" className="muted" style={{ fontSize: 12 }}>
            Login with Discord
          </Link>
        )}
      </span>
    </header>
  );
}
