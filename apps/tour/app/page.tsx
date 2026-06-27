import Link from "next/link";
import { Trophy, ArrowRight, ClipboardList } from "lucide-react";
import { getSeasonsOverview } from "@/lib/home";
import { getOpenSignupSeason } from "@/lib/services/signups";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [seasons, openSeason] = await Promise.all([getSeasonsOverview(), getOpenSignupSeason()]);

  return (
    <main>
      <h1>Pizza Power — Team Tour</h1>
      <p className="sub">Standings, brackets, rosters, and all-time history.</p>

      {openSeason && (
        <Link href="/signup" className="card card-accent flex items-center gap-2 hover:no-underline" style={{ marginBottom: "1rem" }}>
          <ClipboardList className="size-4 text-[var(--accent-2)]" />
          <span><strong>{openSeason.name}</strong> signups are open — register now <ArrowRight className="inline size-3.5" /></span>
        </Link>
      )}

      <div className="season-grid">
        {seasons.map((s) => (
          <Link className="season-card" key={s.name} href={`/seasons/${encodeURIComponent(s.name)}`}>
            <div className="season-card-top">
              <span className="season-name">{s.name}</span>
              <span className="badge">{s.format === "CONFERENCES" ? "Conferences" : "Swiss"}</span>
            </div>
            <div className="season-card-champ">
              {s.champion ? (
                <span className="inline-flex items-center gap-1.5">
                  <Trophy className="size-4" /> {s.champion}
                </span>
              ) : (
                <span className="sub">—</span>
              )}
            </div>
            <div className="sub">{s.teams} teams</div>
          </Link>
        ))}
        {seasons.length === 0 && <p className="sub">No seasons yet — run the import.</p>}
      </div>

      <p className="sub mt-6 flex flex-wrap items-center gap-x-4 gap-y-1">
        <Link href="/players" className="inline-flex items-center gap-1">
          All-time player leaderboard <ArrowRight className="size-3.5" />
        </Link>
        <span className="text-[var(--border)]">·</span>
        <Link href="/teams" className="inline-flex items-center gap-1">
          All-time team leaderboard <ArrowRight className="size-3.5" />
        </Link>
      </p>
    </main>
  );
}
