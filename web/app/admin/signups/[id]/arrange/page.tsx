import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { DraggableDivisionsEditor, type EditorMember, type EditorTier } from "@/components/DraggableDivisionsEditor";
import { ConfirmButton } from "@/components/ConfirmButton";
import { loadAdminSeasonDetail } from "@/lib/loaders/admin";
import { tierColors } from "@/lib/tier-colors";
import { formatSeasonLabel } from "@/lib/format-season";
import { activateSeason } from "@/app/admin/seasons/actions";

export const dynamic = "force-dynamic";

// THE one editable page. The "Based on current season" projection, turned into a
// real draft, shown with the shared drag-and-drop divisions editor: grab a
// player, drop them in any division, it autosaves. Share this URL with whoever
// is arranging (e.g. dunk) — it's the only thing they need to touch. Activate
// when it looks right. No ladder, no recompute, no other steps.
export default async function ArrangePage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id: roundId } = await params;

  const round = await prisma.signupRound.findUnique({
    where: { id: roundId },
    select: { id: true, name: true, resultingSeasonId: true },
  });
  if (!round) redirect("/admin/signups");
  // No draft yet → go back to the preview to create it.
  if (!round.resultingSeasonId) redirect(`/admin/signups/${roundId}/preview?basis=current`);

  const adminData = await loadAdminSeasonDetail(round.resultingSeasonId, {
    listGuildTextChannels: async () => [],
    guildId: undefined,
  });
  if (!adminData) redirect(`/admin/signups/${roundId}/preview?basis=current`);
  const { season, memberContext } = adminData;
  const activated = season.isActive || season.endedAt != null;

  const allPlayers = await prisma.player.findMany({
    select: { id: true, displayName: true, discordId: true, username: true },
    orderBy: { displayName: "asc" },
  });

  const editorTiers: EditorTier[] = season.tiers.map((t) => ({
    id: t.id,
    name: t.name,
    position: t.position,
    color: tierColors(t.position),
  }));
  const editorDivisions = season.divisions.map((d) => ({ id: d.id, name: d.name, tierId: d.tierId }));
  const editorMembers: EditorMember[] = season.divisions.flatMap((d) =>
    d.members.map((m) => {
      const ctx = memberContext.get(m.player.id);
      return {
        id: m.id,
        playerId: m.player.id,
        playerName: m.player.displayName,
        divisionId: d.id,
        draftOrder: m.draftOrder,
        leagueRating: ctx?.leagueRating ?? m.player.rating,
        bmpMmr: ctx?.bmpMmr ?? null,
        bmpTier: ctx?.bmpTier ?? null,
        priorFinalGlobalRank: ctx?.priorFinalGlobalRank ?? null,
      };
    }),
  );
  const remountKey = editorMembers.map((m) => `${m.playerId}@${m.divisionId}#${m.draftOrder}`).join("|");

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/seasons" />
      <main>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>Arrange {formatSeasonLabel(season)}</h2>
          <span
            className="pill"
            style={
              activated
                ? { background: "rgba(46,204,113,0.18)", color: "#2ecc71" }
                : { background: "rgba(241,196,15,0.18)", color: "#f1c40f" }
            }
          >
            {activated ? "LIVE" : "draft — not live"}
          </span>
          <Link href={`/admin/signups/${roundId}/preview?basis=current`} className="muted" style={{ marginLeft: "auto" }}>
            ← Back to preview
          </Link>
        </div>
        <p className="muted">
          Drag any player into any division — it <strong>saves automatically</strong>. This is the draft for
          next season; share this page with whoever&apos;s helping arrange it. Nothing is live until you hit
          <strong> Activate</strong>.
        </p>

        {activated ? (
          <div className="card">
            This season is already live — editing is closed. <Link href={`/seasons/${season.id}`}>View season →</Link>
          </div>
        ) : (
          <>
            <DraggableDivisionsEditor
              key={remountKey}
              seasonId={season.id}
              tiers={editorTiers}
              divisions={editorDivisions}
              initialMembers={editorMembers}
              allPlayers={allPlayers}
            />
            <form action={activateSeason} style={{ marginTop: 18 }}>
              <input type="hidden" name="id" value={season.id} />
              <ConfirmButton
                message="Activate this season? It goes LIVE — divisions lock in, Discord roles/channels get set up, and the season starts."
                style={{ padding: "7px 18px", fontWeight: 600 }}
              >
                Activate season →
              </ConfirmButton>
            </form>
          </>
        )}
      </main>
    </>
  );
}
