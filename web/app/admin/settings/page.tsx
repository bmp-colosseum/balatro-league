// Admin-tunable league rules. Each field maps to a LeagueConfig key
// read by getLeagueSettings() on both bot and web sides. Cache invalidates
// on save (web side immediately; bot side within ~30s via TTL).
//
// Standings cache stamps the scoring config snapshot, so changing
// PointsFor* prompts a full standings recompute as part of the save.

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import {
  DEFAULTS,
  getLeagueSettings,
  invalidateLeagueSettingsCache,
} from "@/lib/league-settings";
import { prisma } from "@/lib/prisma";
import { recomputeDivisionStandings } from "@/lib/standings-cache";
import { AdminNav } from "@/components/AdminNav";
import { SiteNav } from "@/components/SiteNav";

export const dynamic = "force-dynamic";

const CONFIG_KEYS = {
  PointsFor20Win: "points_for_2_0_win",
  PointsFor11Draw: "points_for_1_1_draw",
  PointsForLoss: "points_for_loss",
  FirstPlayerBans: "first_player_bans",
  SecondPlayerBans: "second_player_bans",
  MatchPoolSize: "match_pool_size",
  MatchInviteExpiryMinutes: "match_invite_expiry_minutes",
  ReportAutoConfirmSeconds: "report_auto_confirm_seconds",
} as const;

