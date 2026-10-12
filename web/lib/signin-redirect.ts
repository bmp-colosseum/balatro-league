// Pure decision for where /auth/signin sends you after a successful Discord
// login. No imports -- the page passes in searchParams.from, this decides
// the safe redirect target, the page wires it into signIn()'s redirectTo.
//
// Only a same-origin, relative path is accepted (must start with exactly one
// "/", never "//" or "/\" -- both are protocol-relative / browser-normalized
// ways to point off-site, the classic open-redirect trick) so a crafted
// ?from= query param can never bounce a signed-in player to an attacker's
// domain. Anything else (missing, absolute URL, off-origin, malformed) falls
// back to the given default.

export function safeSignInRedirect(from: string | null | undefined, fallback = "/me"): string {
  if (!from) return fallback;
  if (from.length === 0) return fallback;
  if (!from.startsWith("/")) return fallback;
  if (from.startsWith("//")) return fallback;
  if (from.startsWith("/\\")) return fallback;
  // No embedded whitespace/control characters -- a same-origin path is one
  // token, never needs them.
  if (/[\s<>]/.test(from)) return fallback;
  return from;
}
