"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

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
