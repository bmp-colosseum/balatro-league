import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth, signOut } from "@/auth";
import { prisma } from "@/lib/prisma";
import { reportSetFromWeb, type ReportResultStr } from "@/lib/report";
import { computeStandings } from "@/lib/standings";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";

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

  let player = user.discordId
    ? await prisma.player.findUnique({ where: { discordId: user.discordId } })
    : null;

  // Auto-sync display name from Discord — see prior commit for rationale.
  if (player && user.name && player.displayName !== user.name) {
    player = await prisma.player.update({
      where: { discordId: user.discordId },
      data: { displayName: user.name },
    });
  }

  // Find the user's active-PUBLIC division + members + already-played opponents.
  const myMembership = player
    ? await prisma.divisionMember.findFirst({
        where: {
          playerId: player.id,
          status: "ACTIVE",
          division: { season: { isActive: true, visibility: "PUBLIC" } },
        },
        include: {
          division: {
            include: {
              tier: true,
              season: true,
              members: { include: { player: true } },
              pairings: { where: { status: "CONFIRMED" } },
            },
          },
        },
      })
    : null;

  const division = myMembership?.division;
  const opponents = division?.members.filter((m) => m.playerId !== player!.id && m.status === "ACTIVE") ?? [];
  const playedOpponentIds = new Set<string>();
  if (division && player) {
    for (const p of division.pairings) {
      const opp = p.playerAId === player.id ? p.playerBId : p.playerAId === player.id ? null : null;
      if (p.playerAId === player.id) playedOpponentIds.add(p.playerBId);
      else if (p.playerBId === player.id) playedOpponentIds.add(p.playerAId);
      void opp;
    }
  }
  const unplayedOpponents = opponents.filter((m) => !playedOpponentIds.has(m.playerId));

  const myStandings = division && player
    ? computeStandings(division.members.map((m) => m.player), division.pairings).find((r) => r.player.id === player.id)
    : null;

  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.discordId}/${user.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/0.png`;

  async function logoutAction() {
    "use server";
    await signOut({ redirectTo: "/standings" });
  }

  async function reportAction(formData: FormData) {
    "use server";
    const session = await auth();
    const discordId = (session?.user as { discordId?: string } | undefined)?.discordId;
    if (!discordId) redirect("/me?err=not-logged-in");
    const opponentId = String(formData.get("opponentId") ?? "");
    const result = String(formData.get("result") ?? "") as ReportResultStr;
    if (!opponentId || !["2-0", "1-1", "0-2"].includes(result)) {
      redirect("/me?err=missing-fields");
    }
    const r = await reportSetFromWeb(discordId!, opponentId, result);
    if (!r.ok) redirect(`/me?err=${encodeURIComponent(r.reason)}`);
    revalidatePath("/me");
    revalidatePath("/standings");
    redirect("/me?ok=1");
  }

  const tc = division ? tierColors(division.tier.position) : null;

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

        {player && division && tc ? (
          <div className="card">
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <strong>Your current division:</strong>
              <span className="pill" style={{ background: tc.bg, color: tc.fg }}>{division.tier.name}</span>
              <Link href={`/seasons/${division.seasonId}`} style={{ textDecoration: "none" }}>{division.name}</Link>
              <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
                {division.season.name}
                {myStandings && <> · {myStandings.points} pts · {myStandings.wins}-{myStandings.draws}-{myStandings.losses}</>}
              </span>
            </div>

            <div style={{ marginTop: 12 }}>
              <strong>Report a set</strong>
              {unplayedOpponents.length === 0 ? (
                <p className="muted" style={{ marginTop: 4 }}>
                  No unplayed opponents — you've played everyone in your division.
                </p>
              ) : (
                <form action={reportAction} style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <span className="muted" style={{ fontSize: 12 }}>vs</span>
                  <select name="opponentId" required style={{ flex: "1 1 200px" }}>
                    <option value="">— pick an opponent —</option>
                    {unplayedOpponents.map((m) => (
                      <option key={m.playerId} value={m.playerId}>{m.player.displayName}</option>
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
                Reports are auto-confirmed and recorded immediately. If something looks wrong, ask an admin
                to use <code>/admin override-result</code> in Discord.
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
