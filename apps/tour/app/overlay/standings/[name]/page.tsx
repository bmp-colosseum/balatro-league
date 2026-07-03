// Standings strip overlay (OBS browser source): compact per-conference tables.
// URL: /overlay/standings/<season name>.
import { getSeasonStandings } from "@/lib/standings";

export const dynamic = "force-dynamic";

const box: React.CSSProperties = {
  background: "rgba(15, 17, 21, 0.92)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "10px 14px",
  color: "var(--text)",
  fontSize: 14,
  display: "inline-block",
  verticalAlign: "top",
  marginRight: 10,
};

export default async function StandingsOverlay({ params }: { params: Promise<{ name: string }> }) {
  const seasonName = decodeURIComponent((await params).name);
  const data = await getSeasonStandings(seasonName);
  if (!data) return <div style={box}>No standings for {seasonName}.</div>;

  return (
    <main>
      {data.groups.map((g) => (
        <div key={g.conferenceId} style={box}>
          {data.groups.length > 1 && (
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--accent)", marginBottom: 4 }}>{g.conferenceName}</div>
          )}
          {g.rows.map((r, i) => (
            <div key={r.teamSeasonId} style={{ display: "flex", gap: 10, justifyContent: "space-between" }}>
              <span><span style={{ color: "var(--muted)" }}>{i + 1}.</span> <strong>{r.name}</strong></span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{r.matchupsW}-{r.matchupsL}</span>
            </div>
          ))}
        </div>
      ))}
    </main>
  );
}
