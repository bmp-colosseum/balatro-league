// Pure, client-safe: renders the raw Discord id in parens when `show` is true and the id is
// a real one (not a legacy placeholder). No server imports, so client tables can use it too.
// The `show` decision (admin + toggle) is made server-side via lib/discord-id.
export function DiscordIdTag({ discordId, show }: { discordId?: string | null; show: boolean }) {
  if (!show || !discordId || discordId.startsWith("legacy:")) return null;
  return <span className="discord-username"> ({discordId})</span>;
}
