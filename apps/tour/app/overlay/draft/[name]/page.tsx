// Draft ticker overlay (OBS browser source): on the clock + up next + the last few picks.
// Live-updates via SSE. URL: /overlay/draft/<season name>.
import { getDraft } from "@/lib/services/draft";
import { LiveRefresh } from "@/components/LiveRefresh";

export const dynamic = "force-dynamic";

const ord = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
};

const box: React.CSSProperties = {
  background: "rgba(15, 17, 21, 0.92)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "10px 14px",
  color: "var(--text)",
  fontSize: 15,
  display: "inline-block",
};

export default async function DraftOverlay({ params }: { params: Promise<{ name: string }> }) {
  const seasonName = decodeURIComponent((await params).name);
  const board = await getDraft(seasonName);
  if (!board) return <div style={box}>No draft for {seasonName}.</div>;

  const lastPicks = board.teams
    .flatMap((t) => t.picks.map((p) => ({ team: t.name, name: p.name, overall: p.overall })))
    .sort((a, b) => b.overall - a.overall)
    .slice(0, 3)
    .reverse();

  return (
    <main>
      <LiveRefresh channel={`draft:${board.season.id}`} />
      <div style={box}>
        {board.current ? (
          <>
            <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--accent)" }}>On the clock</div>
            <div style={{ fontWeight: 700, fontSize: 20 }}>
              {board.current.team?.name ?? "—"} <span style={{ color: "var(--muted)", fontWeight: 400 }}>R{board.current.round} · {board.current.overall}{ord(board.current.overall)} overall</span>
            </div>
            {board.upcoming.length > 0 && (
              <div style={{ color: "var(--muted)", marginTop: 4, fontSize: 13 }}>
                Up next: {board.upcoming.map((u) => `${u.overall}. ${u.team}`).join("  ·  ")}
              </div>
            )}
            {lastPicks.length > 0 && (
              <div style={{ marginTop: 6, fontSize: 13 }}>
                {lastPicks.map((p) => (
                  <div key={p.overall}><span style={{ color: "var(--muted)" }}>{p.overall}{ord(p.overall)}:</span> <strong>{p.team}</strong> select {p.name}</div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div style={{ fontWeight: 700 }}>Draft complete — {board.madePicks}/{board.totalPicks} picks in the books 🍕</div>
        )}
      </div>
    </main>
  );
}
