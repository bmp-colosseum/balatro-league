import Link from "next/link";
import { loadSeasonsIndex } from "@/lib/loaders/seasons";
import { SiteNav } from "@/components/SiteNav";
import { SeasonWindow } from "@/components/SeasonWindow";

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
              return (
                <Link
                  key={s.id}
                  href={`/seasons/${s.id}`}
                  className="card"
                  style={{ display: "block", color: "var(--text)", textDecoration: "none", marginBottom: 0 }}
                >
                  <strong style={{ fontSize: 16 }}>{s.name}</strong>{" "}
                  {s.isActive ? (
                    <span className="pill" style={{ background: "rgba(46,204,113,0.2)", color: "var(--success)" }}>ACTIVE</span>
                  ) : (
                    <span className="pill" style={{ background: "rgba(149,165,166,0.2)", color: "var(--muted)" }}>FINISHED</span>
                  )}
                  <SeasonWindow start={s.startedAt} end={s.endedAt ?? s.scheduledEndAt} className="mt-1" />
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
