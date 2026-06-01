import Link from "next/link";
import { notFound } from "next/navigation";
import { loadSeasonDetail } from "@/lib/loaders/seasons";
import { SiteNav } from "@/components/SiteNav";

export const dynamic = "force-dynamic";

export default async function SeasonDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const season = await loadSeasonDetail(id);
  if (!season) notFound();

  const period = season.endedAt
    ? `${season.startedAt.toISOString().slice(0, 10)} → ${season.endedAt.toISOString().slice(0, 10)}`
    : `Started ${season.startedAt.toISOString().slice(0, 10)}`;

  return (
    <>
      <SiteNav activePath="/seasons" />
      <main>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{season.name}</h2>
          {season.isActive ? (
            <span className="pill" style={{ background: "rgba(46,204,113,0.2)", color: "#2ecc71" }}>ACTIVE</span>
          ) : (
            <span className="pill" style={{ background: "rgba(149,165,166,0.2)", color: "#c0c8cb" }}>FINISHED</span>
          )}
          <span className="muted">· {period}</span>
          <Link href="/seasons" style={{ marginLeft: "auto" }}>← all seasons</Link>
        </div>

        {season.tiers.filter((t) => t.divisions.length > 0).map((tier) => (
          <section key={tier.id} style={{ marginTop: 24 }}>
            <h3>{tier.name}</h3>
            <div className="grid grid-2">
              {tier.divisions.map((div) => (
                <div key={div.id} className="card">
                  <strong>
                    <Link href={`/divisions/${div.id}`} style={{ textDecoration: "none" }}>{div.name}</Link>
                  </strong>
                  <table style={{ marginTop: 8 }}>
                    <thead>
                      <tr><th></th><th>Player</th><th>Pts</th><th>W-D-L</th><th>Games</th></tr>
                    </thead>
                    <tbody>
                      {div.rows.length === 0 ? (
                        <tr><td colSpan={5} className="muted">No matches played.</td></tr>
                      ) : (
                        div.rows.map((r, i) => {
                          const medal = i < 3 ? ["🥇", "🥈", "🥉"][i] : `${i + 1}.`;
                          const link = (
                            <Link href={`/profile/${r.player.id}`} style={{ color: "var(--text)" }}>
                              {r.player.displayName}
                            </Link>
                          );
                          return (
                            <tr key={r.player.id}>
                              <td>{medal}</td>
                              <td>{r.dropped ? <s>{link}</s> : link}</td>
                              <td><strong>{r.points}</strong></td>
                              <td>{r.wins}-{r.draws}-{r.losses}</td>
                              <td>{r.gamesWon}-{r.gamesLost}</td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </section>
        ))}
      </main>
    </>
  );
}
