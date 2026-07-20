// Next-Auth v5 (Auth.js) configuration.
// Discord OAuth provider, JWT-based sessions, no DB session storage needed.

import NextAuth from "next-auth";
import Discord from "next-auth/providers/discord";
import { fetchGuildMember } from "@/lib/discord";

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
    ? (() => {
        const base = {
          httpOnly: true,
          sameSite: "lax" as const,
          path: "/",
          secure: true,
          domain: process.env.AUTH_COOKIE_DOMAIN,
        };
        // Domain-scope EVERY auth cookie — the session AND the short-lived OAuth
        // flow cookies — so the whole login works across www + apex. Without a
        // domain on the flow cookies, a login that starts on one host and returns
        // on the other loses the PKCE verifier -> "pkceCodeVerifier value could
        // not be parsed". csrfToken uses the __Host- prefix (which forbids a
        // domain) and is same-host only, so it stays at the default.
        return {
          cookies: {
            sessionToken: { name: "__Secure-authjs.session-token", options: base },
            callbackUrl: { name: "__Secure-authjs.callback-url", options: base },
            pkceCodeVerifier: { name: "__Secure-authjs.pkce.code_verifier", options: { ...base, maxAge: 900 } },
            state: { name: "__Secure-authjs.state", options: { ...base, maxAge: 900 } },
            nonce: { name: "__Secure-authjs.nonce", options: { ...base, maxAge: 900 } },
          },
        };
      })()
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
      const guildId = process.env.DISCORD_GUILD_ID;
      // First time the JWT is created (right after sign-in), enrich with Discord fields
      if (profile) {
        token.discordId = profile.id as string;
        token.username = (profile.username as string) ?? token.name;
        token.avatar = (profile.avatar as string) ?? null;
        // Privacy gate: remember whether they're a member of OUR server, checked
        // via the bot token (no extra OAuth scope). Drives whether they can see
        // other players' @usernames on the site.
        token.inGuild = guildId ? (await fetchGuildMember(guildId, profile.id as string)) !== null : false;
        token.inGuildCheckedAt = Date.now();
      } else if (token.discordId && guildId) {
        // Periodic re-verify (~daily) so LEAVING the server revokes @username
        // access within a day, without forcing a re-login. The TTL guard means
        // at most one extra Discord lookup per user per day, on the first request
        // after the window. (A transient API error reads as "not a member" and
        // could revoke for up to a day — restored on the next successful check.)
        const DAY = 24 * 60 * 60 * 1000;
        const last = typeof token.inGuildCheckedAt === "number" ? token.inGuildCheckedAt : 0;
        if (Date.now() - last > DAY) {
          token.inGuild = (await fetchGuildMember(guildId, token.discordId as string)) !== null;
          token.inGuildCheckedAt = Date.now();
        }
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
      (session.user as { inGuild?: boolean }).inGuild = token.inGuild === true;
      return session;
    },
  },
  pages: {
    // Use our own logged-out landing rather than the default Auth.js page
    signIn: "/auth/signin",
  },
});
