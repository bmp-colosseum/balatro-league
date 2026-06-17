import { GuildMember, type User } from "discord.js";
import { prisma } from "./db.js";

// The player's preferred Discord name from an interaction: account-level
// global display name first, then server nickname, then @username. We prefer
// the global profile so league names reflect a player's real Discord identity
// (and stay consistent with the signup roster) rather than a server-specific
// nickname. The invoking member rides along in every guild interaction
// payload, so this needs NO privileged GuildMembers intent. Returns undefined
// outside a guild / when unavailable.
export function guildDisplayName(interaction: { member: unknown }): string | undefined {
  const m = interaction.member;
  if (m instanceof GuildMember) {
    return m.user.globalName ?? m.nickname ?? m.user.username ?? undefined;
  }
  if (m && typeof m === "object") {
    const raw = m as { nick?: string | null; user?: { global_name?: string | null; username?: string } };
    return raw.user?.global_name ?? raw.nick ?? raw.user?.username ?? undefined;
  }
  return undefined;
}

// Look up the Player row for a Discord user, creating one if it doesn't exist.
//
// Display name tracks their Discord global name: pass guildDisplayName(interaction)
// for the invoking user and we keep their name in sync with it. We NEVER:
//   - overwrite a name the player set themselves on the website
//     (hasCustomDisplayName), nor
//   - clobber the stored name with the global username when no server name is
//     supplied (e.g. for an opponent we only have a User). Leaving it alone
//     lets the daily refresh.display-names sync — which pulls every non-custom
//     player's global name — stay authoritative.
export async function getOrCreatePlayer(user: User, serverName?: string) {
  // Bot accounts aren't players. This is the ONE chokepoint where a Discord
  // user becomes a Player, so guarding here stops every command path — admin
  // record-match / forfeit / void-player / strike, challenge, report, … — from
  // materializing a bot, including any that forgets the nicer call-site
  // opponentUser.bot check. It matters because a bot Player propagates: the
  // season-open auto-enroll signs up every autoSignup player. Throw (not silent
  // skip) so the caller surfaces the refusal instead of acting on a half-state.
  if (user.bot) {
    throw new Error(`Refusing to create a Player for bot account ${user.username} (${user.id}).`);
  }
  const existing = await prisma.player.findUnique({ where: { discordId: user.id } });
  if (existing) {
    const next = serverName?.trim();
    // Keep the @username in sync regardless of the custom-display-name flag —
    // it's a separate field (the Discord handle), not the shown name.
    const usernameChanged = user.username !== existing.username;
    const nameChanged = !!next && !existing.hasCustomDisplayName && next !== existing.displayName;
    if (usernameChanged || nameChanged) {
      return prisma.player.update({
        where: { discordId: user.id },
        data: {
          username: user.username,
          ...(nameChanged ? { displayName: next } : {}),
        },
      });
    }
    return existing;
  }
  return prisma.player.create({
    data: { discordId: user.id, displayName: serverName?.trim() || user.username, username: user.username },
  });
}
