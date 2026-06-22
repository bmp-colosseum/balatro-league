// Thin render of the /me page. All data comes from loadMePageData;
// all mutations go through actions.ts. No direct Prisma here.

import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { loadMePageData } from "@/lib/loaders/me";
import { SiteNav } from "@/components/SiteNav";
import { Button } from "@/components/ui/button";
import { NextSeasonCard } from "@/components/NextSeasonCard";
import { ProfileView } from "@/components/ProfileView";
import { Callout } from "@/components/Callout";

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

  // /me and /profile/[id] render the SAME <ProfileView> — no redirect. If you
  // have a Player record, /me just renders your own profile inline (ProfileView
  // resolves you as the viewer, so you get the own-profile controls). Only the
  // "not linked yet" state below is unique to /me.
  if (player) return <ProfileView playerId={player.id} />;

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
                <span className="pill" style={{ background: "rgba(46,204,113,0.15)", color: "var(--success)" }}>Linked</span>{" "}
                Connected to a league profile.
              </div>
            ) : (
              <div style={{ marginTop: 4 }}>
                <span className="pill" style={{ background: "rgba(241,196,15,0.15)", color: "var(--accent)" }}>Not linked</span>{" "}
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
          <Callout type="success">
            ✓ Match recorded. Standings updated.
          </Callout>
        )}
        {err && (
          <Callout type="danger">
            {err}
          </Callout>
        )}

        {/* Same component the profile page uses, so the two surfaces stay
            identical. No Player row yet → reminders are on iff they're on the
            🔔 list. */}
        <NextSeasonCard remindersOn={!!interest} />

        <div className="card">
          <strong>Not in the league yet</strong>
          <p className="muted">
            You&apos;re logged in but haven&apos;t joined yet. Turn on season reminders above, hit Sign Up in Discord, or ask an admin.
          </p>
        </div>
      </main>
    </>
  );
}
