// Thin render of the /me page. All data comes from loadMePageData;
// all mutations go through actions.ts. No direct Prisma here.

import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { loadMePageData } from "@/lib/loaders/me";
import { SiteNav } from "@/components/SiteNav";
import { Button } from "@/components/ui/button";
import { subscribeNextSeasonAction, unsubscribeNextSeasonAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/auth/signin");

  const { ok, err } = await searchParams;
  const user = session.user as {
    discordId: string;
    name?: string | null;
    avatar?: string | null;
  };

  const { player, interest } = await loadMePageData(user.discordId, user.name);

  // /me and the profile page used to be confusingly separate. Now if you
  // have a Player record, /me just sends you to your own profile (which
  // carries the report form + personal settings + full history). Only the
  // "not linked yet" state stays here.
  if (player) redirect(`/profile/${player.id}`);

  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.discordId}/${user.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/0.png`;

  // Logout stays inline — uses next-auth's signOut, no DB work.
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
            {player ? (
              <div style={{ marginTop: 4 }}>
                <span className="pill" style={{ background: "rgba(46,204,113,0.15)", color: "#2ecc71" }}>Linked</span>{" "}
                Connected to a league profile.
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
              <Button type="submit" variant="secondary">Logout</Button>
            </form>
          </span>
        </div>

        {ok && (
          <div className="card" style={{ borderColor: "#2ecc71", color: "#2ecc71" }}>
            ✓ Set recorded. Standings updated.
          </div>
        )}
        {err && (
          <div className="card" style={{ borderColor: "#e74c3c", color: "#e74c3c" }}>
            {err}
          </div>
        )}

        <div className="card">
          <strong>Next-season notifications</strong>
          {interest ? (
            <>
              <p className="muted" style={{ fontSize: 12 }}>
                ✓ You're subscribed (since {interest.subscribedAt.toISOString().slice(0, 10)}). The bot will DM you when the next season's signups open.
              </p>
              <form action={unsubscribeNextSeasonAction}>
                <Button type="submit" variant="secondary">Unsubscribe</Button>
              </form>
            </>
          ) : (
            <>
              <p className="muted" style={{ fontSize: 12 }}>
                Get a Discord DM the moment a new season's signups open. Useful if you don't check the server often.
              </p>
              <form action={subscribeNextSeasonAction}>
                <Button type="submit">🔔 Notify me about the next season</Button>
              </form>
            </>
          )}
        </div>

        <div className="card">
          <strong>Not in the league yet</strong>
          <p className="muted">
            You're logged in but no Player record exists for your Discord ID. Find the Sign Up
            button in your league's Discord channel, or ask an admin to add you.
          </p>
        </div>
      </main>
    </>
  );
}
