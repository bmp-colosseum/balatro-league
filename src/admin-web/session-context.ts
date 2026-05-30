// Compute layout context (who's logged in + are they admin) from the request.
// Routes call this once per render and spread the result into layout({...ctx}).

import type { Request } from "express";
import { adminAuthCheck } from "./auth.js";

export interface SessionUser {
  discordId: string;
  username: string;
  avatar: string | null;
}

export interface SessionContext {
  sessionUser: SessionUser | null;
  isAdmin: boolean;
}

export async function sessionContext(req: Request): Promise<SessionContext> {
  const sessionUser = req.session.user ?? null;
  // Only run the admin check if logged in — otherwise it's a guaranteed false
  // and skipping saves a Discord API roundtrip on every public page render.
  const isAdmin = sessionUser ? await adminAuthCheck(req) : false;
  return { sessionUser, isAdmin };
}
