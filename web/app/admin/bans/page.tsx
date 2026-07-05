import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Callout } from "@/components/Callout";
import { Input } from "@/components/ui/input";
import { FormSelect } from "@/components/FormSelect";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Button } from "@/components/ui/button";
import { PlayerSearch } from "@/components/PlayerSearch";
import { loadAllPlayersForPicker } from "@/lib/loaders/players";
import { loadBansPage } from "@/lib/loaders/bans";
import { banPlayerAction, unbanPlayerAction, addStrikeAction, removeStrikeAction } from "./actions";

export const dynamic = "force-dynamic";

const DURATIONS = [
  { value: "permanent", label: "Permanent" },
  { value: "1", label: "1 season" },
  { value: "2", label: "2 seasons" },
  { value: "3", label: "3 seasons" },
];

export default async function BansPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  await requireAdmin();
  const { ok, err } = await searchParams;
  const [players, data] = await Promise.all([loadAllPlayersForPicker(), loadBansPage()]);

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/bans" />
      <main>
        <h2 style={{ margin: 0 }}>🚫 Bans &amp; strikes</h2>
        <p className="muted" style={{ marginTop: 4, fontSize: 13 }}>
          A banned player <strong>can&apos;t sign up, be added to a round, opt into reminders, be placed into a
          division, or start/queue any match</strong>. A ban is <strong>permanent</strong> or <strong>for N
          seasons</strong> (auto-lifts once that many seasons have started). It does <strong>not</strong> pull them
          out of a season already in progress — use the division <strong>DQ / void</strong> tools for that. Strikes
          are just a record — they don&apos;t auto-ban; act on them yourself.
        </p>

        {err && <Callout type="danger">{err}</Callout>}
        {ok && <Callout type="success">{ok}</Callout>}

        {/* ---- Ban ---- */}
        <div className="card">
          <strong>Ban a player</strong>
          <form action={banPlayerAction} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start", marginTop: 8 }}>
            <div style={{ flex: "1 1 220px", minWidth: 200 }}>
              <PlayerSearch players={players} name="playerId" placeholder="Search a player (name / @handle / ID)…" />
            </div>
            <div style={{ flex: "0 0 130px" }}>
              <FormSelect name="duration" defaultValue="permanent" options={DURATIONS} />
            </div>
            <Input type="text" name="reason" placeholder="Reason (admin-only, required)" style={{ flex: "2 1 240px" }} />
            <ConfirmButton message="Ban this player? They won't be able to sign up or play for the chosen duration.">
              Ban
            </ConfirmButton>
          </form>
        </div>

        <div className="card">
          <strong>Banned players ({data.banned.filter((b) => b.active).length} active)</strong>
          {data.banned.length === 0 ? (
            <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>Nobody is banned.</p>
          ) : (
            <table style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Type</th>
                  <th>Reason</th>
                  <th style={{ textAlign: "center" }}>Strikes</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.banned.map((b) => (
                  <tr key={b.id} style={{ opacity: b.active ? 1 : 0.55 }}>
                    <td style={{ fontWeight: 500 }}>
                      {b.displayName}
                      <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{b.discordId}</span>
                    </td>
                    <td>
                      <span
                        className="pill"
                        style={{
                          fontSize: 11,
                          background: !b.active
                            ? "rgba(149,165,166,0.18)"
                            : b.banLiftsAtSeasonNumber == null
                            ? "rgba(231,76,60,0.18)"
                            : "rgba(241,196,15,0.18)",
                          color: !b.active ? "var(--muted)" : b.banLiftsAtSeasonNumber == null ? "var(--danger)" : "var(--accent)",
                        }}
                      >
                        {b.durationLabel}
                      </span>
                    </td>
                    <td className="muted" style={{ fontSize: 13 }}>{b.bannedReason ?? "—"}</td>
                    <td style={{ textAlign: "center" }}>{b.strikeCount || "—"}</td>
                    <td style={{ textAlign: "right" }}>
                      <form action={unbanPlayerAction} style={{ display: "inline" }}>
                        <input type="hidden" name="playerId" value={b.id} />
                        <ConfirmButton
                          variant="secondary"
                          message={`Unban ${b.displayName}? They'll be able to sign up and play again.`}
                          style={{ fontSize: 12, padding: "3px 10px" }}
                        >
                          {b.active ? "Unban" : "Clear"}
                        </ConfirmButton>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ---- Strikes ---- */}
        <div className="card">
          <strong>Strikes</strong>
          <p className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
            A running record of infractions (no-shows, DQs, rule breaks) — same list as the Discord{" "}
            <code>/admin strike</code>. They don&apos;t ban anyone automatically; use them to decide when to ban.
          </p>
          <form action={addStrikeAction} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
            <div style={{ flex: "1 1 220px", minWidth: 200 }}>
              <PlayerSearch players={players} name="playerId" placeholder="Search a player to strike…" />
            </div>
            <Input type="text" name="reason" placeholder="What happened (required)" style={{ flex: "2 1 240px" }} />
            <Button type="submit" variant="secondary">Log strike</Button>
          </form>

          {data.strikers.length === 0 ? (
            <p className="muted" style={{ fontSize: 13, margin: "10px 0 0" }}>No strikes on record.</p>
          ) : (
            <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
              {data.strikers.map((p) => (
                <div key={p.playerId} style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                    {p.displayName}
                    <span className="pill" style={{ fontSize: 10, marginLeft: 6, background: "rgba(241,196,15,0.18)", color: "var(--accent)" }}>
                      {p.strikes.length} strike{p.strikes.length === 1 ? "" : "s"}
                    </span>
                    {p.banned && (
                      <span className="pill" style={{ fontSize: 10, marginLeft: 4, background: "rgba(231,76,60,0.18)", color: "var(--danger)" }}>banned</span>
                    )}
                  </div>
                  {p.strikes.map((s) => (
                    <div key={s.id} style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 12, padding: "2px 0" }}>
                      <span className="muted" style={{ minWidth: 74, fontSize: 11 }}>{s.createdAt.toISOString().slice(0, 10)}</span>
                      <span style={{ flex: 1 }}>{s.reason}</span>
                      <span className="muted" style={{ fontSize: 11 }}>by {s.issuedByName}</span>
                      <form action={removeStrikeAction} style={{ display: "inline" }}>
                        <input type="hidden" name="strikeId" value={s.id} />
                        <button type="submit" className="link-action" style={{ color: "var(--muted)" }} title="Remove this strike">✕</button>
                      </form>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
