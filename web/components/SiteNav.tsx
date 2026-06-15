// Shared site nav. Server component — reads session + admin tier from helpers.
// Tailwind utilities for layout (wraps on mobile); the settings menu stays a
// native <details> for zero-JS accessibility.

import Link from "next/link";
import { auth } from "@/auth";
import { isAdminUser } from "@/lib/admin";
import { getShowBmpMmr, getShowUsernames } from "@/lib/preferences";
import { toggleShowBmpMmr, toggleShowUsernames } from "@/app/preferences/actions";
import { CommandButton } from "@/components/CommandButton";

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
  const showingUsernames = await getShowUsernames();

  const links: { href: string; label: string }[] = [...PUBLIC_LINKS];
  if (isLoggedIn) {
    links.push({ href: "/report", label: "Report match" });
    links.push({ href: "/me", label: "My profile" });
  }
  if (isAdmin) links.push({ href: "/admin", label: "Admin" });

  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-2.5 md:gap-6 md:px-6 md:py-3">
      <h1 className="m-0 text-base">
        <Link href="/" className="text-foreground no-underline hover:opacity-80">🃏 Balatro League</Link>
      </h1>
      <nav className="pixel flex flex-wrap gap-1 md:gap-2 text-[13px]">
        {links.map((link) => {
          const isActive =
            link.href === "/admin" ? activePath.startsWith("/admin") : link.href === activePath;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={
                "rounded px-2 py-1 transition-colors " +
                (isActive
                  ? "bg-secondary text-foreground"
                  : "text-[var(--muted)] hover:text-foreground")
              }
            >
              {link.label}
            </Link>
          );
        })}
      </nav>

      <span className="ml-auto flex items-center gap-3">
        <CommandButton />
        <details className="relative">
          <summary
            title="Settings"
            aria-label="Settings"
            className="cursor-pointer list-none text-lg leading-none select-none"
          >
            ⚙️
          </summary>
          <div className="absolute right-0 top-[calc(100%+6px)] z-50 min-w-[220px] rounded-md border border-border bg-card p-2 shadow-lg">
            <form action={toggleShowBmpMmr}>
              <input type="hidden" name="next" value={showingBmpMmr ? "0" : "1"} />
              <input type="hidden" name="returnTo" value={activePath || "/"} />
              <button
                type="submit"
                className="flex w-full cursor-pointer items-center gap-2 rounded border-none bg-transparent px-1 py-1.5 text-left text-[13px] text-foreground hover:bg-secondary"
              >
                <span className="text-sm">{showingBmpMmr ? "☑" : "☐"}</span>
                <span>Show BMP MMR</span>
              </button>
            </form>
            <form action={toggleShowUsernames}>
              <input type="hidden" name="next" value={showingUsernames ? "0" : "1"} />
              <input type="hidden" name="returnTo" value={activePath || "/"} />
              <button
                type="submit"
                className="flex w-full cursor-pointer items-center gap-2 rounded border-none bg-transparent px-1 py-1.5 text-left text-[13px] text-foreground hover:bg-secondary"
              >
                <span className="text-sm">{showingUsernames ? "☑" : "☐"}</span>
                <span>Show Discord usernames</span>
              </button>
            </form>
          </div>
        </details>

        {isLoggedIn ? (
          <>
            <Link href="/me" className="text-foreground">
              {user?.name ?? "(unknown)"}
            </Link>
            <Link href="/api/auth/signout" className="muted text-xs">
              logout
            </Link>
          </>
        ) : (
          <Link href="/auth/signin" className="muted text-xs">
            Login with Discord
          </Link>
        )}
      </span>
    </header>
  );
}
