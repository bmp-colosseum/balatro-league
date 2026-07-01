// Shared player-name renderer: the linked (global) display name, optionally followed by the
// raw Discord id in parens for admins (gated by lib/discord-id). Use <PlayerName> in server
// components (it resolves the gate itself); in client components pass a precomputed `showIds`
// flag + the row's discordId and use <DiscordIdTag>.
import Link from "next/link";
import { canSeeDiscordIds, isRealDiscordId } from "@/lib/discord-id";

export function DiscordIdTag({ discordId, show }: { discordId?: string | null; show: boolean }) {
  if (!show || !isRealDiscordId(discordId)) return null;
  return <span className="discord-username"> ({discordId})</span>;
}

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
