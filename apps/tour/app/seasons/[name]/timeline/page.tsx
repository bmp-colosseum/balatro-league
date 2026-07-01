import Link from "next/link";
import { ArrowLeft, Shuffle, RefreshCw, UserMinus, Ban, Undo2, UserPlus, Crown, Swords, Trophy } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { getSeasonTimeline, type TimelineEvent, type TimelineKind } from "@/lib/season-timeline";

export const dynamic = "force-dynamic";

const ICON: Record<TimelineKind, LucideIcon> = {
  DRAFT: Shuffle,
  SUB: RefreshCw,
  QUIT: UserMinus,
  BANNED: Ban,
  REINSTATED: Undo2,
  ADDED: UserPlus,
  CAPTAIN: Crown,
  RESULT: Swords,
  PLAYOFFS: Trophy,
  PLAYOFF_RESULT: Trophy,
  CHAMPION: Crown,
};
const COLOR: Record<TimelineKind, string> = {
  DRAFT: "var(--accent-2)",
  SUB: "var(--accent-2)",
  QUIT: "var(--danger)",
  BANNED: "var(--danger)",
  REINSTATED: "var(--success)",
  ADDED: "var(--success)",
  CAPTAIN: "var(--accent)",
  RESULT: "var(--muted)",
  PLAYOFFS: "var(--accent)",
  PLAYOFF_RESULT: "var(--accent)",
  CHAMPION: "var(--accent)",
};

function groupLabel(week: number, kinds: Set<TimelineKind>): string {
  if (week === 0) return "Pre-season";
  if (kinds.has("CHAMPION")) return "Champion";
  if (kinds.has("PLAYOFFS") || kinds.has("PLAYOFF_RESULT")) return "Playoffs";
  return `Week ${week}`;
}

export default async function SeasonTimelinePage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const seasonName = decodeURIComponent(name);
  const enc = encodeURIComponent(seasonName);
  const data = await getSeasonTimeline(seasonName);

  if (!data) {
    return (
      <main>
        <p><Link href="/" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> seasons</Link></p>
        <h1>Season not found</h1>
      </main>
    );
  }

  // Group events by week, preserving order.
  const groups: { week: number; label: string; events: TimelineEvent[] }[] = [];
  for (const e of data.events) {
    let g = groups[groups.length - 1];
    if (!g || g.week !== e.week) {
      g = { week: e.week, label: "", events: [] };
      groups.push(g);
    }
    g.events.push(e);
  }
  for (const g of groups) g.label = groupLabel(g.week, new Set(g.events.map((e) => e.kind)));

  return (
    <main>
      <p>
        <Link href={`/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {seasonName}</Link>
      </p>
      <h1>Season timeline</h1>
      <p className="sub">Every roster move, result, and milestone in order — derived from the season&apos;s move log + matchups.</p>

      {groups.length === 0 ? (
        <div className="card"><p className="sub">Nothing has happened yet this season.</p></div>
      ) : (
        groups.map((g) => (
          <div className="card" key={g.week} style={{ marginBottom: "0.75rem" }}>
            <div className="bracket-title">{g.label}</div>
            <ul className="list-none p-0" style={{ margin: 0 }}>
              {g.events.map((e, i) => {
                const Icon = ICON[e.kind];
                return (
                  <li key={i} className="flex items-start gap-2 py-1" style={{ borderTop: i ? "1px solid var(--border)" : undefined }}>
                    <Icon className="mt-0.5 size-4 shrink-0" style={{ color: COLOR[e.kind] }} />
                    <div>
                      <div>
                        {e.title.map((part, j) => (part.href ? <Link key={j} href={part.href}>{part.text}</Link> : <span key={j}>{part.text}</span>))}
                      </div>
                      {e.detail && <div className="sub">{e.detail}</div>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </main>
  );
}
