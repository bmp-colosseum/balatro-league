// Next-Auth v5 (Auth.js) configuration.
// Discord OAuth provider, JWT-based sessions, no DB session storage needed.

import NextAuth from "next-auth";
import Discord from "next-auth/providers/discord";

// Reuse the existing DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET env vars
// (same Discord application as the bot uses). Explicit pass-through so we
// don't need to rename to next-auth's AUTH_DISCORD_ID convention.
export const { handlers, auth, signIn, signOut } = NextAuth({
  // Trust the request Host header for URL resolution. Required behind
  // Railway's proxy — without this next-auth falls back to the
  // container's internal bind (localhost:8080) when constructing the
  // OAuth callback URL, which Discord then rejects.
  // Equivalent to AUTH_TRUST_HOST=true but doesn't depend on env-var
  // detection working correctly.
  trustHost: true,
  // Share the session cookie across sub-domains when AUTH_COOKIE_DOMAIN is set
  // (e.g. ".balatroleague.com" in prod) so a login on www carries to the apex
  // (and vice-versa) instead of forcing a re-auth on each. Unset locally / on
  // the test service → NextAuth's host-only default, which works on localhost
  // and the *.railway.app URL. (A cookie can't span two DIFFERENT domains, so
  // this only unifies www + apex of one domain — not prod vs the test URL.)
  ...(process.env.AUTH_COOKIE_DOMAIN
    ? {
        cookies: {
          sessionToken: {
            name: "__Secure-authjs.session-token",
            options: {
              httpOnly: true,
              sameSite: "lax" as const,
              path: "/",
              secure: true,
              domain: process.env.AUTH_COOKIE_DOMAIN,
            },
          },
        },
      }
    : {}),
  providers: [
    Discord({
      clientId: process.env.DISCORD_CLIENT_ID,
      clientSecret: process.env.DISCORD_CLIENT_SECRET,
      // We only need identity — no servers list, no DM access
      authorization: { params: { scope: "identify" } },
    }),
  ],
  // JWT-based sessions: no DB writes for auth state
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 7 }, // 7 days
  callbacks: {
    async jwt({ token, profile }) {
      // First time the JWT is created (right after sign-in), enrich with Discord fields
      if (profile) {
        token.discordId = profile.id as string;
        token.username = (profile.username as string) ?? token.name;
        token.avatar = (profile.avatar as string) ?? null;
      }
      return token;
    },
    async session({ session, token }) {
      // Expose what the app needs from the token onto the session
      if (token.discordId) {
        (session.user as { discordId?: string }).discordId = token.discordId as string;
      }
      if (token.username) {
        session.user.name = token.username as string;
      }
      if (token.avatar !== undefined) {
        (session.user as { avatar?: string | null }).avatar = token.avatar as string | null;
      }
      return session;
    },
  },
  pages: {
    // Use our own logged-out landing rather than the default Auth.js page
    signIn: "/auth/signin",
  },
});
