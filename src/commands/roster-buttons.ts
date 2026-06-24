import { MessageFlags, type ButtonInteraction } from "discord.js";
import { prisma } from "../db.js";
import type { ButtonHandler } from "./types.js";

// Buttons on the "still playing?" check-in DM. Records the player's answer on
// their DivisionMember (in / out) and edits the DM to acknowledge + drop the
// buttons so they can't double-answer.
export const rosterButtons: ButtonHandler = {
  prefix: "roster:",
  async execute(interaction: ButtonInteraction) {
    const [, action, memberId] = interaction.customId.split(":");
    if (!memberId || (action !== "in" && action !== "out")) {
      await interaction.reply({ content: "Unknown action.", flags: MessageFlags.Ephemeral });
      return;
    }
    const member = await prisma.divisionMember.findUnique({ where: { id: memberId }, select: { id: true } });
    if (!member) {
      await interaction.reply({ content: "This check-in is no longer active.", flags: MessageFlags.Ephemeral });
      return;
    }
    await prisma.divisionMember.update({
      where: { id: memberId },
      data: { checkinStatus: action === "in" ? "in" : "out", checkinAt: new Date() },
    });
    const ack =
      action === "in"
        ? "✅ Thanks — marked you as still playing. Go get your games in!"
        : "👍 No worries, thanks for letting us know.";
    await interaction.update({ content: `${interaction.message.content}\n\n**${ack}**`, components: [] });
  },
};