export default async function AdminSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  await requireAdmin();
  const { ok, err } = await searchParams;
  const settings = await getLeagueSettings();

  async function saveSettings(formData: FormData) {
    "use server";
    await requireAdmin();
    const session = (formData.get("__discordId") as string) ?? "admin";
    const fields: Array<[keyof typeof CONFIG_KEYS, number, number]> = [
      ["PointsFor20Win", parseInt(String(formData.get("PointsFor20Win") ?? ""), 10), 0],
      ["PointsFor11Draw", parseInt(String(formData.get("PointsFor11Draw") ?? ""), 10), 0],
      ["PointsForLoss", parseInt(String(formData.get("PointsForLoss") ?? ""), 10), 0],
      ["FirstPlayerBans", parseInt(String(formData.get("FirstPlayerBans") ?? ""), 10), 1],
      ["SecondPlayerBans", parseInt(String(formData.get("SecondPlayerBans") ?? ""), 10), 0],
      ["MatchPoolSize", parseInt(String(formData.get("MatchPoolSize") ?? ""), 10), 3],
      ["MatchInviteExpiryMinutes", parseInt(String(formData.get("MatchInviteExpiryMinutes") ?? ""), 10), 1],
      ["ReportAutoConfirmSeconds", parseInt(String(formData.get("ReportAutoConfirmSeconds") ?? ""), 10), 0],
    ];
    for (const [name, value, min] of fields) {
      if (!Number.isFinite(value) || value < min) {
        const { redirect } = await import("next/navigation");
        redirect(`/admin/settings?err=${encodeURIComponent(`${name} must be an integer >= ${min}`)}`);
      }
    }
    // Cross-field sanity: pool must leave at least 1 combo to pick from.
    const first = fields.find((f) => f[0] === "FirstPlayerBans")![1];
    const second = fields.find((f) => f[0] === "SecondPlayerBans")![1];
    const pool = fields.find((f) => f[0] === "MatchPoolSize")![1];
    if (pool - first - second < 1) {
      const { redirect } = await import("next/navigation");
      redirect(`/admin/settings?err=${encodeURIComponent("Pool size must leave at least 1 combo after both players ban")}`);
    }

    await prisma.$transaction(
      fields.map(([name, value]) =>
        prisma.leagueConfig.upsert({
          where: { key: CONFIG_KEYS[name] },
          create: { key: CONFIG_KEYS[name], value: String(value), updatedBy: session },
          update: { value: String(value), updatedBy: session },
        }),
      ),
    );
    invalidateLeagueSettingsCache();

    // Scoring change ⇒ standings cache is now stale. Recompute every
    // active-season division so /standings reflects the new rules
    // without waiting for the next pairing write.
    const activeDivisions = await prisma.division.findMany({
      where: { season: { isActive: true } },
      select: { id: true },
    });
    for (const d of activeDivisions) {
      await recomputeDivisionStandings(d.id).catch(() => {});
    }

    revalidatePath("/admin/settings");
    revalidatePath("/standings");
    const { redirect } = await import("next/navigation");
    redirect("/admin/settings?ok=1");
  }

  return (
    <>
      <SiteNav activePath="" />
      <AdminNav activePath="/admin/settings" />
      <main>
        <h2>League settings</h2>
        <p className="muted" style={{ fontSize: 12 }}>
          Tunable rules. Changes take effect immediately for new matches and reports;
          in-flight matches keep the policy they were created with. Changing scoring
          triggers a full standings recompute across the active season.
        </p>

        {ok && (
          <div className="card" style={{ borderColor: "#2ecc71", color: "#2ecc71" }}>
            ✓ Settings saved. Standings recomputed.
          </div>
        )}
        {err && (
          <div className="card" style={{ borderColor: "#e74c3c", color: "#e74c3c" }}>
            {err}
          </div>
        )}

        <form action={saveSettings}>
          <Section title="Scoring">
            <Field name="PointsFor20Win" label="Points for a 2-0 win" value={settings.scoring.pointsFor20Win} fallback={DEFAULTS.scoring.pointsFor20Win} />
            <Field name="PointsFor11Draw" label="Points for a 1-1 draw" value={settings.scoring.pointsFor11Draw} fallback={DEFAULTS.scoring.pointsFor11Draw} />
            <Field name="PointsForLoss" label="Points for a 0-2 loss" value={settings.scoring.pointsForLoss} fallback={DEFAULTS.scoring.pointsForLoss} />
          </Section>

          <Section title="Match ban / pick">
            <p className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
              Flow: first bans 1 → second bans <em>SecondPlayerBans</em> → first bans (FirstPlayerBans − 1) → second picks from the remainder.
              Constraint: PoolSize − FirstPlayerBans − SecondPlayerBans ≥ 1.
            </p>
            <Field name="FirstPlayerBans" label="First player total bans" value={settings.matchPolicy.firstPlayerBans} fallback={DEFAULTS.matchPolicy.firstPlayerBans} />
            <Field name="SecondPlayerBans" label="Second player total bans" value={settings.matchPolicy.secondPlayerBans} fallback={DEFAULTS.matchPolicy.secondPlayerBans} />
            <Field name="MatchPoolSize" label="Combo pool size" value={settings.matchPolicy.poolSize} fallback={DEFAULTS.matchPolicy.poolSize} />
          </Section>

          <Section title="Timeouts">
            <Field name="MatchInviteExpiryMinutes" label="Match invite expiry (minutes)" value={settings.matchInviteExpiryMinutes} fallback={DEFAULTS.matchInviteExpiryMinutes} />
            <Field name="ReportAutoConfirmSeconds" label="Report auto-confirm grace (seconds)" value={settings.reportAutoConfirmSeconds} fallback={DEFAULTS.reportAutoConfirmSeconds} />
          </Section>

          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button type="submit">Save settings</button>
          </div>
        </form>
      </main>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <strong>{title}</strong>
      <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 120px", gap: 6, alignItems: "center" }}>
        {children}
      </div>
    </div>
  );
}

function Field({
  name,
  label,
  value,
  fallback,
}: {
  name: string;
  label: string;
  value: number;
  fallback: number;
}) {
  return (
    <>
      <label htmlFor={name}>
        {label}
        {value !== fallback && (
          <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
            (default {fallback})
          </span>
        )}
      </label>
      <input
        id={name}
        name={name}
        type="number"
        defaultValue={value}
        min={0}
        required
        style={{ width: "100%" }}
      />
    </>
  );
}
