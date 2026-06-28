import Link from "next/link";
import { Check, X, AlertTriangle, Info } from "lucide-react";
import { getEnvHealth, type VarRow } from "@/lib/env-health";
import { Callout } from "@/components/Callout";

export const dynamic = "force-dynamic";
export const metadata = { title: "Env health · Team Tour" };

// Diagnostics page — shows env-var PRESENCE (never values), live DB reachability, and
// the signed-in viewer's resolved tier. Intentionally readable without admin so the
// "I deployed but I'm not admin" bootstrap case is debuggable; full view needs sign-in.
const ICON = { ok: Check, warn: AlertTriangle, error: X, info: Info } as const;
const COLOR = { ok: "var(--success)", warn: "var(--accent-2)", error: "var(--danger)", info: "var(--muted)" } as const;

function Row({ v }: { v: VarRow }) {
  const I = ICON[v.level];
  return (
    <tr>
      <td><code>{v.key}</code></td>
      <td style={{ color: v.set ? "var(--success)" : v.level === "error" ? "var(--danger)" : "var(--muted)" }}>{v.set ? "set" : "— missing"}</td>
      <td><I className="inline size-3.5 align-text-bottom" style={{ color: COLOR[v.level] }} /></td>
      <td className="sub">{v.note}</td>
    </tr>
  );
}

export default async function EnvHealth() {
  const h = await getEnvHealth();
  const loginVars = h.vars.filter((v) => ["DATABASE_URL", "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "AUTH_SECRET"].includes(v.key));

  return (
    <main>
      <p><Link href="/admin" className="inline-flex items-center gap-1">← admin</Link></p>
      <h1>Env health</h1>
      <p className="sub">Deploy diagnostics — which env vars are set (never their values), is the database reachable, and what tier you resolve to. <code>NODE_ENV={h.nodeEnv}</code></p>

      {h.warnings.length > 0 ? (
        <Callout type="danger">
          <strong>Needs attention:</strong>
          <ul className="mt-1 mb-0">{h.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </Callout>
      ) : (
        <Callout type="success">All core checks pass — DB reachable, login + admin env present.</Callout>
      )}

      {/* Database */}
      <div className="card">
        <div className="bracket-title">Database</div>
        {h.db.reachable
          ? <p style={{ color: "var(--success)" }}><Check className="inline size-4 align-text-bottom" /> Reachable — schema is live.</p>
          : <p style={{ color: "var(--danger)" }}><X className="inline size-4 align-text-bottom" /> Not reachable: <span className="sub">{h.db.error}</span></p>}
      </div>

      {/* You */}
      <div className="card">
        <div className="bracket-title">You</div>
        {h.viewer.authenticated ? (
          <table>
            <tbody>
              <tr><td>Signed in</td><td style={{ color: "var(--success)" }}>yes</td></tr>
              <tr><td>Discord ID</td><td><code>{h.viewer.discordId ?? "(dev bypass — no Discord)"}</code></td></tr>
              <tr><td>Resolved tier</td><td><strong style={{ color: h.viewer.tier === "OWNER" || h.viewer.tier === "TO" ? "var(--success)" : "var(--accent-2)" }}>{h.viewer.tier}</strong></td></tr>
              <tr><td>In owner list</td><td>{h.viewer.inOwnerList ? "yes" : "no"}</td></tr>
              <tr><td>Linked player</td><td className="sub">{h.viewer.playerId ? <Link href={`/players/${h.viewer.playerId}`}>profile</Link> : "not linked yet"}</td></tr>
            </tbody>
          </table>
        ) : (
          <p className="sub">Not signed in. <Link href="/auth/signin">Sign in</Link> for the full report (your id + tier). The login-critical vars are shown below.</p>
        )}
      </div>

      {/* Env vars — full table when signed in, login-critical subset otherwise */}
      <div className="card">
        <div className="bracket-title">{h.viewer.authenticated ? "Environment" : "Login-critical environment"}</div>
        <table>
          <thead><tr><th>Variable</th><th>Status</th><th></th><th>Purpose</th></tr></thead>
          <tbody>
            {(h.viewer.authenticated ? h.vars : loginVars).map((v) => <Row key={v.key} v={v} />)}
          </tbody>
        </table>
      </div>
    </main>
  );
}
