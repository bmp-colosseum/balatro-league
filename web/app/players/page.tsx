import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { loadPlayersList } from "@/lib/loaders/players";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";
import { DiscordId } from "@/components/DiscordId";

export const dynamic = "force-dynamic";

export default async function PlayersPage() {
  // Player roster is gated — must be logged in to see it. Standings + season
  // pages stay public.
  const session = await auth();
  if (!session?.user) redirect("/auth/signin?from=/players");

  const players = await loadPlayersList();

  return (
    <>
      <SiteNav activePath="/players" />
      <main>
        <h2>Players ({players.length})</h2>
        <div className="card">
          <table className="responsive-table">
            <thead>
              <tr>
                <th>Player</th>
                <th>Current division</th>
              </tr>
            </thead>
            <tbody>
              {players.length === 0 ? (
                <tr><td colSpan={2} className="muted">No players yet.</td></tr>
              ) : (
                players.map((p) => (
                  <tr key={p.id}>
                    <td className="card-header">
                      <Link href={`/profile/${p.id}`} style={{ color: "var(--text)" }}>
                        {p.displayName}
                      </Link>
                      <DiscordId value={p.discordId} username={p.username} />
                    </td>
                    <td data-label="Division">
                      {p.membership ? (
                        <>
                          <Link href={`/seasons/${p.membership.division.seasonId}`} className="muted" style={{ textDecoration: "none" }}>
                            <TierPill name={p.membership.division.name} position={p.membership.division.tierPosition} />
                          </Link>
                          {p.membership.dropped && (
                            <span className="pill" style={{ background: "rgba(231,76,60,0.2)", color: "var(--danger)", marginLeft: 6 }}>
                              DROPPED
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="muted">— not in current season —</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}

function TierPill({ name, position }: { name: string; position: number }) {
  const c = tierColors(position);
  return <span className="pill" style={{ background: c.bg, color: c.fg }}>{name}</span>;
}
