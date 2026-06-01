import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { SeasonDeckPresetPicker } from "@/components/SeasonDeckPresetPicker";
import { TierEditor } from "@/components/TierEditor";
import { tierColors } from "@/lib/tier-colors";
import { computeStandings } from "@/lib/standings";
import { listGuildTextChannels } from "@/lib/discord";
import {
  activateSeason,
  configureTiers,
  deleteSeason,
  finalizeSignupsForSeason,
  moveDivisionMember,
  openSignupsForSeason,
  renameSeason,
  setSeasonPreset,
  setSeasonVisibility,
} from "../actions";
import { archiveSeasonChannels, bootstrapSeasonDiscord, setSeasonDiscordCategory, setSeasonResultsChannel, setSeasonResultsWebhook } from "../bootstrap-actions";
import { cloneSeasonAsDraft } from "../clone-actions";

export const dynamic = "force-dynamic";

function parseTemplateConfig(json: string) {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.map((e: { name?: unknown; divisionCount?: unknown }) => ({
      name: String(e?.name ?? ""),
      divisionCount: Number(e?.divisionCount) || 1,
    }));
  } catch {
    return [];
  }
}

const DEFAULT_TIERS = [
  { name: "Legendary", divisionCount: 1 },
  { name: "Rare", divisionCount: 6 },
  { name: "Uncommon", divisionCount: 6 },
  { name: "Common", divisionCount: 6 },
];

