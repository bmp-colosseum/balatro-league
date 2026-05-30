import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";

export const dynamic = "force-dynamic";

function expectedPairings(memberCount: number): number {
  return memberCount < 2 ? 0 : (memberCount * (memberCount - 1)) / 2;
}

export default async function AdminDivisionsPage() {
  await requireAdmin();

  const season = await prisma.season.findFirst({
    where: { isActive: true },
    include: {
      tiers: {
        orderBy: { position: "asc" },
        include: {
          divisions: {
            orderBy: { groupNumber: "asc" },
            include: {
              _count: { select: { members: true, pairings: true } },
              pairings: { where: { status: "CONFIRMED" }, select: { id: true } },
            },
          },
        },
      },
    },
  });

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/divisions" />
      <main>
        <h2>
          Divisions{" "}
          <span className="muted" style={{ fontWeight: "normal", fontSize: 14 }}>
            · {season?.name ?? "no active season"}
          </span>
        </h2>

        {!season ? (
          <div className="card muted">
            No active season — <Link href="/admin/seasons">create one</Link> first.
          </div>
        ) : season.tiers.filter((t) => t.divisions.length > 0).length === 0 ? (
          <div className="card muted">No divisions in this season.</div>
        ) : (
          season.tiers
            .filter((t) => t.divisions.length > 0)
            .map((tier) => {
              const color = tierColors(tier.position);
              return (
                <section key={tier.id} style={{ marginTop: 24 }}>
                  <h3>
                    <span className="pill" style={{ background: color.bg, color: color.fg, marginRight: 8 }}>
                      {tier.name}
                    </span>
                    <span className="muted" style={{ fontSize: 14, fontWeight: "normal" }}>
                      ({tier.divisions.length})
                    </span>
                  </h3>
                  <div className="grid grid-3">
                    {tier.divisions.map((d) => {
                      const expected = expectedPairings(d._count.members);
                      const confirmed = d.pairings.length;
                      const pct = expected === 0 ? 0 : Math.round((confirmed / expected) * 100);
                      return (
                        <Link
                          key={d.id}
                          href={`/admin/divisions/${d.id}`}
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
                          <strong>{d.name}</strong>
                          <div className="muted" style={{ marginTop: 8 }}>
                            {d._count.members}/{d.targetSize ?? season.targetGroupSize} players · {confirmed}/{expected} sets
                          </div>
                          <div style={{ background: "var(--surface-2)", borderRadius: 99, height: 6, overflow: "hidden", marginTop: 6 }}>
                            <div style={{ background: "var(--accent-2)", height: "100%", width: `${pct}%` }} />
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                </section>
              );
            })
        )}
      </main>
    </>
  );
}
