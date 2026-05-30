import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { TierEditor } from "@/components/TierEditor";
import {
  activateSeason,
  createSeason,
  endSeason,
  finalizeSignupsForSeason,
  openSignupsForSeason,
  setSeasonPreset,
  setSeasonVisibility,
} from "./actions";
import { bootstrapSeasonDiscord, setSeasonDiscordCategory } from "./bootstrap-actions";
import { SeasonDeckPresetPicker } from "@/components/SeasonDeckPresetPicker";
import { listGuildTextChannels } from "@/lib/discord";

export const dynamic = "force-dynamic";

const DEFAULT_TIERS = [
  { name: "Legendary", divisionCount: 1 },
  { name: "Rare", divisionCount: 4 },
  { name: "Uncommon", divisionCount: 6 },
  { name: "Common", divisionCount: 6 },
];

function parseTemplateConfig(json: string) {
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

export default async function AdminSeasonsPage() {
  await requireAdmin();

  const [seasons, templatesRaw, lastUsed, presets, defaultPreset, signupRounds] = await Promise.all([
    prisma.season.findMany({
      include: {
        _count: { select: { divisions: true } },
        tiers: { orderBy: { position: "asc" }, include: { _count: { select: { divisions: true } } } },
        divisions: {
          orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
          include: {
            tier: true,
            _count: { select: { members: true, pairings: true } },
          },
        },
        matchConfigPreset: true,
      },
      orderBy: [{ isActive: "desc" }, { startedAt: "desc" }],
    }),
    prisma.tierTemplate.findMany({ orderBy: [{ isLastUsed: "desc" }, { name: "asc" }] }),
    prisma.tierTemplate.findUnique({ where: { name: "Last used" } }),
    prisma.matchConfigPreset.findMany({ orderBy: { name: "asc" } }),
    prisma.matchConfigPreset.findUnique({ where: { name: "Default" } }),
    prisma.signupRound.findMany({
      where: { resultingSeasonId: { not: null } },
      include: { _count: { select: { signups: true } } },
    }),
  ]);

  // discord channels for the "Open signups" picker (only fetched if at least
  // one season is missing a linked round)
  const needsChannels = seasons.some(
    (s) => !s.endedAt && !signupRounds.find((r) => r.resultingSeasonId === s.id),
  );
  const guildId = process.env.DISCORD_GUILD_ID;
  const channels = needsChannels && guildId ? await listGuildTextChannels(guildId) : [];
  const roundsBySeason = new Map(signupRounds.map((r) => [r.resultingSeasonId!, r]));

  const templates = templatesRaw.map((t) => ({
    id: t.id,
    name: t.name,
    config: parseTemplateConfig(t.config),
    isLastUsed: t.isLastUsed,
  }));

  const initial = lastUsed ? parseTemplateConfig(lastUsed.config) : DEFAULT_TIERS;

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/seasons" />
      <main>
        <h2>Seasons</h2>

        <div className="card">
          <strong>Create new season</strong>
          <p className="muted">
            Configure tiers, then submit. Pre-filled with your last-used layout (★). Created as{" "}
            <strong>inactive</strong> — your current active season is untouched.
          </p>
          <form action={createSeason}>
            <label>Name <input name="name" required placeholder="Season 2" /></label>
            <label>Deadline (UTC) <input name="deadline" type="datetime-local" /></label>
            <label>Group size <input name="targetGroupSize" type="number" min={2} max={20} defaultValue={5} /></label>
            <label>Min group <input name="minGroupSize" type="number" min={2} max={20} defaultValue={3} /></label>
            <label>
              Visibility
              <select name="visibility" defaultValue="PUBLIC">
                <option value="PUBLIC">PUBLIC (visible to players)</option>
                <option value="INTERNAL">INTERNAL (admin-only test)</option>
              </select>
            </label>

            <div style={{ flex: "1 1 100%", marginTop: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <strong>Tiers</strong>
                <span style={{ marginLeft: "auto" }}>
                  <Link href="/admin/seasons/templates">
                    <button type="button" className="secondary">Manage templates</button>
                  </Link>
                </span>
              </div>
              <TierEditor initial={initial} templates={templates} />
            </div>

            <button type="submit" style={{ marginTop: 12 }}>Create season</button>
          </form>
        </div>

        <div className="grid grid-2">
          {seasons.length === 0 ? (
            <div className="muted">No seasons yet.</div>
          ) : seasons.map((s) => {
            const players = s.divisions.reduce((sum, d) => sum + d._count.members, 0);
            const sets = s.divisions.reduce((sum, d) => sum + d._count.pairings, 0);
            const tierLine = s.tiers
              .map((t) => `${t.name}: ${t._count.divisions}`)
              .join(" · ");
            return (
              <div key={s.id} className="card">
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 16 }}>{s.name}</strong>
                  {s.isActive ? (
                    <span className="pill" style={{ background: "rgba(46,204,113,0.2)", color: "#2ecc71" }}>ACTIVE</span>
                  ) : (
                    <span className="pill" style={{ background: "rgba(149,165,166,0.2)", color: "#c0c8cb" }}>Inactive</span>
                  )}
                  <form action={setSeasonVisibility} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                    <input type="hidden" name="id" value={s.id} />
                    <select
                      name="visibility"
                      defaultValue={s.visibility}
                      style={{
                        fontSize: 11,
                        padding: "2px 4px",
                        background: s.visibility === "INTERNAL" ? "rgba(241,196,15,0.2)" : "rgba(52,152,219,0.2)",
                        color: s.visibility === "INTERNAL" ? "#f1c40f" : "#76c7ff",
                        border: "1px solid var(--border)",
                        borderRadius: 4,
                      }}
                    >
                      <option value="PUBLIC">PUBLIC</option>
                      <option value="INTERNAL">INTERNAL</option>
                    </select>
                    <button type="submit" className="secondary" style={{ fontSize: 11, padding: "2px 6px" }}>Save</button>
                  </form>
                </div>
                <div className="muted" style={{ marginTop: 4 }}>{tierLine}</div>
                <div className="muted">
                  {players} player(s) · {sets} set(s) · group size {s.targetGroupSize} (min {s.minGroupSize})
                </div>
                <SeasonDeckPresetPicker
                  seasonId={s.id}
                  presets={presets}
                  initialPresetId={s.matchConfigPresetId}
                  defaultPreset={defaultPreset}
                  saveAction={setSeasonPreset}
                />

                {s.divisions.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Divisions:</div>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {s.divisions.map((d) => (
                        <Link
                          key={d.id}
                          href={`/admin/divisions/${d.id}`}
                          style={{
                            fontSize: 11,
                            padding: "2px 8px",
                            borderRadius: 3,
                            background: "var(--surface-2, rgba(255,255,255,0.05))",
                            textDecoration: "none",
                          }}
                        >
                          {d.name} <span className="muted">({d._count.members})</span>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}

                <DiscordBootstrap season={s} />
                <LifecycleActions
                  season={s}
                  round={roundsBySeason.get(s.id) ?? null}
                  channels={channels}
                  playerCount={players}
                />
              </div>
            );
          })}
        </div>
      </main>
    </>
  );
}

interface LifecycleSeason {
  id: string;
  name: string;
  isActive: boolean;
  endedAt: Date | null;
}
interface LifecycleRound {
  id: string;
  status: "OPEN" | "CLOSED" | "BUILT";
  channelId: string;
  _count: { signups: number };
}
interface LifecycleChannel { id: string; name: string }

function LifecycleActions({
  season,
  round,
  channels,
  playerCount,
}: {
  season: LifecycleSeason;
  round: LifecycleRound | null;
  channels: LifecycleChannel[];
  playerCount: number;
}) {
  // Step 1: ended → just show date
  if (season.endedAt) {
    return (
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        ✓ Ended {season.endedAt.toISOString().slice(0, 10)}
      </div>
    );
  }

  // Step 5: active → end-season button
  if (season.isActive) {
    return (
      <div style={{ marginTop: 8 }}>
        <Link href={`/admin/seasons/${season.id}/end`}>
          <button type="button">End season →</button>
        </Link>
      </div>
    );
  }

  // Step 4: divisions populated → start (activate)
  if (playerCount > 0) {
    return (
      <div style={{ marginTop: 8 }}>
        <form action={activateSeason}>
          <input type="hidden" name="id" value={season.id} />
          <button type="submit"><strong>Start season →</strong></button>
        </form>
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          {playerCount} player(s) placed. Starting flips this to the active season for /standings + /report.
        </div>
      </div>
    );
  }

  // Step 3: signups CLOSED → build divisions
  if (round && round.status === "CLOSED") {
    return (
      <div style={{ marginTop: 8 }}>
        <Link href={`/admin/signups/${round.id}/build`}>
          <button type="button"><strong>Build divisions from {round._count.signups} signups →</strong></button>
        </Link>
      </div>
    );
  }

  // Step 2: signups OPEN → show status + finalize button
  if (round && round.status === "OPEN") {
    return (
      <div style={{ marginTop: 8 }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
          🟢 Signups open in <code>#{channels.find((c) => c.id === round.channelId)?.name ?? round.channelId}</code> — {round._count.signups} joined
        </div>
        <form action={finalizeSignupsForSeason}>
          <input type="hidden" name="seasonId" value={season.id} />
          <button type="submit" className="secondary">Finalize signups →</button>
        </form>
      </div>
    );
  }

  // Step 1: no signup round yet → open one
  return (
    <details style={{ marginTop: 8 }}>
      <summary style={{ cursor: "pointer" }}><strong>Open signups for this season →</strong></summary>
      <form action={openSignupsForSeason} style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
        <input type="hidden" name="seasonId" value={season.id} />
        <select name="channelId" required style={{ flex: "1 1 200px" }}>
          <option value="">— Pick a Discord channel —</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>#{c.name}</option>
          ))}
        </select>
        <button type="submit" disabled={channels.length === 0}>Open signups</button>
      </form>
      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
        Posts a signup embed in the channel. Players click Sign Up; you Finalize when ready, then Build divisions from the signups.
      </div>
    </details>
  );
}

function DiscordBootstrap({
  season,
}: {
  season: {
    id: string;
    discordCategoryId: string | null;
    divisions: Array<{ discordRoleId: string | null; discordChannelId: string | null }>;
  };
}) {
  const total = season.divisions.length;
  const ready = season.divisions.filter((d) => d.discordRoleId && d.discordChannelId).length;
  const remaining = total - ready;
  return (
    <details style={{ marginTop: 8 }}>
      <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>
        Discord channels & roles: {ready} / {total} set up
      </summary>
      <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
        <form action={setSeasonDiscordCategory} style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="hidden" name="id" value={season.id} />
          <label className="muted" style={{ fontSize: 12 }}>Category ID:</label>
          <input
            type="text"
            name="discordCategoryId"
            defaultValue={season.discordCategoryId ?? ""}
            placeholder="(optional — channels at top level if blank)"
            style={{ flex: 1, fontSize: 12 }}
          />
          <button type="submit" className="secondary" style={{ fontSize: 12 }}>Save</button>
        </form>
        <form action={bootstrapSeasonDiscord}>
          <input type="hidden" name="id" value={season.id} />
          <button type="submit" disabled={remaining === 0} style={{ fontSize: 12 }}>
            {remaining === 0 ? "All divisions ready" : `Set up ${remaining} remaining division(s)`}
          </button>
        </form>
      </div>
    </details>
  );
}
