// Server component: the editable draft, rendered inline wherever we need it (the
// preview page after build, or the standalone arrange URL). Loads the draft
// season + per-member context and drops the shared drag-and-drop divisions
// editor on it — drag a player into any division, it autosaves — plus an
// Activate button. No "use client": this is server-rendered; the editor inside
// is the client part.

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { DraggableDivisionsEditor, type EditorMember, type EditorTier } from "@/components/DraggableDivisionsEditor";
import { ConfirmButton } from "@/components/ConfirmButton";
import { loadAdminSeasonDetail } from "@/lib/loaders/admin";
import { loadContinuityPlacement } from "@/lib/loaders/continuity";
import { tierColors } from "@/lib/tier-colors";
import { formatSeasonLabel } from "@/lib/format-season";
import { activateSeason } from "@/app/admin/seasons/actions";

export async function DraftArranger({ seasonId, roundId }: { seasonId: string; roundId?: string }) {
  const adminData = await loadAdminSeasonDetail(seasonId, {
    listGuildTextChannels: async () => [],
    guildId: undefined,
  });
  if (!adminData) return <div className="card">Couldn&apos;t load the draft season.</div>;
  const { season, memberContext } = adminData;
  const activated = season.isActive || season.endedAt != null;

  if (activated) {
    return (
      <div className="card">
        This season is already live — editing is closed. <Link href={`/seasons/${season.id}`}>View season →</Link>
      </div>
    );
  }

  const allPlayers = await prisma.player.findMany({
    select: { id: true, displayName: true, discordId: true, username: true },
    orderBy: { displayName: "asc" },
  });

  // Reuse the continuity library for the promotion/relegation context: each
  // signup's LAST-season division (as a ladder index) + standing. Keyed by
  // discordId. Rookies come back with fromIndex null → shown as NEW.
  const priorByDiscord = new Map<string, { idx: number | null; name: string | null; standing: string | null }>();
  if (roundId) {
    const cont = await loadContinuityPlacement(roundId);
    if (cont && cont !== "NO_ROUND" && cont !== "NO_SEASON") {
      for (const dv of cont.divisions) {
        for (const mm of dv.members) {
          priorByDiscord.set(mm.discordId, {
            idx: mm.fromIndex,
            name: mm.fromIndex != null ? cont.divisions[mm.fromIndex]?.name ?? null : null,
            standing: mm.standing ? `#${mm.standing.rank} · ${mm.standing.record}` : null,
          });
        }
      }
    }
  }

  const editorTiers: EditorTier[] = season.tiers.map((t) => ({
    id: t.id,
    name: t.name,
    position: t.position,
    color: tierColors(t.position),
  }));
  // globalIndex = position in the draft ladder (divisions come back ordered by
  // tier position then group number), so it matches the continuity fromIndex.
  const editorDivisions = season.divisions.map((d, i) => ({ id: d.id, name: d.name, tierId: d.tierId, globalIndex: i }));
  const editorMembers: EditorMember[] = season.divisions.flatMap((d) =>
    d.members.map((m) => {
      const ctx = memberContext.get(m.player.id);
      const prior = roundId ? priorByDiscord.get(m.player.discordId) : undefined;
      return {
        id: m.id,
        playerId: m.player.id,
        playerName: m.player.displayName,
        divisionId: d.id,
        draftOrder: m.draftOrder,
        leagueRating: ctx?.leagueRating ?? m.player.rating,
        hiddenMmr: m.player.hiddenMmr ?? null,
        bmpMmr: ctx?.bmpMmr ?? null,
        bmpTier: ctx?.bmpTier ?? null,
        priorFinalGlobalRank: ctx?.priorFinalGlobalRank ?? null,
        // undefined (no roundId) → no marker; null → NEW; number → ↑/↓/=.
        priorDivisionGlobalIndex: roundId ? prior?.idx ?? null : undefined,
        priorDivisionName: prior?.name ?? null,
        priorStanding: prior?.standing ?? null,
      };
    }),
  );
  const remountKey = editorMembers.map((m) => `${m.playerId}@${m.divisionId}#${m.draftOrder}`).join("|");

  return (
    <div>
      <div className="card" style={{ borderColor: "#f1c40f", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <strong style={{ color: "#f1c40f" }}>Draft — not live</strong>
        <span className="muted" style={{ fontSize: 12 }}>
          Drag any player into any division — it saves automatically. Nothing goes live until you activate.
        </span>
        <form action={activateSeason} style={{ marginLeft: "auto" }}>
          <input type="hidden" name="id" value={season.id} />
          <ConfirmButton
            message="Activate this season? It goes LIVE — divisions lock in, Discord roles/channels get set up, and the season starts."
            style={{ padding: "5px 14px", fontWeight: 600 }}
          >
            Activate season →
          </ConfirmButton>
        </form>
      </div>
      <DraggableDivisionsEditor
        key={remountKey}
        seasonId={season.id}
        tiers={editorTiers}
        divisions={editorDivisions}
        initialMembers={editorMembers}
        allPlayers={allPlayers}
      />
    </div>
  );
}
