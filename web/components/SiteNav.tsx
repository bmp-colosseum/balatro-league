// Shared site nav. Server component — reads session + admin tier from helpers.
// Desktop (sm and up) keeps the inline links + a native <details> settings
// menu, zero-JS. Below 640px there isn't room for the 7 links, the gear
// dropdown, AND the account control on one line -- it used to wrap into three
// rows (logo, then the links, then search/settings/login). Below sm, SiteNav
// renders one row instead: logo, a labelled "Menu" trigger (SiteMobileMenu)
// holding the links + settings rows, search, then sign-in/account -- same
// shape as the Tour site's MoreMenu split.

import Link from "next/link";
import Image from "next/image";
import { auth } from "@/auth";
import { isAdminUser } from "@/lib/admin";
import { getShowBmpMmr, getShowUsernames, getShowDiscordIds } from "@/lib/preferences";
import { toggleShowBmpMmr, toggleShowUsernames, toggleShowDiscordIds } from "@/app/preferences/actions";
import { loadOpenSignupRoundId } from "@/lib/loaders/join";
import { CommandButton } from "@/components/CommandButton";
import { Button } from "@/components/ui/button";
import { SiteMobileMenu } from "@/components/SiteMobileMenu";
import { PRIMARY_LINKS } from "@/lib/nav-links";

export async function SiteNav({ activePath }: { activePath: string }) {
  const session = await auth();
  const isLoggedIn = !!session?.user;
  const user = session?.user as { name?: string | null } | undefined;
  const isAdmin = isLoggedIn ? await isAdminUser() : false;
  const showingBmpMmr = await getShowBmpMmr();
  const showingUsernames = await getShowUsernames();
  const showingDiscordIds = isAdmin ? await getShowDiscordIds() : false;
  // @username display is members-only — only offer the toggle to verified members.
  const inGuild = (session?.user as { inGuild?: boolean } | undefined)?.inGuild === true;

  // Only surface "Join" when there's actually an open signup round.
  const signupsOpen = !!(await loadOpenSignupRoundId());
  const primary: { href: string; label: string }[] = [...PRIMARY_LINKS];
  if (signupsOpen) primary.push({ href: "/join", label: "Join" });
  if (isLoggedIn) primary.push({ href: "/me", label: "My profile" });
  if (isAdmin) primary.push({ href: "/admin", label: "Admin" });

  return (
    <header className="flex flex-nowrap items-center gap-3 border-b border-border bg-card px-4 py-2.5 md:gap-6 md:px-6 md:py-3">
      <h1 className="m-0 text-base">
        <Link href="/" className="flex min-h-11 items-center gap-2 text-foreground no-underline hover:opacity-80 sm:min-h-0">
          <Image src="/Balatro_League.png" alt="" width={24} height={24} className="rounded-sm" priority />
          {/* Hides below sm -- the icon alone keeps the brand link recognizable
              and tappable while leaving room for the Menu trigger, search, and
              account control to fit on one row at 390px. */}
          <span className="hidden sm:inline">Balatro League</span>
        </Link>
      </h1>
      <nav className="pixel hidden flex-wrap items-center gap-1 text-[13px] sm:flex md:gap-2">
        {primary.map((link) => {
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

      <span className="ml-auto flex flex-nowrap items-center gap-3">
        {/* Phone-only -- folds the primary links + settings rows + login/logout
            into one labelled trigger (see its own doc comment). */}
        <SiteMobileMenu
          links={primary}
          activePath={activePath}
          showingBmpMmr={showingBmpMmr}
          showingUsernames={showingUsernames}
          showingDiscordIds={showingDiscordIds}
          inGuild={inGuild}
          isAdmin={isAdmin}
          isLoggedIn={isLoggedIn}
          userName={user?.name ?? null}
          toggleShowBmpMmr={toggleShowBmpMmr}
          toggleShowUsernames={toggleShowUsernames}
          toggleShowDiscordIds={toggleShowDiscordIds}
        />
        <CommandButton />
        <details className="relative hidden sm:block">
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
              <Button
                type="submit"
                variant="ghost"
                className="w-full justify-start gap-2 px-1 text-[13px] text-foreground"
              >
                <span className="text-sm">{showingBmpMmr ? "☑" : "☐"}</span>
                <span>Show BMP MMR</span>
              </Button>
            </form>
            {inGuild && (
              <form action={toggleShowUsernames}>
                <input type="hidden" name="next" value={showingUsernames ? "0" : "1"} />
                <input type="hidden" name="returnTo" value={activePath || "/"} />
                <Button
                  type="submit"
                  variant="ghost"
                  className="w-full justify-start gap-2 px-1 text-[13px] text-foreground"
                >
                  <span className="text-sm">{showingUsernames ? "☑" : "☐"}</span>
                  <span>Show Discord usernames</span>
                </Button>
              </form>
            )}
            {isAdmin && (
              <form action={toggleShowDiscordIds}>
                <input type="hidden" name="next" value={showingDiscordIds ? "0" : "1"} />
                <input type="hidden" name="returnTo" value={activePath || "/"} />
                <Button
                  type="submit"
                  variant="ghost"
                  className="w-full justify-start gap-2 px-1 text-[13px] text-foreground"
                >
                  <span className="text-sm">{showingDiscordIds ? "☑" : "☐"}</span>
                  <span>Show Discord IDs (admin)</span>
                </Button>
              </form>
            )}
          </div>
        </details>

        {isLoggedIn ? (
          <>
            <Link href="/me" className="flex min-h-11 items-center text-foreground sm:min-h-0">
              {user?.name ?? "(unknown)"}
            </Link>
            {/* Hidden below sm -- the phone Menu folds in an equivalent Logout
                row (see SiteMobileMenu), so the row doesn't also carry this
                separate text link at 390px. */}
            <Link href="/api/auth/signout" className="muted hidden text-xs sm:inline">
              logout
            </Link>
          </>
        ) : (
          <Link href="/auth/signin" className="muted flex min-h-11 items-center text-xs sm:min-h-0">
            Login with Discord
          </Link>
        )}
      </span>
    </header>
  );
}
