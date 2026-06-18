import "server-only";

// Admin-only sub-group review on the draft season page. The division is the
// competitive unit (standings + promotion run across it); this splits each into
// balanced match-assignment groups. Flow: finalize placement → Generate →
// review the groups + balance → Regenerate if you nudge placement → build.
// Players never see this; it only scopes who-plays-whom.

import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DraggableSubGroups } from "@/components/DraggableSubGroups";
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
        include: { player: { select: { displayName: true, rating: true } } },
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
        group ({groupSize - 1} games); standings + promotion still run across the whole division. Drag players
        between groups to nudge, or regenerate to re-balance. Hidden from players.
      </p>

      {!anyGenerated ? (
        <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          Not generated yet — finalize placement above, then generate.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 14, marginTop: 10 }}>
          {divisions.map((d) => {
            const grouped = d.members.filter((m) => m.assignmentGroup != null);
            const ungrouped = d.members.filter((m) => m.assignmentGroup == null);
            const groupCount = grouped.reduce((max, m) => Math.max(max, m.assignmentGroup ?? 0), 0);
            // Warn (don't block) when the division won't split into clean groups.
            const remainder = d.members.length % groupSize;
            return (
              <div key={d.id}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
                  {d.name} <span className="muted" style={{ fontWeight: 400 }}>— {d.members.length} players · {groupCount} group(s)</span>
                </div>
                {remainder !== 0 && (
                  <div style={{ fontSize: 12, color: "#f1c40f", marginBottom: 4 }}>
                    ⚠ {d.members.length} players isn&apos;t a clean multiple of {groupSize} — {remainder}{" "}
                    player{remainder === 1 ? "" : "s"} land in an off-size group ({groupSize - 1} games won&apos;t hold for everyone). Nudge placement or let it ride.
                  </div>
                )}
                <DraggableSubGroups
                  seasonId={seasonId}
                  groupCount={groupCount}
                  initialMembers={grouped.map((m) => ({
                    memberId: m.id,
                    playerName: m.player.displayName,
                    group: m.assignmentGroup!,
                    seed: m.player.rating,
                  }))}
                />
                {ungrouped.length > 0 && (
                  <div style={{ border: "1px dashed rgba(241,196,15,0.5)", borderRadius: 6, padding: "8px 10px", marginTop: 6, fontSize: 12 }}>
                    <span style={{ fontWeight: 600, color: "#f1c40f" }}>Ungrouped ({ungrouped.length})</span>{" "}
                    <span className="muted">— {ungrouped.map((m) => m.player.displayName).join(", ")}. Regenerate to assign.</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
