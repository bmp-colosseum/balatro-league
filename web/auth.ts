// Next-Auth v5 (Auth.js) configuration.
// Discord OAuth provider, JWT-based sessions, no DB session storage needed.

import NextAuth from "next-auth";
import Discord from "next-auth/providers/discord";

// Reuse the existing DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET env vars
// (same Discord application as the bot uses). Explicit pass-through so we
// don't need to rename to next-auth's AUTH_DISCORD_ID convention.
export const { handlers, auth, signIn, signOut } = NextAuth({
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
