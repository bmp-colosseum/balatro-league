import "server-only";

// Admin-only sub-group review on the draft season page. The division is the
// competitive unit (standings + promotion run across it); this splits each into
// balanced match-assignment groups. Flow: finalize placement → Generate →
// review the groups + balance → Regenerate if you nudge placement → build.
// Players never see this; it only scopes who-plays-whom.

import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { generateSubGroups, setSubGroupSize } from "@/app/seasons/[id]/actions";

export async function SubGroupsPanel({ seasonId }: { seasonId: string }) {
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: { subGroupSize: true },
  });
  if (!season) return null;
  const groupSize = season.subGroupSize;

  const divisions = await prisma.division.findMany({
    where: { seasonId },
    orderBy: { name: "asc" },
    include: {
      members: {
        where: { status: "ACTIVE" },
        orderBy: [{ draftOrder: "asc" }, { seedRank: "asc" }],
        include: { player: { select: { displayName: true } } },
      },
    },
  });

  const anyGenerated = divisions.some((d) => d.members.some((m) => m.assignmentGroup != null));

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <strong>Sub-groups (match assignment)</strong>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <form action={setSubGroupSize} style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="hidden" name="seasonId" value={seasonId} />
            <label style={{ fontSize: 12 }} className="muted">Group size</label>
            <Input
              type="number"
              name="subGroupSize"
              defaultValue={groupSize}
              min={2}
              max={50}
              style={{ width: 64 }}
            />
            <Button type="submit" variant="secondary">Save</Button>
          </form>
          <form action={generateSubGroups}>
            <input type="hidden" name="seasonId" value={seasonId} />
            <Button type="submit" variant={anyGenerated ? "secondary" : undefined}>
              {anyGenerated ? "↻ Regenerate" : "Generate sub-groups"}
            </Button>
          </form>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        Splits each division into balanced groups of ~{groupSize} (snake-seeded). You round-robin within your
        group ({groupSize - 1} games); standings + promotion still run across the whole division. Regenerate after
        moving players. Hidden from players.
      </p>

      {!anyGenerated ? (
        <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          Not generated yet — finalize placement above, then generate.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 14, marginTop: 10 }}>
          {divisions.map((d) => {
            // Seed = position in draft order; group members for display + avg-seed balance.
            const seedOf = new Map(d.members.map((m, i) => [m.id, i + 1]));
            const groups = new Map<number, typeof d.members>();
            const ungrouped: typeof d.members = [];
            for (const m of d.members) {
              if (m.assignmentGroup == null) {
                ungrouped.push(m);
              } else {
                const arr = groups.get(m.assignmentGroup) ?? [];
                arr.push(m);
                groups.set(m.assignmentGroup, arr);
              }
            }
            const sorted = [...groups.entries()].sort((a, b) => a[0] - b[0]);
            return (
              <div key={d.id}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
                  {d.name} <span className="muted" style={{ fontWeight: 400 }}>— {d.members.length} players · {sorted.length} group(s)</span>
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {sorted.map(([g, ms]) => {
                    const avgSeed = ms.reduce((s, m) => s + (seedOf.get(m.id) ?? 0), 0) / ms.length;
                    return (
                      <div key={g} style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, padding: "8px 10px", minWidth: 150 }}>
                        <div style={{ fontSize: 12, fontWeight: 600 }}>
                          Group {g}{" "}
                          <span className="muted" style={{ fontWeight: 400 }}>· {ms.length}p · {ms.length - 1} games · avg #{avgSeed.toFixed(1)}</span>
                        </div>
                        <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 12 }}>
                          {ms.map((m) => (
                            <li key={m.id}>{m.player.displayName} <span className="muted">#{seedOf.get(m.id)}</span></li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                  {ungrouped.length > 0 && (
                    <div style={{ border: "1px dashed rgba(241,196,15,0.5)", borderRadius: 6, padding: "8px 10px", minWidth: 150, fontSize: 12 }}>
                      <div style={{ fontWeight: 600, color: "#f1c40f" }}>Ungrouped ({ungrouped.length})</div>
                      <div className="muted">Regenerate to assign.</div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
