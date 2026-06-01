// Bearer-token auth for ops-script API endpoints. Designed for scripts
// run from a developer machine / CI / Railway shell that need to
// trigger admin write paths (bulk-fill, seeds, etc) without going
// through the interactive Discord OAuth login the web UI uses.
//
// Setup
//   1. Generate a token: `openssl rand -hex 32`
//   2. Set ADMIN_TOKEN on the web service Variables in Railway
//   3. Set the same value on whatever environment runs the ops scripts
//      (your laptop env, the bot service if scripts run there, etc.)
//
// Endpoints under /api/admin/* call requireAdminToken(req) — returns
// the same shape as the UI's requireAdmin() so the downstream code
// path doesn't care which auth mechanism let them in.

import type { NextRequest } from "next/server";
import type { AuditActor } from "@/lib/audit";

export interface AdminTokenContext {
  user: { discordId: string; name: string | null };
  actor: AuditActor;
}

// Throws if the request doesn't carry a valid Authorization header.
// Returns a synthetic user/actor that downstream actions can use to
// stamp audit entries (so script-triggered writes are distinguishable
// from human admin actions in the audit log).
export function requireAdminToken(req: NextRequest): AdminTokenContext {
  const configured = process.env.ADMIN_TOKEN;
  if (!configured || configured.length < 16) {
    throw new AdminTokenError(503, "Server is not configured with an ADMIN_TOKEN");
  }
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    throw new AdminTokenError(401, "Missing or malformed Authorization header (expected 'Bearer <token>')");
  }
  const presented = auth.slice("Bearer ".length).trim();
  // Constant-time compare so a length mismatch doesn't leak via timing.
  if (presented.length !== configured.length) {
    throw new AdminTokenError(401, "Invalid admin token");
  }
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ configured.charCodeAt(i);
  }
  if (diff !== 0) {
    throw new AdminTokenError(401, "Invalid admin token");
  }
  // Synthetic user — the script doesn't have a real Discord identity.
  // Token prefix in the audit log so admins can tell which script run
  // (or which token, if you rotate) wrote a given row.
  const fingerprint = presented.slice(0, 8);
  const discordId = `script:${fingerprint}`;
  return {
    user: { discordId, name: `script:${fingerprint}` },
    actor: { discordId, displayName: `script:${fingerprint}` },
  };
}

export class AdminTokenError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
