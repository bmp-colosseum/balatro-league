import { timingSafeEqual } from "node:crypto";

// Scoped auth for the cross-service PROFILE resolver ONLY (league <-> tour, resolve a profile by
// Discord id). A dedicated `PROFILE_LOOKUP_TOKEN` shared by both sites -- deliberately NOT the
// full ADMIN_TOKEN -- so if one site is compromised, an attacker can only read the public
// name<->profile mapping, never reach an admin write path on the other. Constant-time compare.
export function requireProfileToken(req: Request): boolean {
  const configured = process.env.PROFILE_LOOKUP_TOKEN;
  if (!configured || configured.length < 16) return false; // unconfigured = closed
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return false;
  const a = Buffer.from(auth.slice("Bearer ".length).trim());
  const b = Buffer.from(configured);
  return a.length === b.length && timingSafeEqual(a, b);
}
