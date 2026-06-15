// Inline Discord @username chip rendered next to a player's name. PUBLIC —
// shown by default to everyone; hidden per-browser via the ⚙️ "Show Discord
// usernames" toggle (body `show-usernames` class). The numeric Discord ID is
// NEVER rendered on any page. `user-select: all` (globals.css) makes a single
// click select the whole handle for easy copy. Renders nothing when there's no
// username.
//
// The `value` prop (numeric id) is accepted but intentionally ignored so the
// many existing call sites don't have to change.
export function DiscordId({
  username,
}: {
  value?: string | null;
  username?: string | null;
}) {
  if (!username) return null;
  return (
    <span className="discord-username" title="Discord username">
      (@{username})
    </span>
  );
}
