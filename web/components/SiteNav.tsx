// Shared site nav. Server component — reads session + admin tier from helpers.

import Link from "next/link";
import { auth } from "@/auth";
import { isAdminUser } from "@/lib/admin";
import { getShowBmpMmr } from "@/lib/preferences";
import { toggleShowBmpMmr } from "@/app/preferences/actions";

const PUBLIC_LINKS = [
  { href: "/standings", label: "Standings" },
  { href: "/players", label: "Players" },
  { href: "/stats", label: "Stats" },
  { href: "/traits", label: "Traits" },
  { href: "/seasons", label: "Past seasons" },
  { href: "/join", label: "Join" },
] as const;

export async function SiteNav({ activePath }: { activePath: string }) {
  const session = await auth();
  const isLoggedIn = !!session?.user;
  const user = session?.user as { name?: string | null } | undefined;
  const isAdmin = isLoggedIn ? await isAdminUser() : false;
  const showingBmpMmr = await getShowBmpMmr();

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
        <details style={{ position: "relative" }}>
          <summary
            title="Settings"
            aria-label="Settings"
            style={{
              listStyle: "none",
              cursor: "pointer",
              fontSize: 18,
              lineHeight: 1,
              userSelect: "none",
            }}
          >
            ⚙️
          </summary>
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              right: 0,
              minWidth: 220,
              background: "var(--surface, #1a1a1a)",
              border: "1px solid var(--border, #333)",
              borderRadius: 6,
              padding: 8,
              boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
              zIndex: 50,
            }}
          >
            <form action={toggleShowBmpMmr}>
              <input type="hidden" name="next" value={showingBmpMmr ? "0" : "1"} />
              <input type="hidden" name="returnTo" value={activePath || "/"} />
              <button
                type="submit"
                style={{
                  background: "none",
                  border: "none",
                  padding: "6px 4px",
                  fontSize: 13,
                  cursor: "pointer",
                  color: "var(--text)",
                  width: "100%",
                  textAlign: "left",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 14 }}>{showingBmpMmr ? "☑" : "☐"}</span>
                <span>Show BMP MMR</span>
              </button>
            </form>
          </div>
        </details>
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
