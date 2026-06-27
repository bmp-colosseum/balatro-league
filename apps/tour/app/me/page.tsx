import Link from "next/link";
import { LogIn, Crown, ArrowRight } from "lucide-react";
import { getViewer } from "@/lib/auth";
import { getPlayerHome } from "@/lib/player-home";
import { Callout } from "@/components/Callout";

export const dynamic = "force-dynamic";

const STATUS_COLOR: Record<string, string> = {
  PROPOSED: "var(--muted)",
  SCHEDULED: "var(--accent-2)",
  REPORTED: "var(--accent-2)",
  CONFIRMED: "var(--success)",
  DISPUTED: "var(--danger)",
  FORFEIT: "var(--danger)",
};

export default async function MyTour() {
  const viewer = await getViewer();

  if (!viewer.discordId) {
    return (
      <main>
        <h1>My Tour</h1>
        <p className="sub">Sign in with Discord to see your team, schedule, and sets.</p>
        <Link href="/auth/signin" className="inline-flex items-center gap-1.5"><LogIn className="size-4" /> Sign in with Discord</Link>
      </main>
    );
  }

  if (!viewer.playerId) {
    return (
      <main>
        <h1>My Tour</h1>
        <p className="sub">Signed in as <strong>{viewer.name ?? viewer.discordId}</strong>.</p>
        <Callout type="info">
          Your Discord isn&apos;t linked to a Team Tour player yet — you&apos;ll appear here once you&apos;ve been drafted
          onto a team. If a season is open, <Link href="/signup">sign up</Link>.
        </Callout>
      </main>
    );
  }

  const home = await getPlayerHome(viewer.playerId);
  const focusTeam = home.teams.find((t) => t.seasonName === home.focusSeason);

  return (
    <main>
      <h1>My Tour</h1>
      <p className="sub">
        Signed in as <strong>{viewer.name ?? viewer.discordId}</strong> ·{" "}
        <Link href={`/players/${viewer.playerId}`}>public profile <ArrowRight className="inline size-3.5" /></Link>
      </p>

      {home.teams.length === 0 ? (
        <Callout type="info">You&apos;re not on a roster yet.</Callout>
      ) : (
        <>
          <h2 className="mt-2 mb-1 text-[1.1rem]">Your teams</h2>
          <div className="card">
            <table>
              <thead><tr><th>Season</th><th>Team</th><th className="num">Seed</th><th>Role</th><th></th></tr></thead>
              <tbody>
                {home.teams.map((t) => (
                  <tr key={t.teamSeasonId}>
                    <td>{t.seasonName}{t.active && <span className="badge" style={{ marginLeft: 6 }}>active</span>}</td>
                    <td><Link href={`/teams/${t.teamSeasonId}`}>{t.teamName}</Link></td>
                    <td className="num">{t.seed}</td>
                    <td className="sub">{t.isCaptain ? <span className="inline-flex items-center gap-1"><Crown className="size-3.5 text-[var(--accent)]" /> Captain</span> : "Player"}</td>
                    <td style={{ textAlign: "right" }}><Link href={`/seasons/${encodeURIComponent(t.seasonName)}`}>Season →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {focusTeam && (
        <>
          <h2 className="mt-6 mb-1 text-[1.1rem]">Your sets — {focusTeam.seasonName}</h2>
          {home.sets.length === 0 ? (
            <div className="card"><p className="sub">No sets assigned yet. When your captain pairs the week&apos;s lineup, your matchups show up here.</p></div>
          ) : (
            <div className="card">
              <table>
                <thead><tr><th className="num">Wk</th><th>Opponent</th><th className="num">Score</th><th>Status</th></tr></thead>
                <tbody>
                  {home.sets.map((s) => (
                    <tr key={s.setId}>
                      <td className="num">W{s.week}</td>
                      <td style={{ fontWeight: s.result === "won" ? 700 : undefined }}>{s.opponentName}</td>
                      <td className="num">{s.myGames != null ? `${s.myGames}–${s.oppGames}` : <span className="sub">—</span>}</td>
                      <td><span className="badge" style={{ color: STATUS_COLOR[s.status] ?? "var(--muted)" }}>{s.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </main>
  );
}
