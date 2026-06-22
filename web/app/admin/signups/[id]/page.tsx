import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { loadSignupMmrOverview } from "@/lib/loaders/admin";
import { loadAllPlayersForPicker } from "@/lib/loaders/players";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PlayerSearch } from "@/components/PlayerSearch";
import { SignupMmrTable } from "@/components/SignupMmrTable";
import { Callout } from "@/components/Callout";
import { refreshSignupMmrs, addSignupToRound } from "./actions";

export const dynamic = "force-dynamic";

export default async function SignupMmrPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ refreshing?: string; err?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const { refreshing, err } = await searchParams;
  const data = await loadSignupMmrOverview(id);
  if (!data) notFound();
  const allPlayers = await loadAllPlayersForPicker();

  const { round, rows, withData, withoutData, min, max, median, avg, byTier, bmpCurrentSeason } = data;
  const maxTierCount = Math.max(1, ...byTier.map((t) => t.count));

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/seasons" />
      <main>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>📊 Signup MMR</h2>
          <span style={{ fontSize: 16 }}>{round.name}</span>
          <span className="pill" style={{ background: "rgba(149,165,166,0.2)", color: "var(--muted)" }}>{round.status}</span>
          <span className="muted" style={{ fontSize: 12 }}>{round.signupCount} signed up</span>
          {round.status !== "BUILT" && (
            <span style={{ marginLeft: "auto", display: "inline-flex", gap: 12, fontSize: 13 }}>
              <Link href={`/admin/signups/${round.id}/preview`}>🔬 Preview placement →</Link>
              <Link href={`/admin/signups/${round.id}/build`}>Set up the season →</Link>
            </span>
          )}
        </div>
        <p className="muted" style={{ marginTop: 4, fontSize: 12 }}>
          Each signup&apos;s best balatromp.com ranked MMR (this BMP season, or their most recent one).
          Use it to gauge how strong the pool is before you build divisions.
        </p>

        {refreshing && (
          <Callout type="success">
            ✓ Queued an MMR fetch for {refreshing} signup{refreshing === "1" ? "" : "s"}. It runs in the background (about
            one every few seconds) — refresh this page in a minute to see updated numbers.
          </Callout>
        )}

        {/* Add a sign-up directly — by Discord ID or an existing player. */}
        <div className="card" style={{ display: "grid", gap: 8 }}>
          <strong>➕ Add a sign-up</strong>
          {err && <span style={{ color: "var(--danger)", fontSize: 12 }}>{err}</span>}
          <form action={addSignupToRound} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <input type="hidden" name="roundId" value={round.id} />
            <Input name="discordId" placeholder="Discord ID (17-20 digits)" pattern="\d{17,20}" style={{ flex: "1 1 200px" }} />
            <Input name="displayName" placeholder="Display name (optional)" style={{ flex: "1 1 160px" }} />
            <Button type="submit" variant="secondary" size="sm">Add by Discord ID</Button>
          </form>
          <form action={addSignupToRound} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <input type="hidden" name="roundId" value={round.id} />
            <PlayerSearch players={allPlayers} name="playerId" placeholder="…or add an existing player by name" />
            <Button type="submit" variant="secondary" size="sm">Add player</Button>
          </form>
          <span className="muted" style={{ fontSize: 11 }}>
            Creates a real signup that counts toward the roster. The draft picks them up next time you open the arranger.
          </span>
        </div>

        {/* Summary */}
        <div className="grid grid-3" style={{ marginTop: 12 }}>
          <div className="stat"><div className="label">Signups</div><div className="value">{round.signupCount}</div></div>
          <div className="stat">
            <div className="label">With BMP data</div>
            <div className="value">{withData}{withoutData > 0 && <span className="muted" style={{ fontSize: 13 }}> · {withoutData} none</span>}</div>
          </div>
          <div className="stat"><div className="label">Median MMR</div><div className="value">{median ?? "—"}</div></div>
          <div className="stat"><div className="label">Average MMR</div><div className="value">{avg ?? "—"}</div></div>
          <div className="stat"><div className="label">Range</div><div className="value">{min != null && max != null ? `${min} – ${max}` : "—"}</div></div>
        </div>

        {/* Refresh */}
        <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <span className="muted" style={{ fontSize: 12 }}>
            Numbers come from snapshots captured at signup-close. Fetch fresh ones now if signups are
            still open or you want the latest.
          </span>
          <form action={refreshSignupMmrs}>
            <input type="hidden" name="roundId" value={round.id} />
            <Button type="submit" variant="secondary" size="sm">↻ Refresh MMR from balatromp.com</Button>
          </form>
        </div>

        {/* Tier distribution */}
        <div className="card">
          <strong>Tier distribution</strong>
          {byTier.length === 0 ? (
            <p className="muted" style={{ fontSize: 12, marginTop: 6, marginBottom: 0 }}>
              No ranked-tier data yet for these signups. Try Refresh above.
            </p>
          ) : (
            <div style={{ marginTop: 10 }}>
              {byTier.map((t) => (
                <div key={t.tier} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span className="muted" style={{ width: 110, fontSize: 12, flexShrink: 0 }}>{t.tier}</span>
                  <div style={{ flex: 1, background: "var(--surface-2)", borderRadius: 4, height: 18 }}>
                    <div style={{ width: `${(t.count / maxTierCount) * 100}%`, minWidth: 3, height: "100%", background: "var(--accent-2)", borderRadius: 4 }} />
                  </div>
                  <span style={{ width: 120, fontSize: 12, textAlign: "right", flexShrink: 0 }}>
                    {t.count} · <span className="muted">avg {t.avgMmr}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Roster — sortable (click any column header). */}
        <div className="card">
          <strong>Roster ({rows.length})</strong>
          <SignupMmrTable rows={rows} bmpCurrentSeason={bmpCurrentSeason} />
        </div>
      </main>
    </>
  );
}
