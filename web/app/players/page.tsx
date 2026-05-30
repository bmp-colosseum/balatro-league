import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isMockPlayer } from "@/lib/mock";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";

export const dynamic = "force-dynamic";

export default async function PlayersPage() {
  // Player roster is gated — must be logged in to see it. Standings + season
  // pages stay public.
  const session = await auth();
  if (!session?.user) redirect("/auth/signin?from=/players");

  const allPlayers = await prisma.player.findMany({
    include: {
      memberships: {
        where: { division: { season: { isActive: true, visibility: "PUBLIC" } } },
        include: { division: { include: { tier: true } } },
      },
    },
    orderBy: { displayName: "asc" },
  });
  const players = allPlayers.filter((p) => !isMockPlayer(p));

  return (
    <>
      <SiteNav activePath="/players" />
      <main>
        <h2>Players ({players.length})</h2>
        <div className="card">
          <table>
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
                players.map((p) => {
                  const membership = p.memberships[0];
                  const div = membership?.division;
                  const dropped = membership?.status === "DROPPED";
                  return (
                    <tr key={p.id}>
                      <td>
                        <Link href={`/profile/${p.id}`} style={{ color: "var(--text)" }}>
                          {p.displayName}
                        </Link>
                      </td>
                      <td>
                        {div ? (
                          <>
                            <Link href={`/seasons/${div.seasonId}`} className="muted" style={{ textDecoration: "none" }}>
                              <TierPill name={div.name} position={div.tier.position} />
                            </Link>
                            {dropped && (
                              <span className="pill" style={{ background: "rgba(231,76,60,0.2)", color: "#e74c3c", marginLeft: 6 }}>
                                DROPPED
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="muted">— not in current season —</span>
                        )}
                      </td>
                    </tr>
                  );
                })
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
