import Link from "next/link";
import { loadSeasonsIndex } from "@/lib/loaders/seasons";
import { SiteNav } from "@/components/SiteNav";

export const dynamic = "force-dynamic";

export default async function SeasonsPage() {
  const seasons = await loadSeasonsIndex();

  return (
    <>
      <SiteNav activePath="/seasons" />
      <main>
        <h2>Seasons</h2>
        {seasons.length === 0 ? (
          <div className="card muted">No seasons yet.</div>
        ) : (
          <div className="grid grid-2">
            {seasons.map((s) => {
              const period = s.endedAt
                ? `${s.startedAt.toISOString().slice(0, 10)} → ${s.endedAt.toISOString().slice(0, 10)}`
                : `Started ${s.startedAt.toISOString().slice(0, 10)}`;
              return (
                <Link
                  key={s.id}
                  href={`/seasons/${s.id}`}
                  style={{
                    display: "block",
                    padding: 14,
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    color: "var(--text)",
                    textDecoration: "none",
                  }}
                >
                  <strong style={{ fontSize: 16 }}>{s.name}</strong>{" "}
                  {s.isActive ? (
                    <span className="pill" style={{ background: "rgba(46,204,113,0.2)", color: "#2ecc71" }}>ACTIVE</span>
                  ) : (
                    <span className="pill" style={{ background: "rgba(149,165,166,0.2)", color: "#c0c8cb" }}>FINISHED</span>
                  )}
                  <div className="muted" style={{ marginTop: 6 }}>{period}</div>
                  <div className="muted">
                    {s.divisionCount} {s.divisionCount === 1 ? "division" : "divisions"} ·{" "}
                    {s.playerCount} {s.playerCount === 1 ? "player" : "players"} ·{" "}
                    {s.pairingCount} {s.pairingCount === 1 ? "match" : "matches"}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </>
  );
}
