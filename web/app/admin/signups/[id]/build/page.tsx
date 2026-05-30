import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { TierEditor } from "@/components/TierEditor";
import { addSignupByDiscordId, buildSeason, saveRatings } from "./actions";

export const dynamic = "force-dynamic";

interface TierConfig {
  name: string;
  divisionCount: number;
}

const DEFAULT_TIERS: TierConfig[] = [
  { name: "Legendary", divisionCount: 1 },
  { name: "Rare", divisionCount: 4 },
  { name: "Uncommon", divisionCount: 6 },
  { name: "Common", divisionCount: 6 },
];

function parseTemplateConfig(json: string): TierConfig[] {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.map((e) => ({
      name: String(e?.name ?? ""),
      divisionCount: Number(e?.divisionCount) || 1,
    }));
  } catch {
    return [];
  }
}

export default async function BuildSeasonPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ err?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const { err } = await searchParams;

  const [round, templatesRaw, lastUsed, presets] = await Promise.all([
    prisma.signupRound.findUnique({
      where: { id },
      include: { signups: { where: { withdrawn: false }, orderBy: { signedUpAt: "asc" } } },
    }),
    prisma.tierTemplate.findMany({ orderBy: [{ isLastUsed: "desc" }, { name: "asc" }] }),
    prisma.tierTemplate.findUnique({ where: { name: "Last used" } }),
    prisma.matchConfigPreset.findMany({ orderBy: { name: "asc" } }),
  ]);

  if (!round) notFound();

  if (round.status === "BUILT") {
    redirect(`/admin/seasons`);
  }

  // Pull current Player rows for any signed-up discord IDs so we can show ratings
  const discordIds = round.signups.map((s) => s.discordId);
  const existingPlayers = await prisma.player.findMany({
    where: { discordId: { in: discordIds } },
  });
  const playerByDiscordId = new Map(existingPlayers.map((p) => [p.discordId, p]));

  const templates = templatesRaw.map((t) => ({
    id: t.id,
    name: t.name,
    config: parseTemplateConfig(t.config),
    isLastUsed: t.isLastUsed,
  }));
  const initialTiers = lastUsed ? parseTemplateConfig(lastUsed.config) : DEFAULT_TIERS;
  const totalSlots = initialTiers.reduce((sum, t) => sum + t.divisionCount * 5, 0);
  const playerCount = round.signups.length;

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/signups" />
      <main>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>Build season from "{round.name}"</h2>
          <span className="pill" style={{ background: "rgba(46,204,113,0.2)", color: "#2ecc71" }}>
            {playerCount} signups
          </span>
          <Link href="/admin/signups" className="muted" style={{ marginLeft: "auto" }}>
            ← Back to signups
          </Link>
        </div>
        <p className="muted">
          Set ratings for everyone (returning + new), pick the tier shape and match preset, and
          click <strong>Build season</strong>. Auto-seed snake-drafts top-ranked players into the
          top tier, balancing skill across divisions within each tier.
        </p>

        {err && (
          <div className="card" style={{ borderColor: "#e74c3c", color: "#e74c3c" }}>
            {err}
          </div>
        )}

        <div className="card">
          <strong>Add player by Discord ID</strong>
          <p className="muted">
            For late additions — bot looks up the member's guild display name; you can
            override before adding. The player will appear in the list below and be
            included when you Build season.
          </p>
          <form action={addSignupByDiscordId} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <input type="hidden" name="roundId" value={round.id} />
            <input
              type="text"
              name="discordId"
              placeholder="Discord ID (17-20 digits)"
              required
              pattern="\d{17,20}"
              style={{ flex: "1 1 200px" }}
            />
            <input
              type="text"
              name="displayName"
              placeholder="Display name override (optional)"
              style={{ flex: "1 1 200px" }}
            />
            <button type="submit">Look up & add</button>
          </form>
        </div>

        <div className="card">
          <strong>Player ratings ({playerCount} signed up)</strong>
          <p className="muted">
            Higher = better. Empty = unrated (treated as lowest). Save here before building so the
            auto-seed picks up your changes.
          </p>
          <form action={saveRatings}>
            <input type="hidden" name="roundId" value={round.id} />
            <table>
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Status</th>
                  <th style={{ width: 120 }}>Rating</th>
                </tr>
              </thead>
              <tbody>
                {round.signups.length === 0 ? (
                  <tr><td colSpan={3} className="muted">No signups in this round.</td></tr>
                ) : round.signups.map((s) => {
                  const player = playerByDiscordId.get(s.discordId);
                  const isReturning = !!player;
                  return (
                    <tr key={s.id}>
                      <td>
                        <strong>{s.displayName}</strong>{" "}
                        <span className="muted" style={{ fontSize: 11 }}>{s.discordId}</span>
                      </td>
                      <td>
                        {isReturning ? (
                          <span className="pill" style={{ background: "rgba(52,152,219,0.2)", color: "#76c7ff" }}>
                            Returning
                          </span>
                        ) : (
                          <span className="pill" style={{ background: "rgba(241,196,15,0.2)", color: "#f1c40f" }}>
                            New
                          </span>
                        )}
                      </td>
                      <td>
                        <input
                          type="number"
                          name={`rating:${s.discordId}`}
                          defaultValue={player?.rating ?? ""}
                          placeholder="unrated"
                          style={{ width: 100 }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <button type="submit" style={{ marginTop: 12 }}>Save ratings</button>
          </form>
        </div>

        <div className="card">
          <strong>Season setup</strong>
          <p className="muted">
            {playerCount} signups · default tier layout = {totalSlots} slots. If signups exceed
            slots, the bottom tier absorbs the overflow.
          </p>
          <form action={buildSeason}>
            <input type="hidden" name="roundId" value={round.id} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <label>
                Season name
                <input name="name" required placeholder={`Season ${new Date().getFullYear()}`} style={{ width: "100%" }} />
              </label>
              <label>
                Deadline (UTC, optional)
                <input name="deadline" type="datetime-local" style={{ width: "100%" }} />
              </label>
              <label>
                Group size
                <input name="targetGroupSize" type="number" min={2} max={20} defaultValue={5} style={{ width: "100%" }} />
              </label>
              <label>
                Min group
                <input name="minGroupSize" type="number" min={2} max={20} defaultValue={3} style={{ width: "100%" }} />
              </label>
              <label>
                Visibility
                <select name="visibility" defaultValue="PUBLIC" style={{ width: "100%" }}>
                  <option value="PUBLIC">PUBLIC (visible to players)</option>
                  <option value="INTERNAL">INTERNAL (admin-only test)</option>
                </select>
              </label>
              <label>
                Match preset
                <select name="matchConfigPresetId" defaultValue="" style={{ width: "100%" }}>
                  <option value="">— Use Default —</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
            </div>

            <div style={{ marginTop: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <strong>Tier layout</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  Pre-filled with your last-used layout (★)
                </span>
                <Link href="/admin/seasons/templates" style={{ marginLeft: "auto" }}>
                  <button type="button" className="secondary">Manage templates</button>
                </Link>
              </div>
              <TierEditor initial={initialTiers} templates={templates} />
            </div>

            <button type="submit" style={{ marginTop: 16 }}>
              Build season + place {playerCount} players
            </button>
          </form>
        </div>
      </main>
    </>
  );
}
