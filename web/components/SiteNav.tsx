// Shared site nav. Server component — reads the session and shows login/logout.

import Link from "next/link";
import { auth } from "@/auth";

const PUBLIC_LINKS = [
  { href: "/standings", label: "Standings" },
  { href: "/players", label: "Players" },
  { href: "/seasons", label: "Past seasons" },
] as const;

const PLAYER_LINKS = [{ href: "/me", label: "My profile" }] as const;

export async function SiteNav({ activePath }: { activePath: string }) {
  const session = await auth();
  const isLoggedIn = !!session?.user;
  const user = session?.user as { name?: string | null } | undefined;

  const links = [...PUBLIC_LINKS, ...(isLoggedIn ? PLAYER_LINKS : [])];

  return (
    <header className="site-nav">
      <h1>🃏 Balatro League</h1>
      <nav>
        {links.map((link) => {
          const isActive = link.href === activePath;
          return (
            <Link key={link.href} href={link.href} className={isActive ? "active" : ""}>
              {link.label}
            </Link>
          );
        })}
      </nav>
      <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
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
