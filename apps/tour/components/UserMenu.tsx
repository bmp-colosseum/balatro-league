// Header auth control: shows the signed-in Discord user (+ tier badge) with a sign-out
// button, or a "Sign in" link. Async server component — safe to drop into the nav.
import Link from "next/link";
import { LogIn, LogOut, UserCircle } from "lucide-react";
import { getViewer } from "@/lib/auth";
import { signOut } from "@/auth";

export async function UserMenu() {
  const v = await getViewer();

  // Not signed in via Discord (incl. local dev-admin, which has no discordId).
  if (!v.discordId) {
    return (
      <span className="flex items-center gap-2">
        {v.tier === "OWNER" && <span className="badge" title="TOUR_DEV_ADMIN=1">dev</span>}
        <Link href="/auth/signin" className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground hover:no-underline">
          <LogIn className="size-4" /> Sign in
        </Link>
      </span>
    );
  }

  const isStaff = v.tier === "OWNER" || v.tier === "TO" || v.tier === "HELPER";
  return (
    <span className="flex items-center gap-2">
      <Link
        href="/me"
        className="flex items-center gap-1.5 text-foreground hover:no-underline"
        title={`Signed in as ${v.name ?? v.discordId} · ${v.tier}`}
      >
        <UserCircle className="size-4 text-[var(--accent)]" />
        {v.name ?? "Player"}
        {isStaff && <span className="badge">{v.tier}</span>}
      </Link>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/" });
        }}
      >
        <button type="submit" className="flex items-center text-muted-foreground transition-colors hover:text-foreground" title="Sign out">
          <LogOut className="size-4" />
        </button>
      </form>
    </span>
  );
}
