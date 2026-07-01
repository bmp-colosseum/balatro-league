// Header auth control: shows the signed-in Discord user (+ tier badge) with a sign-out
// button, or a "Sign in" link. Async server component — safe to drop into the nav.
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { LogIn, LogOut, UserCircle, Hash } from "lucide-react";
import { getViewer } from "@/lib/auth";
import { discordIdsShown, setShowDiscordIds } from "@/lib/discord-id";
import { signOut } from "@/auth";

export async function UserMenu() {
  const v = await getViewer();
  const isStaff = v.tier === "OWNER" || v.tier === "TO" || v.tier === "HELPER";
  const idsOn = isStaff ? await discordIdsShown() : false;

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

  const isAdminTier = v.tier === "OWNER" || v.tier === "TO";
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
      {isAdminTier && (
        <form
          action={async () => {
            "use server";
            await setShowDiscordIds(!idsOn);
            revalidatePath("/", "layout");
          }}
        >
          <button
            type="submit"
            className="flex items-center transition-colors"
            style={{ color: idsOn ? "var(--accent)" : "var(--muted)" }}
            title={idsOn ? "Discord IDs shown — click to hide" : "Discord IDs hidden — click to show"}
          >
            <Hash className="size-4" />
          </button>
        </form>
      )}
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
