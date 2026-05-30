import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { SiteNav } from "@/components/SiteNav";

export const dynamic = "force-dynamic";

export default async function SeasonsPage() {
  const seasons = await prisma.season.findMany({
    // Archived seasons stay accessible by direct URL but are hidden from
    // the index — they clutter the season list otherwise.
    where: { visibility: "PUBLIC", archivedAt: null },
    include: {
      _count: { select: { divisions: true } },
      divisions: { include: { _count: { select: { members: true, pairings: true } } } },
    },
    orderBy: [{ isActive: "desc" }, { startedAt: "desc" }],
  });

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
              const players = s.divisions.reduce((sum, d) => sum + d._count.members, 0);
              const sets = s.divisions.reduce((sum, d) => sum + d._count.pairings, 0);
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
                  <div className="muted">{s._count.divisions} divisions · {players} players · {sets} sets</div>
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </>
  );
}
