"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { actorFromAdminUser } from "@/lib/audit";
import { buildSeasonFromContinuity } from "@/lib/build-season-continuity";
import { buildSignupPayload, loadRoundSeasonScheduledStart } from "@/lib/signup-discord";
import { editChannelMessage } from "@/lib/discord";
import { setPlacementRules } from "@/lib/placement-rules";

// Save the promotion/relegation + structure rules from the preview page, then
// reload so the projection reflects them.
export async function savePlacementRules(formData: FormData) {
  const { user } = await requireAdmin();
  const roundId = String(formData.get("roundId") ?? "");
  const num = (k: string, min: number, dflt: number) => {
    const n = Number.parseInt(String(formData.get(k)), 10);
    return Number.isFinite(n) ? Math.max(min, n) : dflt;
  };
  await setPlacementRules(
    {
      topFixedSize: num("topFixedSize", 0, 6),
      defaultOpponentsPerPlayer: num("defaultOpponentsPerPlayer", 1, 4), // dflt 4 matches DEFAULT_PLACEMENT_RULES
      tightenTopTiers: formData.get("tightenTopTiers") != null,
      swapThreshold: num("swapThreshold", 1, 8),
      baseSwap: num("baseSwap", 0, 1),
      bigSwap: num("bigSwap", 0, 2),
    },
    user.discordId,
  );
  revalidatePath(`/admin/signups/${roundId}/preview`);
  redirect(`/admin/signups/${roundId}/preview?basis=current`);
}

// Re-open a round that got wrongly closed (e.g. an old "built" draft). Flips it
// back to OPEN, clears closedAt, and re-renders the Discord signup message to the
// open "X signed up" state so the Sign Up button works again.
export async function reopenSignupRound(formData: FormData) {
  await requireAdmin();
  const roundId = String(formData.get("roundId") ?? "");
  if (!roundId) return;
  const round = await prisma.signupRound.findUnique({
    where: { id: roundId },
    include: { signups: { where: { withdrawn: false } } },
  });
  if (!round) return;
  await prisma.signupRound.update({ where: { id: roundId }, data: { status: "OPEN", closedAt: null } });
  if (round.channelId && round.messageId && round.messageId !== "pending") {
    try {
      const seasonScheduledStartAt = await loadRoundSeasonScheduledStart(round.resultingSeasonId);
      const payload = buildSignupPayload({ ...round, seasonScheduledStartAt }, round.signups.length);
      await editChannelMessage(round.channelId, round.messageId, payload);
    } catch (err) {
      console.warn("[reopen-signups] Discord re-render failed:", err);
    }
  }
  revalidatePath(`/admin/signups/${roundId}/preview`);
  redirect(`/admin/signups/${roundId}/preview?basis=current`);
}

// Commit the "Based on current season" preview — including any hand-moves the
// admin made in the editable view — as a real DRAFT season. Redirects to the
// season detail page (draft mode) where it's reviewed and activated, same as
// the normal build flow.
export async function buildContinuitySeason(formData: FormData) {
  const { user } = await requireAdmin();

  const roundId = String(formData.get("roundId") ?? "");
  if (!roundId) return;

  let moves: Record<string, number> = {};
  try {
    const parsed = JSON.parse(String(formData.get("moves") ?? "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        const n = Number(v);
        if (Number.isInteger(n)) moves[k] = n;
      }
    }
  } catch {
    // Bad JSON → no overrides, just build the algorithm's arrangement.
  }

  const subtitleRaw = String(formData.get("subtitle") ?? "").trim();

  const result = await buildSeasonFromContinuity({
    roundId,
    moves,
    subtitle: subtitleRaw.length > 0 ? subtitleRaw : null,
    actor: actorFromAdminUser(user),
  });

  if (result === "NO_SEASON") redirect(`/admin/signups/${roundId}/preview?basis=current&err=no-season`);
  if (result === "ALREADY_BUILT") {
    // The target season is already live/finished — go view it.
    const round = await prisma.signupRound.findUnique({ where: { id: roundId }, select: { resultingSeasonId: true } });
    redirect(round?.resultingSeasonId ? `/seasons/${round.resultingSeasonId}` : `/admin/seasons`);
  }
  if (!result) redirect(`/admin/signups/${roundId}/preview?basis=current&err=build-failed`);

  revalidatePath("/admin/signups");
  revalidatePath("/admin/seasons");
  // Back to the preview — now populated, so it renders the editor inline.
  redirect(`/admin/signups/${roundId}/preview?basis=current`);
}
