import "server-only";
import { canSeeUsernames, canSeeDiscordIds, getHiddenUsernameIds } from "@/lib/usernames";

// Inline chip rendered next to a player's name. Shows the Discord @username
// handle for verified server members with the toggle on (canSeeUsernames), and —
// for ADMINS who flip the "Show Discord IDs" toggle — additionally the numeric
// Discord ID. For everyone else nothing is rendered, so handles/ids never reach
// the page HTML (a logged-out visitor can't view-source to harvest them).
//
// Server component (async) so it does the per-request gating itself — pages just
// drop <DiscordId value={p.discordId} username={p.username} /> next to a name and
// thread no auth state. NOT usable inside client components (it's server-only).
export async function DiscordId({
  value,
  username,
}: {
  value?: string | null;
  username?: string | null;
}) {
  const [handleAllowed, idAllowed] = await Promise.all([canSeeUsernames(), canSeeDiscordIds()]);

  // @handle: verified members with the toggle on, unless the subject opted out.
  // `value` is the player's discordId (passed by every call site).
  let showHandle = handleAllowed && !!username;
  if (showHandle && value) {
    const hidden = await getHiddenUsernameIds();
    if (hidden.has(value)) showHandle = false;
  }
  // Numeric ID: admins only, with the admin "Show Discord IDs" toggle on.
  const showId = idAllowed && !!value;

  if (!showHandle && !showId) return null;
  return (
    <span className="discord-username" title={showId ? "Discord @username · numeric ID (admin)" : "Discord username"}>
      ({showHandle ? `@${username}` : ""}
      {showHandle && showId ? " · " : ""}
      {showId ? value : ""})
    </span>
  );
}
