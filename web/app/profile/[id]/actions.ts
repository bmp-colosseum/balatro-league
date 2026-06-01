"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { disputeMatchFromWeb, type DisputeResultStr } from "@/lib/report";

// Vote on a player-page easter egg (currently just the Sanji impeachment
// joke). Gated to logged-in Discord users — unique constraint on
// (targetKey, voterDiscordId) means each user can flip their vote but
// not vote twice. Switching sides updates the existing row in place.
export async function castEasterEggVote(formData: FormData) {
  const session = await auth();
  const voterDiscordId = (session?.user as { discordId?: string } | undefined)?.discordId;
  if (!voterDiscordId) {
    // Silently no-op for unauthenticated — UI hides the form when not
    // logged in, so this would only fire if someone hand-posts the form.
    return;
  }
  const targetKey = String(formData.get("targetKey") ?? "").trim();
  const side = String(formData.get("side") ?? "").trim();
  const playerId = String(formData.get("playerId") ?? "").trim();
  if (!targetKey || (side !== "yes" && side !== "no")) return;

  await prisma.easterEggVote.upsert({
    where: { targetKey_voterDiscordId: { targetKey, voterDiscordId } },
    create: { targetKey, voterDiscordId, side },
    update: { side },
  });

  if (playerId) revalidatePath(`/profile/${playerId}`);
}

// Server action backing the per-match Dispute button on /profile/[id].
// Only the player themself can dispute their own matches — the action
// validates that the session's discordId resolves to the disputer
// player record.
export async function submitProfileDispute(formData: FormData) {
  const session = await auth();
  const disputerDiscordId = (session?.user as { discordId?: string } | undefined)?.discordId;
  if (!disputerDiscordId) redirect("/auth/signin");

  const pairingId = String(formData.get("pairingId") ?? "").trim();
  const proposedRaw = String(formData.get("proposed") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim() || null;
  const profileId = String(formData.get("profileId") ?? "").trim();

  if (!pairingId) {
    redirect(`/profile/${profileId}?disputeErr=${encodeURIComponent("Missing match id")}`);
  }
  const proposed: DisputeResultStr =
    proposedRaw === "2-0" || proposedRaw === "1-1" || proposedRaw === "0-2"
      ? proposedRaw
      : "unsure";

  const r = await disputeMatchFromWeb(disputerDiscordId!, pairingId, proposed, reason);
  if (!r.ok) {
    redirect(`/profile/${profileId}?disputeErr=${encodeURIComponent(r.reason)}`);
  }

  revalidatePath(`/profile/${profileId}`);
  revalidatePath("/standings");
  revalidatePath("/me");
  redirect(`/profile/${profileId}?disputeOk=1`);
}
