import "server-only";
import { canSeeUsernames } from "@/lib/usernames";

// Inline Discord @username chip rendered next to a player's name — but ONLY for
// verified server members with the toggle on (canSeeUsernames). For everyone
// else the username is not rendered at all, so it never reaches the page HTML
// (privacy: a logged-out visitor can't view-source to harvest handles). The
// numeric Discord ID is never shown anywhere.
//
// Server component (async) so it can do the per-request membership check
// itself — pages just drop <DiscordId username={p.username} /> next to a name
// and don't thread any auth state. The `value` (numeric id) prop is accepted
// but ignored, so existing call sites don't have to change. NOT usable inside
// client components (it's server-only) — those render the handle inline,
// gated by their own server-provided data.
export async function DiscordId({
  username,
}: {
  value?: string | null;
  username?: string | null;
}) {
  if (!username) return null;
  if (!(await canSeeUsernames())) return null;
  return (
    <span className="discord-username" title="Discord username">
      (@{username})
    </span>
  );
}
