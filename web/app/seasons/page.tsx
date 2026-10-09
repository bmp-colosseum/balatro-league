import Link from "next/link";
import { loadSeasonsIndex } from "@/lib/loaders/seasons";
import { loadHallOfFame } from "@/lib/loaders/hall-of-fame";
import { SiteNav } from "@/components/SiteNav";
import { SeasonWindow } from "@/components/SeasonWindow";

export const dynamic = "force-dynamic";

export default async function SeasonsPage() {
  // Champion name per ended season, off the same Hall of Fame data the
  // /hall-of-fame page reads (lib/loaders/hall-of-fame.ts) -- no new query
  // shape, just keyed by seasonId for this page's own card.
  const [seasons, hallOfFame] = await Promise.all([loadSeasonsIndex(), loadHallOfFame()]);
  const championBySeasonId = new Map(hallOfFame.map((s) => [s.seasonId, s.champion]));

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
              const champion = championBySeasonId.get(s.id);
              return (
                <Link
                  key={s.id}
                  href={`/seasons/${s.id}`}
                  className="card"
                  style={{ display: "block", color: "var(--text)", textDecoration: "none", marginBottom: 0 }}
                >
                  <strong style={{ fontSize: 16 }}>{s.name}</strong>{" "}
                  {s.isActive ? (
                    <span className="pill" data-status="active">ACTIVE</span>
                  ) : (
                    <span className="pill" data-status="finished">FINISHED</span>
                  )}
                  <SeasonWindow start={s.startedAt} end={s.endedAt ?? s.scheduledEndAt} className="mt-1" />
                  {champion && (
                    <div style={{ color: "var(--legendary)", fontSize: 13, marginTop: 2, fontWeight: 600 }}>
                      Champion: {champion.playerName}
                    </div>
                  )}
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
