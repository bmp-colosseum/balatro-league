// Inline Discord identity chips rendered next to a player's name:
//   • @username — PUBLIC. Shown by default to everyone; hidden per-browser via
//     the ⚙️ "Show Discord usernames" toggle (body `show-usernames` class).
//   • numeric id — ADMIN-ONLY. Hidden for everyone except admins who flip the
//     ⚙️ "Show Discord IDs" toggle (body `show-discord-ids`, only set for admins
//     in the root layout).
//
// Both are always emitted into the markup; CSS off the body classes controls
// who actually sees each, so pages just render this next to a name and never
// thread any toggle/permission state down. `user-select: all` (globals.css)
// makes a single click select the whole value for easy copy. Renders nothing
// for an empty value.
export function DiscordId({
  value,
  username,
}: {
  value?: string | null;
  username?: string | null;
}) {
  return (
    <>
      {username ? (
        <span className="discord-username" title="Discord username">
          @{username}
        </span>
      ) : null}
      {value ? (
        <span className="discord-id" title="Discord ID (admin)">
          {value}
        </span>
      ) : null}
    </>
  );
}
