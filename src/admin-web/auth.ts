// Discord OAuth + session helpers.
//
// Flow:
//   1. User clicks "Login with Discord" → GET /auth/discord/login
//   2. Server redirects to Discord with client_id + redirect_uri + scope=identify
//   3. Discord redirects back to /auth/discord/callback?code=...
//   4. Server exchanges code for an access_token, fetches the user from Discord
//   5. User info is stored in session; subsequent requests are authenticated

import { Router, type Request, type Response } from "express";
import { env } from "../env.js";
import { tryGetDiscordClient } from "../discord.js";
import { prisma } from "../db.js";
import { hasTier, tierOf } from "../permissions.js";
import type { PermissionTier } from "@prisma/client";

export interface SessionUser {
  discordId: string;
  username: string;
  avatar: string | null;
}

declare module "express-session" {
  interface SessionData {
    user?: SessionUser;
    oauthState?: string;
  }
}

export const authRouter = Router();

function getRedirectUri(): string {
  return env.DISCORD_OAUTH_REDIRECT ?? `http://localhost:${env.WEB_PORT}/auth/discord/callback`;
}

authRouter.get("/discord/login", (req, res) => {
  if (!env.DISCORD_CLIENT_SECRET) {
    return res.status(500).send("Discord OAuth isn't configured — admin needs to set DISCORD_CLIENT_SECRET in .env.");
  }
  // Anti-CSRF token in the OAuth state param
  const state = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: getRedirectUri(),
    response_type: "code",
    scope: "identify",
    state,
    prompt: "none", // skip the consent screen if they've already authorized
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

authRouter.get("/discord/callback", async (req, res) => {
  const code = String(req.query.code ?? "");
  const state = String(req.query.state ?? "");
  if (!code) return res.status(400).send("Missing code from Discord.");
  if (state !== req.session.oauthState) {
    return res.status(400).send("OAuth state mismatch — try logging in again.");
  }
  delete req.session.oauthState;

  if (!env.DISCORD_CLIENT_SECRET) {
    return res.status(500).send("Discord OAuth isn't configured.");
  }

  try {
    // Exchange code for token
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: getRedirectUri(),
      }),
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      return res.status(500).send(`Token exchange failed: ${body.slice(0, 200)}`);
    }
    const tokenJson = (await tokenRes.json()) as { access_token: string };

    // Fetch user identity
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    if (!userRes.ok) {
      return res.status(500).send("Failed to fetch Discord user.");
    }
    const user = (await userRes.json()) as { id: string; username: string; avatar: string | null };

    req.session.user = {
      discordId: user.id,
      username: user.username,
      avatar: user.avatar,
    };

    // Auto-link to Player record: keep displayName fresh if they already have one
    const existing = await prisma.player.findUnique({ where: { discordId: user.id } });
    if (existing && existing.displayName !== user.username) {
      await prisma.player.update({
        where: { id: existing.id },
        data: { displayName: user.username },
      });
    }

    // After login, send them to /me or back to wherever they were going
    const returnTo = (req.session as { returnTo?: string }).returnTo ?? "/me";
    delete (req.session as { returnTo?: string }).returnTo;
    res.redirect(returnTo);
  } catch (err) {
    res.status(500).send(`OAuth callback error: ${(err as Error).message}`);
  }
});

function doLogout(req: Request, res: Response) {
  req.session.destroy(() => {
    // Explicitly clear the session cookie so the browser drops it on disk too,
    // not just the server-side session data. Without this, the browser still
    // sends bl.sid on the next request and we hand it a fresh empty session
    // (functionally logged out, but feels weird because the cookie lingers).
    res.clearCookie("bl.sid");
    res.redirect("/standings");
  });
}
authRouter.post("/logout", doLogout);
authRouter.get("/logout", doLogout);

// Middleware factories ---------------------------------------------------------

export function requireLogin() {
  return (req: Request, res: Response, next: (err?: unknown) => void) => {
    if (req.session.user) return next();
    (req.session as { returnTo?: string }).returnTo = req.originalUrl;
    res.redirect("/auth/discord/login");
  };
}

// For admin routes — works with OAuth (ADMIN tier or above) OR the basic-auth password if set.
export async function adminAuthCheck(req: Request): Promise<boolean> {
  // Path 1: password header (set by basic-auth middleware in server.ts)
  if ((req as { _basicAuthOk?: boolean })._basicAuthOk) return true;

  // Path 2: OAuth session + permission tier
  if (!req.session.user) return false;
  const client = tryGetDiscordClient();
  if (!client) return false;

  // Tier lookup needs the user's guild member info for role checks
  if (env.LEAGUE_OWNER_DISCORD_ID && req.session.user.discordId === env.LEAGUE_OWNER_DISCORD_ID) {
    return true;
  }
  if (!env.DISCORD_GUILD_ID) return false;

  try {
    const guild = await client.guilds.fetch(env.DISCORD_GUILD_ID);
    const member = await guild.members.fetch(req.session.user.discordId);
    return hasTier(member, req.session.user.discordId, "ADMIN");
  } catch {
    return false;
  }
}

export async function currentUserTier(req: Request): Promise<PermissionTier | null> {
  if (!req.session.user) return null;
  const client = tryGetDiscordClient();
  if (!client || !env.DISCORD_GUILD_ID) return null;
  try {
    const guild = await client.guilds.fetch(env.DISCORD_GUILD_ID);
    const member = await guild.members.fetch(req.session.user.discordId);
    return tierOf(member, req.session.user.discordId);
  } catch {
    return null;
  }
}
