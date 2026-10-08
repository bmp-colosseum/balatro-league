// Shared "who do I ping" rendering. Discord's <@id> mention renders as
// "unknown-user" / "@invalid-user" for viewers whose client hasn't resolved
// that member (common in match threads, DMs, and for anyone who left/never
// joined the cache) -- so a bare mention can leave a player unable to see
// who they're even supposed to @ to arrange their game. Appending the
// Discord @username in parentheses gives everyone a plain-text handle they
// can type themselves, which Discord always resolves.
//
// Honors the subject's own opt-out (Player.showUsername) -- when false, we
// show the mention only, same as a player with no username synced yet.

export interface MentionSubject {
  discordId: string;
  username?: string | null;
  showUsername?: boolean | null;
}

// Schema default for showUsername is true, so a null/undefined value here
// (not yet synced, or a caller passing a narrower shape) means "allowed",
// matching the Prisma column default rather than silently hiding the handle.
function isUsernameAllowed(p: MentionSubject): boolean {
  return p.showUsername !== false;
}

// Normalize a stored username into a bare handle with no leading "@" and no
// surrounding whitespace, or null if there's nothing usable. Centralizing
// this is what keeps mentionWithHandle/handleOf from ever emitting "@@...".
function normalizedHandle(p: MentionSubject): string | null {
  const raw = p.username?.trim();
  if (!raw) return null;
  const bare = raw.startsWith("@") ? raw.slice(1) : raw;
  return bare.length > 0 ? bare : null;
}

// `<@id>`, or `<@id> (@handle)` when the player has a synced, non-opted-out
// Discord username. Use at every player-facing mention site so the handle
// rides along automatically.
export function mentionWithHandle(p: MentionSubject): string {
  const base = `<@${p.discordId}>`;
  if (!isUsernameAllowed(p)) return base;
  const handle = normalizedHandle(p);
  return handle ? `${base} (@${handle})` : base;
}

// Just the "@handle" part (no mention), or "" when unavailable/opted out.
// For call sites that already render the mention separately and only need
// the handle text.
export function handleOf(p: MentionSubject): string {
  if (!isUsernameAllowed(p)) return "";
  const handle = normalizedHandle(p);
  return handle ? `@${handle}` : "";
}
