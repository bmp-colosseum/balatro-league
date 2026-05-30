import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { prisma } from "@/lib/prisma";
import { SiteNav } from "@/components/SiteNav";

export const dynamic = "force-dynamic";

export default async function MePage() {
  const session = await auth();
  if (!session?.user) redirect("/auth/signin");

  const user = session.user as {
    discordId: string;
    name?: string | null;
    avatar?: string | null;
  };

  let player = user.discordId
    ? await prisma.player.findUnique({ where: { discordId: user.discordId } })
    : null;

  // Auto-sync display name from Discord. If the user's Discord username has
  // changed since the Player row was created (or admin set a placeholder name
  // when adding by Discord ID), bring the Player row up to date.
  if (player && user.name && player.displayName !== user.name) {
    player = await prisma.player.update({
      where: { discordId: user.discordId },
      data: { displayName: user.name },
    });
  }

  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.discordId}/${user.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/0.png`;

  async function logoutAction() {
    "use server";
    await signOut({ redirectTo: "/standings" });
  }

  return (
    <>
      <SiteNav activePath="" />
      <main>
        <h2>Your profile</h2>

        <div className="card" style={{ display: "flex", gap: 16, alignItems: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={avatarUrl} alt="" style={{ width: 64, height: 64, borderRadius: "50%" }} />
          <div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{user.name ?? "(unknown)"}</div>
            <div className="muted">
              Discord ID: <code>{user.discordId}</code>
            </div>
            {player ? (
              <div style={{ marginTop: 4 }}>
                <span className="pill" style={{ background: "rgba(46,204,113,0.15)", color: "#2ecc71" }}>Linked</span>{" "}
                Your Discord ID is connected to a league profile.
              </div>
            ) : (
              <div style={{ marginTop: 4 }}>
                <span className="pill" style={{ background: "rgba(241,196,15,0.15)", color: "#f1c40f" }}>Not linked</span>{" "}
                Sign up via the Discord bot to join the league.
              </div>
            )}
          </div>
          <span style={{ marginLeft: "auto" }}>
            <form action={logoutAction}>
              <button type="submit" style={{ background: "var(--surface-2)", color: "var(--text)", border: "1px solid var(--border)", padding: "8px 14px", borderRadius: 4, cursor: "pointer" }}>
                Logout
              </button>
            </form>
          </span>
        </div>

        {player ? (
          <div className="card">
            <p className="muted">
              Your display name is synced from your Discord username automatically — change it
              in Discord and it'll update here next time you visit. Match reporting, schedule,
              and division standings are coming over from the old dashboard. For now use{" "}
              <code>/report</code> in Discord.
            </p>
          </div>
        ) : (
          <div className="card">
            <strong>Not in the league yet</strong>
            <p className="muted">
              You're logged in but no Player record exists for your Discord ID. Find the Sign Up
              button in your league's Discord channel, or ask an admin to add you.
            </p>
          </div>
        )}
      </main>
    </>
  );
}
