// /hall-of-fame — the champions of every completed season. Public, anyone can view.

import Link from "next/link";
import { SiteNav } from "@/components/SiteNav";
import { loadHallOfFame, type HofMatch } from "@/lib/loaders/hall-of-fame";

export const dynamic = "force-dynamic";

function endedLabel(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", timeZone: "UTC" });
}

const OUTCOME: Record<HofMatch["outcome"], { tag: string; color: string }> = {
  win: { tag: "W", color: "#2ecc71" },
  loss: { tag: "L", color: "#e74c3c" },
  draw: { tag: "D", color: "#95a5a6" },
  void: { tag: "–", color: "#7f8c8d" },
};

export default async function HallOfFamePage() {
  const seasons = await loadHallOfFame();
  const withChampions = seasons.filter((s) => s.champion);

  return (
    <>
      <SiteNav activePath="/hall-of-fame" />
      <main>
        <h2>🏆 Hall of Fame</h2>
        <p className="muted" style={{ marginTop: -4, marginBottom: 16 }}>
          The top division&apos;s winner is the league champion.
        </p>

        {withChampions.length === 0 ? (
          <div className="card muted">
            No champions yet — the first season&apos;s winners will be enshrined here the moment it ends. Check back!
          </div>
        ) : (
          withChampions.map((s) => {
            const champ = s.champion!;
            return (
              <section
                key={s.seasonId}
                className="card"
                style={{ marginBottom: 16, borderColor: "#f1c40f", borderWidth: 1, borderStyle: "solid" }}
              >
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <strong className="pixel" style={{ fontSize: 18 }}>{s.seasonLabel}</strong>
                  <span className="muted" style={{ fontSize: 12 }}>Ended {endedLabel(s.endedAt)}</span>
                </div>

                {/* Champion */}
                <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 32 }}>🏆</span>
                  <div>
                    <div style={{ fontSize: 20, fontWeight: 700 }}>
                      <Link href={`/profile/${champ.playerId}`} style={{ color: "#f1c40f", textDecoration: "none" }}>
                        {champ.playerName}
                      </Link>
                    </div>
                    <div className="muted" style={{ fontSize: 13 }}>
                      Champion · {champ.divisionName} · <strong>{champ.record}</strong> (W-L-D) · {champ.points} pts
                    </div>
                  </div>
                </div>

                {/* Champion's match log */}
                {s.championMatches.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                      Road to the title
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {s.championMatches.map((m) => {
                        const o = OUTCOME[m.outcome];
                        return (
                          <div key={m.opponentId} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                            <span style={{ width: 18, fontWeight: 700, color: o.color }}>{o.tag}</span>
                            <span style={{ width: 56, fontVariantNumeric: "tabular-nums" }}>{m.myGames}-{m.oppGames}</span>
                            <span className="muted">vs</span>
                            <Link href={`/profile/${m.opponentId}`} style={{ color: "var(--text)" }}>{m.opponentName}</Link>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </section>
            );
          })
        )}
      </main>
    </>
  );
}