export default async function SeasonDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ imported?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const { imported } = await searchParams;

  const [season, presets, defaultPreset, signupRound, templatesRaw, lastUsed] = await Promise.all([
    prisma.season.findUnique({
      where: { id },
      include: {
        tiers: { orderBy: { position: "asc" } },
        divisions: {
          orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
          include: {
            tier: true,
            members: { include: { player: true } },
            pairings: { where: { status: "CONFIRMED" } },
          },
        },
        matchConfigPreset: true,
      },
    }),
    prisma.matchConfigPreset.findMany({ orderBy: { name: "asc" } }),
    prisma.matchConfigPreset.findUnique({ where: { name: "Default" } }),
    prisma.signupRound.findFirst({
      where: { resultingSeasonId: id },
      include: { _count: { select: { signups: true } } },
    }),
    prisma.tierTemplate.findMany({ orderBy: [{ isLastUsed: "desc" }, { name: "asc" }] }),
    prisma.tierTemplate.findUnique({ where: { name: "Last used" } }),
  ]);

  if (!season) notFound();

  const templates = templatesRaw.map((t) => ({
    id: t.id,
    name: t.name,
    config: parseTemplateConfig(t.config),
    isLastUsed: t.isLastUsed,
  }));
  const initialTiers = lastUsed ? parseTemplateConfig(lastUsed.config) : DEFAULT_TIERS;

  const totalMembers = season.divisions.reduce((sum, d) => sum + d.members.length, 0);
  const totalConfirmed = season.divisions.reduce((sum, d) => sum + d.pairings.length, 0);
  const totalExpected = season.divisions.reduce((sum, d) => {
    const n = d.members.filter((m) => m.status === "ACTIVE").length;
    return sum + (n < 2 ? 0 : (n * (n - 1)) / 2);
  }, 0);

  // Discord channel picker only needed if no signup round yet
  const guildId = process.env.DISCORD_GUILD_ID;
  const needsChannels = !signupRound && !season.endedAt;
  const channels = needsChannels && guildId ? await listGuildTextChannels(guildId) : [];

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/seasons" />
      <main>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Link href="/admin/seasons" className="muted" style={{ fontSize: 12 }}>← All seasons</Link>
          <form action={renameSeason} style={{ display: "flex", gap: 4 }}>
            <input type="hidden" name="id" value={season.id} />
            <input
              type="text"
              name="name"
              defaultValue={season.name}
              required
              style={{ fontSize: 20, fontWeight: 600, padding: "2px 6px", minWidth: 280 }}
            />
            <button type="submit" className="secondary" style={{ fontSize: 11 }}>Save</button>
          </form>
          {season.isActive && (
            <span className="pill" style={{ background: "rgba(46,204,113,0.2)", color: "#2ecc71" }}>ACTIVE</span>
          )}
          {!season.isActive && !season.endedAt && (
            <span className="pill" style={{ background: "rgba(149,165,166,0.2)", color: "#c0c8cb" }}>Inactive</span>
          )}
          {season.endedAt && (
            <span className="pill" style={{ background: "rgba(231,76,60,0.2)", color: "#e74c3c" }}>Ended</span>
          )}
          <form action={setSeasonVisibility} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            <input type="hidden" name="id" value={season.id} />
            <select
              name="visibility"
              defaultValue={season.visibility}
              style={{
                fontSize: 12,
                padding: "2px 6px",
                background: season.visibility === "INTERNAL" ? "rgba(241,196,15,0.2)" : "rgba(52,152,219,0.2)",
                color: season.visibility === "INTERNAL" ? "#f1c40f" : "#76c7ff",
                border: "1px solid var(--border)",
                borderRadius: 4,
              }}
            >
              <option value="PUBLIC">PUBLIC</option>
              <option value="INTERNAL">INTERNAL</option>
            </select>
            <button type="submit" className="secondary" style={{ fontSize: 11 }}>Save</button>
          </form>
        </div>
        <div className="muted" style={{ marginTop: 4 }}>
          {season.tiers.length} tier(s) · {season.divisions.length} division(s) · {totalMembers} player(s) · {totalConfirmed}/{totalExpected} set(s)
          {season.endedAt && <> · ended {season.endedAt.toISOString().slice(0, 10)}</>}
        </div>

        {imported && (
          <div className="card" style={{ borderColor: "#2ecc71" }}>
            ✓ Bulk import succeeded. Review the divisions below, then flip to PUBLIC and Start the season when ready.
          </div>
        )}

        <LifecycleActions
          season={season}
          round={signupRound}
          channels={channels}
          playerCount={totalMembers}
        />

        <div className="card">
          <strong>Settings</strong>
          <div style={{ marginTop: 8 }}>
            <SeasonDeckPresetPicker
              seasonId={season.id}
              presets={presets}
              initialPresetId={season.matchConfigPresetId}
              defaultPreset={defaultPreset}
              saveAction={setSeasonPreset}
            />
          </div>
          <details style={{ marginTop: 8 }}>
            <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>Discord overrides for this season</summary>
            <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
              <form action={setSeasonDiscordCategory} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="hidden" name="id" value={season.id} />
                <input
                  type="text"
                  name="discordCategoryId"
                  defaultValue={season.discordCategoryId ?? ""}
                  placeholder="Category ID for division channels (auto-created if blank)"
                  style={{ flex: 1, fontSize: 12 }}
                />
                <button type="submit" className="secondary" style={{ fontSize: 11 }}>Save</button>
              </form>
              <form action={setSeasonResultsWebhook} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="hidden" name="id" value={season.id} />
                <input
                  type="text"
                  name="resultsWebhookUrl"
                  defaultValue={season.resultsWebhookUrl ?? ""}
                  placeholder="Results webhook URL (falls back to global if blank)"
                  style={{ flex: 1, fontSize: 12 }}
                />
                <button type="submit" className="secondary" style={{ fontSize: 11 }}>Save</button>
              </form>
              <form action={setSeasonResultsChannel} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="hidden" name="id" value={season.id} />
                <input
                  type="text"
                  name="resultsChannelId"
                  defaultValue={season.resultsChannelId ?? ""}
                  placeholder="Results channel ID for bot-REST fallback (optional)"
                  style={{ flex: 1, fontSize: 12 }}
                />
                <button type="submit" className="secondary" style={{ fontSize: 11 }}>Save</button>
              </form>
            </div>
          </details>
        </div>

        {season.divisions.length === 0 ? (
          <div className="card">
            <strong>⚙ Configure tier shape</strong>
            <p className="muted" style={{ fontSize: 12 }}>
              No divisions yet. {signupRound?._count.signups != null && `${signupRound._count.signups} player(s) signed up so far — `}set the shape to create divisions.
            </p>
            <form action={configureTiers}>
              <input type="hidden" name="seasonId" value={season.id} />
              <TierEditor initial={initialTiers} templates={templates} />
              <button type="submit" style={{ marginTop: 8 }}>Create tiers + divisions</button>
            </form>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
              <h3 style={{ margin: 0 }}>Divisions</h3>
              <Link href={`/admin/seasons/${season.id}/bulk-import`} style={{ marginLeft: "auto" }}>
                <button type="button" className="secondary">📥 Bulk import members + pairings</button>
              </Link>
              <DiscordBootstrap season={season} />
            </div>

            {/* Draft mode: inactive + un-ended season. Show ALL members per division
                with a "Move to..." dropdown so admin can adjust auto-seeded placements
                before starting the league. Active/ended seasons keep the top-3
                standings preview below. */}
            {!season.isActive && !season.endedAt && (
              <div className="card" style={{ background: "rgba(241,196,15,0.08)", borderColor: "#f1c40f", marginTop: 12 }}>
                <strong style={{ color: "#f1c40f" }}>📝 Draft mode</strong>
                <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
                  Review the auto-seeded placements below. Each player has a "Move
                  to…" dropdown — use it to nudge people between divisions. Changes
                  save immediately; you can leave and come back. When you're happy,
                  click <strong>Activate season</strong> at the top to start the league.
                </p>
              </div>
            )}

            {season.tiers.map((tier) => {
              const tierDivs = season.divisions.filter((d) => d.tierId === tier.id);
              const tc = tierColors(tier.position);
              const isDraft = !season.isActive && !season.endedAt;
              return (
                <div key={tier.id} style={{ marginTop: 12 }}>
                  <h4 style={{ margin: "8px 0 4px" }}>
                    <span className="pill" style={{ background: tc.bg, color: tc.fg }}>{tier.name}</span>
                  </h4>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 8 }}>
                    {tierDivs.map((d) => {
                      const standings = computeStandings(d.members.map((m) => m.player), d.pairings);
                      const top3 = standings.slice(0, 3);
                      const expectedSets = d.members.length < 2 ? 0 : (d.members.length * (d.members.length - 1)) / 2;
                      // For draft mode: list of OTHER divisions in this season for the move dropdown.
                      const moveTargets = isDraft
                        ? season.divisions.filter((other) => other.id !== d.id)
                        : [];
                      return (
                        <div key={d.id} className="card" style={{ margin: 0 }}>
                          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                            <strong>
                              <Link href={`/admin/divisions/${d.id}`} style={{ textDecoration: "none" }}>{d.name}</Link>
                            </strong>
                            <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>
                              {d.members.length}/{d.targetSize ?? season.targetGroupSize}
                              {!isDraft && ` · ${d.pairings.length}/${expectedSets} matches`}
                            </span>
                          </div>
                          {isDraft ? (
                            d.members.length === 0 ? (
                              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Empty division.</div>
                            ) : (
                              <table style={{ fontSize: 12, marginTop: 4, width: "100%" }}>
                                <tbody>
                                  {d.members.map((m) => (
                                    <tr key={m.id}>
                                      <td style={{ padding: "2px 4px 2px 0" }}>{m.player.displayName}</td>
                                      <td style={{ padding: "2px 0", textAlign: "right" }}>
                                        <form action={moveDivisionMember} style={{ display: "inline-flex", gap: 2 }}>
                                          <input type="hidden" name="seasonId" value={season.id} />
                                          <input type="hidden" name="playerId" value={m.player.id} />
                                          <select
                                            name="targetDivisionId"
                                            required
                                            defaultValue=""
                                            style={{ fontSize: 11, padding: "1px 4px", maxWidth: 120 }}
                                          >
                                            <option value="" disabled>Move to…</option>
                                            {moveTargets.map((t) => (
                                              <option key={t.id} value={t.id}>{t.name}</option>
                                            ))}
                                          </select>
                                          <button type="submit" className="secondary" style={{ fontSize: 11, padding: "1px 6px" }}>
                                            Go
                                          </button>
                                        </form>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )
                          ) : standings.length > 0 ? (
                            <table style={{ fontSize: 12, marginTop: 4 }}>
                              <tbody>
                                {top3.map((r, i) => (
                                  <tr key={r.player.id}>
                                    <td style={{ width: 18 }}>{i + 1}.</td>
                                    <td>{r.player.displayName}</td>
                                    <td style={{ textAlign: "right" }}><strong>{r.points}</strong></td>
                                  </tr>
                                ))}
                                {standings.length > 3 && (
                                  <tr><td colSpan={3} className="muted" style={{ fontSize: 11 }}>+ {standings.length - 3} more</td></tr>
                                )}
                              </tbody>
                            </table>
                          ) : (
                            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>No members yet.</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </>
        )}

        {season.divisions.length > 0 && (
          <div className="card" style={{ marginTop: 16 }}>
            <strong>🌱 Clone to draft season</strong>
            <p className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
              Spin up a new <em>DRAFT</em> season seeded by this season's current standings —
              top 1 of each division promoted up a tier, bottom 1 relegated, rest stay.
              The clone is created INTERNAL so it stays admin-only; review/adjust in draft
              mode, then activate (or delete) when you're done. Useful for previewing what
              next season looks like without affecting the current one.
            </p>
            <form action={cloneSeasonAsDraft}>
              <input type="hidden" name="sourceSeasonId" value={season.id} />
              <button type="submit" className="secondary">Create draft from this season →</button>
            </form>
          </div>
        )}

        {season.endedAt && season.divisions.some((d) => d.discordChannelId) && (
          <div className="card" style={{ marginTop: 16 }}>
            <strong>📦 Archive Discord channels</strong>
            <p className="muted" style={{ fontSize: 12 }}>
              Season's ended — move every division channel into a <code>📦 {season.name} Archive</code>
              category and lock them (read-only). History stays, channels just stop cluttering
              the active categories. Idempotent — safe to re-run if some channels failed last time.
            </p>
            <form action={archiveSeasonChannels}>
              <input type="hidden" name="id" value={season.id} />
              <button type="submit" className="secondary">Archive division channels →</button>
            </form>
          </div>
        )}

        <details className="card" style={{ marginTop: 16 }}>
          <summary style={{ cursor: "pointer", color: "#e74c3c", fontSize: 12 }}>Danger zone</summary>
          <form action={deleteSeason} style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="hidden" name="id" value={season.id} />
            <span className="muted" style={{ fontSize: 11 }}>Type season name to confirm:</span>
            <input type="text" name="confirm" placeholder={season.name} required style={{ flex: 1, fontSize: 11 }} />
            <button type="submit" style={{ fontSize: 11, background: "#e74c3c", color: "white", border: "none" }}>
              Delete season
            </button>
          </form>
          <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
            Cascades: tiers, divisions, members, pairings. Signup rounds get unlinked but kept.
          </div>
        </details>
      </main>
    </>
  );
}

// ---- Inline components (duplicated from seasons list for now; will dedupe later) ----

interface LifecycleSeason { id: string; name: string; isActive: boolean; endedAt: Date | null }
interface LifecycleRound { id: string; status: string; channelId: string; _count: { signups: number } }
interface LifecycleChannel { id: string; name: string }

function LifecycleActions({
  season, round, channels, playerCount,
}: {
  season: LifecycleSeason; round: LifecycleRound | null; channels: LifecycleChannel[]; playerCount: number;
}) {
  if (season.endedAt) return null; // header pill covers this
  if (season.isActive) {
    return (
      <div className="card">
        <Link href={`/admin/seasons/${season.id}/end`}>
          <button type="button">End season →</button>
        </Link>
      </div>
    );
  }
  if (playerCount > 0) {
    return (
      <div className="card">
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
  if (round && round.status === "CLOSED") {
    return (
      <div className="card">
        <Link href={`/admin/signups/${round.id}/build`}>
          <button type="button"><strong>Build divisions from {round._count.signups} signups →</strong></button>
        </Link>
      </div>
    );
  }
  if (round && round.status === "OPEN") {
    return (
      <div className="card">
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
  return (
    <details className="card">
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
    </details>
  );
}

function DiscordBootstrap({
  season,
}: {
  season: { id: string; discordCategoryId: string | null; divisions: Array<{ discordRoleId: string | null; discordChannelId: string | null }> };
}) {
  const total = season.divisions.length;
  const ready = season.divisions.filter((d) => d.discordRoleId && d.discordChannelId).length;
  const remaining = total - ready;
  return (
    <details style={{ marginLeft: 8 }}>
      <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>
        🎭 Discord: {ready}/{total}
      </summary>
      <div style={{ marginTop: 8, padding: 8, background: "var(--surface-2)", borderRadius: 4, display: "grid", gap: 6, minWidth: 320 }}>
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
