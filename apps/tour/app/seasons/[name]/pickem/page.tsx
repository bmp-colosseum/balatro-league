import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Target, Check, X } from "lucide-react";
import { getViewer } from "@/lib/auth";
import { getSeasonPickem, pickemLeaderboard, type PickSet } from "@/lib/services/pickem";
import { makePickAction } from "./actions";

export const dynamic = "force-dynamic";

// One player's pick button (a tiny server-action form). Highlighted when it's the viewer's
// current pick; the winner is tinted green once decided.
function PickButton({ season, s, side, signedIn }: { season: string; s: PickSet; side: "A" | "B"; signedIn: boolean }) {
  const pid = side === "A" ? s.playerAId : s.playerBId;
  const name = side === "A" ? s.playerA : s.playerB;
  const picked = s.myPick === pid;
  const isWinner = s.decided && s.winnerId === pid;
  const bg = isWinner ? "rgba(46, 204, 113, 0.18)" : picked ? "var(--surface-2)" : "transparent";
  const border = picked ? "var(--accent)" : "var(--border)";
  const inner = (
    <span className="inline-flex items-center gap-1">
      {name}
      {picked && <Check className="size-3" style={{ color: "var(--accent)" }} />}
    </span>
  );
  if (s.decided || !signedIn) {
    return <span style={{ padding: "3px 8px", borderRadius: 6, border: `1px solid ${border}`, background: bg, fontWeight: picked || isWinner ? 600 : 400 }}>{inner}</span>;
  }
  return (
    <form action={makePickAction} style={{ display: "inline" }}>
      <input type="hidden" name="season" value={season} />
      <input type="hidden" name="setId" value={s.setId} />
      <input type="hidden" name="pickedPlayerId" value={pid} />
      <button type="submit" style={{ padding: "3px 8px", borderRadius: 6, border: `1px solid ${border}`, background: bg, fontWeight: picked ? 600 : 400, cursor: "pointer" }}>
        {inner}
      </button>
    </form>
  );
}

export default async function SeasonPickem({ params }: { params: Promise<{ name: string }> }) {
  const name = decodeURIComponent((await params).name);
  const enc = encodeURIComponent(name);
  const viewer = await getViewer();
  const [pickem, board] = await Promise.all([getSeasonPickem(name, viewer.discordId), pickemLeaderboard(name)]);
  if (!pickem) notFound();

  // Open weeks first (most relevant), then decided — each week newest at the top.
  const weeks = [...pickem.weeks].sort((a, b) => b.week - a.week);
  const myRow = board.find((r) => r.discordId === viewer.discordId);

  return (
    <main>
      <p><Link href={`/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {name}</Link></p>
      <h1 className="flex items-center gap-2"><Target className="size-5 text-[var(--accent)]" /> Pick&apos;em</h1>
      <p className="sub">Predict the winner of each set. Picks lock when the set is played · +1 per correct pick.{pickem.openCount === 0 ? " No open sets right now — check back when the week's matchups are posted." : ` ${pickem.openCount} open.`}</p>

      {!viewer.discordId && (
        <div className="card"><p className="sub">Sign in with Discord to make picks — you can still see everyone&apos;s standing below.</p></div>
      )}

      {board.length > 0 && (
        <div className="card">
          <div className="bracket-title">Leaderboard{myRow ? ` · you: ${myRow.correct}/${myRow.decided} (${myRow.pct.toFixed(0)}%)` : ""}</div>
          <table>
            <thead><tr><th className="rank">#</th><th>Player</th><th className="num">Correct</th><th className="num">Picks</th><th className="num">Acc</th></tr></thead>
            <tbody>
              {board.slice(0, 25).map((r, i) => (
                <tr key={r.discordId} style={r.discordId === viewer.discordId ? { background: "var(--surface-2)" } : undefined}>
                  <td className="rank">{i + 1}</td>
                  <td>{r.name}</td>
                  <td className="num">{r.correct}</td>
                  <td className="num">{r.decided}</td>
                  <td className="num">{r.pct.toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {weeks.map((wk) => (
        <div key={wk.week} className="card">
          <div className="bracket-title">{wk.week ? `Week ${wk.week}` : "Sets"}</div>
          <table>
            <tbody>
              {wk.sets.map((s) => {
                const hit = s.decided && s.myPick && s.myPick === s.winnerId;
                const miss = s.decided && s.myPick && s.myPick !== s.winnerId;
                return (
                  <tr key={s.setId}>
                    <td style={{ width: 40 }}>
                      {hit && <Check className="size-4" style={{ color: "var(--success)" }} />}
                      {miss && <X className="size-4" style={{ color: "var(--danger)" }} />}
                    </td>
                    <td><PickButton season={name} s={s} side="A" signedIn={!!viewer.discordId} /></td>
                    <td className="muted num" style={{ textAlign: "center", width: 32 }}>vs</td>
                    <td style={{ textAlign: "right" }}><PickButton season={name} s={s} side="B" signedIn={!!viewer.discordId} /></td>
                    <td className="sub" style={{ textAlign: "right", width: 90 }}>{s.decided ? "final" : "open"}{s.teamA && s.teamB ? "" : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </main>
  );
}
