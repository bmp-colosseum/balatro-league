// Shared player-name renderer (server component): the linked (global) display name, followed
// by the raw Discord id in parens for admins (gate resolved via lib/discord-id). In client
// components, pass a precomputed `showIds` flag + the row's discordId and use <DiscordIdTag>.
import Link from "next/link";
import { canSeeDiscordIds } from "@/lib/discord-id";
import { DiscordIdTag } from "@/components/DiscordIdTag";

export async function PlayerName({
  id,
  name,
  discordId,
  className,
}: {
  id: string;
  name: string;
  discordId?: string | null;
  className?: string;
}) {
  const show = await canSeeDiscordIds();
  return (
    <>
      <Link href={`/players/${id}`} className={className}>{name}</Link>
      <DiscordIdTag discordId={discordId} show={show} />
    </>
  );
}
