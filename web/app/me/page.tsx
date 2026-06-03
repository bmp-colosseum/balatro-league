// Thin render of the /me page. All data comes from loadMePageData;
// all mutations go through actions.ts. No direct Prisma here.

import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { loadMePageData } from "@/lib/loaders/me";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";
import {
  reportFromMePageAction,
  resetToDiscordNameAction,
  setCustomNameAction,
  subscribeNextSeasonAction,
  unsubscribeNextSeasonAction,
} from "./actions";

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

  const { player, division, interest } = await loadMePageData(user.discordId, user.name);

  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.discordId}/${user.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/0.png`;

  // Logout stays inline — uses next-auth's signOut, no DB work.
  async function logoutAction() {
    "use server";
    await signOut({ redirectTo: "/standings" });
  }

  const tc = division ? tierColors(division.tierPosition) : null;

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
              <button type="submit" className="secondary">Logout</button>
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
                <button type="submit" className="secondary">Unsubscribe</button>
              </form>
            </>
          ) : (
            <>
              <p className="muted" style={{ fontSize: 12 }}>
                Get a Discord DM the moment a new season's signups open. Useful if you don't check the server often.
              </p>
              <form action={subscribeNextSeasonAction}>
                <button type="submit">🔔 Notify me about the next season</button>
              </form>
            </>
          )}
        </div>

        {player && (
          <div className="card">
            <strong>Display name</strong>
            <p className="muted" style={{ fontSize: 12 }}>
              {player.hasCustomDisplayName
                ? <>Currently using your custom name <strong>{player.displayName}</strong>. To switch back to your Discord username (auto-updates when you change it on Discord), reset below.</>
                : <>Auto-synced from your Discord username (<strong>{player.displayName}</strong>). Set your own below if you want it shown differently in standings/profiles.</>}
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <form action={setCustomNameAction} style={{ display: "flex", gap: 6, flex: "1 1 280px" }}>
                <input
                  type="text"
                  name="displayName"
                  defaultValue={player.displayName}
                  required
                  maxLength={64}
                  style={{ flex: 1 }}
                />
                <button type="submit">Save custom name</button>
              </form>
              {player.hasCustomDisplayName && (
                <form action={resetToDiscordNameAction}>
                  <button type="submit" className="secondary">↻ Reset to Discord name</button>
                </form>
              )}
            </div>
          </div>
        )}

        {player && division && tc ? (
          <div className="card">
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <strong>Your current division:</strong>
              <span className="pill" style={{ background: tc.bg, color: tc.fg }}>{division.tierName}</span>
              <Link href={`/seasons/${division.seasonId}`} style={{ textDecoration: "none" }}>{division.divisionName}</Link>
              <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
                {division.seasonName}
                {division.myStandings && (
                  <> · {division.myStandings.points} pts · {division.myStandings.wins}-{division.myStandings.draws}-{division.myStandings.losses}</>
                )}
              </span>
            </div>

            <div style={{ marginTop: 12 }}>
              <strong>Report a match</strong>
              {division.reportableOpponents.length === 0 ? (
                <p className="muted" style={{ marginTop: 4 }}>
                  No unplayed opponents — you've played everyone in your division.
                </p>
              ) : (
                <form action={reportFromMePageAction} style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <span className="muted" style={{ fontSize: 12 }}>vs</span>
                  <select name="opponentId" required style={{ flex: "1 1 200px" }}>
                    <option value="">— pick an opponent —</option>
                    {division.reportableOpponents.map((o) => (
                      <option key={o.playerId} value={o.playerId}>{o.displayName}</option>
                    ))}
                  </select>
                  <select name="result" required defaultValue="2-0">
                    <option value="2-0">2-0 (I won both)</option>
                    <option value="1-1">1-1 (draw)</option>
                    <option value="0-2">0-2 (I lost both)</option>
                  </select>
                  <button type="submit">Report</button>
                </form>
              )}
              <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                Web reports are recorded immediately. The result is posted to <strong>#results</strong> in
                Discord and your opponent gets a DM with a dispute link. Something wrong? Use the inline
                Dispute control on <Link href="/report">/report</Link> or ping a{" "}
                <strong>League Helper</strong> in Discord.
              </p>
            </div>
          </div>
        ) : player ? (
          <div className="card muted">
            You're not in an active public division right now — when you are, this is where you'll
            report results from.
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
