"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { editChannelMessage, type ComponentActionRow, type MessageEmbed } from "@/lib/discord";

function buildClosedSignupPayload(
  round: { id: string; name: string },
  signups: Array<{ discordId: string }>,
): { embeds: MessageEmbed[]; components: ComponentActionRow[] } {
  const playerList = signups.length
    ? signups.map((s, i) => `${i + 1}. <@${s.discordId}>`).join("\n")
    : "_No one signed up._";
  return {
    embeds: [{
      title: `🃏  ${round.name}`,
      description: "Sign-ups are closed.",
      fields: [
        { name: "Status", value: `**${signups.length} signed up — sign-ups closed**`, inline: false },
        { name: "Players", value: playerList, inline: false },
      ],
      color: 0x99aab5,
      footer: { text: `Round ${round.id}` },
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, custom_id: `signup:join:${round.id}`, style: 3, label: "Sign Up", disabled: true },
        { type: 2, custom_id: `signup:withdraw:${round.id}`, style: 2, label: "Withdraw", disabled: true },
      ],
    }],
  };
}

export async function closeRound(formData: FormData) {
  await requireAdmin();
  const roundId = String(formData.get("roundId") ?? "");
  if (!roundId) return;
  const round = await prisma.signupRound.findUnique({
    where: { id: roundId },
    include: { signups: { where: { withdrawn: false }, orderBy: { signedUpAt: "asc" } } },
  });
  if (!round || round.status !== "OPEN") return;
  await prisma.signupRound.update({
    where: { id: roundId },
    data: { status: "CLOSED", closedAt: new Date() },
  });
  if (round.messageId && round.messageId !== "pending") {
    await editChannelMessage(round.channelId, round.messageId, buildClosedSignupPayload(round, round.signups));
  }
  revalidatePath("/admin/signups");
  revalidatePath("/admin/seasons");
}
