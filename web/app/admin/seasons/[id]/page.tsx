import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { loadAdminSeasonDetail } from "@/lib/loaders/admin";
import { prisma } from "@/lib/prisma";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { DraggableDivisionsEditor, type EditorMember, type EditorTier } from "@/components/DraggableDivisionsEditor";
import { SeasonDeckPresetPicker } from "@/components/SeasonDeckPresetPicker";
import { TierEditor } from "@/components/TierEditor";
import { tierColors } from "@/lib/tier-colors";
import { computeStandings } from "@/lib/standings";
import { listGuildTextChannels } from "@/lib/discord";
import { formatSeasonLabel } from "@/lib/format-season";
import {
  activateSeason,
  addLatePlayerToDivision,
  configureTiers,
  deleteSeason,
  finalizeSignupsForSeason,
  moveDivisionMember,
  openSignupsForSeason,
  renameSeason,
  setSeasonPreset,
} from "../actions";
import { setSeasonRulesTemplate } from "../../settings/actions";
import { archiveSeasonChannels, awardSeasonChampionRoles, bootstrapSeasonDiscord, setSeasonDiscordCategory, setSeasonResultsChannel, setSeasonResultsWebhook, stripSeasonDivisionRoles } from "../bootstrap-actions";

export const dynamic = "force-dynamic";

export default async function SeasonDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ imported?: string; "just-built"?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  const imported = sp.imported;
  const justBuilt = sp["just-built"] === "1";
  // Loaded inline (small table, cheap query) — not worth threading
  // through loadAdminSeasonDetail just for this picker.
  const rulesTemplates = await prisma.leagueRulesTemplate.findMany({
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    select: { id: true, name: true, isDefault: true },
  });
  const data = await loadAdminSeasonDetail(id, {
    listGuildTextChannels,
    guildId: process.env.DISCORD_GUILD_ID,
  });
  if (!data) notFound();
  const {
    season,
    presets,
    defaultPreset,
    signupRound,
    templates,
    initialTiers,
    totalMembers,
    totalConfirmed,
    totalExpected,
    channels,
    memberContext,
  } = data;

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/seasons" />
      <main>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Link href="/admin/seasons" className="muted" style={{ fontSize: 12 }}>← All seasons</Link>
          <h2 style={{ margin: 0, fontSize: 20 }}>Season {season.number}</h2>
          <form action={renameSeason} style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="hidden" name="id" value={season.id} />
            <span className="muted" style={{ fontSize: 12 }}>—</span>
            <input
              type="text"
              name="subtitle"
              defaultValue={season.subtitle ?? ""}
              placeholder="Optional subtitle (e.g. 'Launch')"
              style={{ fontSize: 16, padding: "2px 6px", minWidth: 240 }}
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
        </div>
        <div className="muted" style={{ marginTop: 4 }}>
          {season.tiers.length} tier(s) · {season.divisions.length} division(s) · {totalMembers} player(s) · {totalConfirmed}/{totalExpected} set(s)
          {season.endedAt && <> · ended {season.endedAt.toISOString().slice(0, 10)}</>}
        </div>

        {imported && (
          <div className="card" style={{ borderColor: "#2ecc71" }}>
            ✓ Bulk import succeeded. Review the divisions below, then Start the season when ready.
          </div>
        )}

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
          <form action={setSeasonRulesTemplate} style={{ marginTop: 8, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <input type="hidden" name="seasonId" value={season.id} />
            <label className="muted" style={{ fontSize: 12 }}>Rules template:</label>
            <select name="leagueRulesTemplateId" defaultValue={season.leagueRulesTemplateId ?? ""} style={{ fontSize: 12 }}>
              <option value="">— Use default —</option>
              {rulesTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.isDefault ? "★ " : ""}{t.name}
                </option>
              ))}
            </select>
            <button type="submit" className="secondary" style={{ fontSize: 11 }}>Save</button>
            <Link href="/admin/settings" className="muted" style={{ fontSize: 11 }}>Manage templates →</Link>
          </form>
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
              <div className="card" style={{ background: justBuilt ? "rgba(46,204,113,0.10)" : "rgba(241,196,15,0.08)", borderColor: justBuilt ? "#2ecc71" : "#f1c40f", marginTop: 12 }}>
                <strong style={{ color: justBuilt ? "#2ecc71" : "#f1c40f" }}>
                  {justBuilt ? "✓ Season built — review placements below" : "📝 Draft mode"}
                </strong>
                <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
                  Drag players between divisions until you're happy with the shape. Changes save
                  immediately. When ready, scroll to the bottom of this page and click{" "}
                  <strong>Start season →</strong> to activate.
                </p>
                <details style={{ marginTop: 6 }}>
                  <summary style={{ cursor: "pointer", fontSize: 11, color: "#76c7ff" }}>What can I adjust here?</summary>
                  <ul style={{ marginTop: 4, paddingLeft: 20, fontSize: 12, lineHeight: 1.6 }}>
                    <li><strong>Move players</strong> between divisions with drag-and-drop or the "Move to…" dropdown.</li>
                    <li><strong>Add late signups</strong> via <Link href="/admin/players" style={{ color: "#76c7ff" }}>/admin/players</Link> — Add player + assign division.</li>
                    <li><strong>Rename / delete</strong> the season from the bottom of this page if you need to restart.</li>
                    <li>Once activated, players can run <code>/start-match</code> and standings start updating.</li>
                  </ul>
                </details>
              </div>
            )}

            {/* In draft mode, use the drag-and-drop editor. It owns
                tier headers + member rows + move + late-add forms in
                one client component so cross-division drags work
                without page roundtrips. */}
            {!season.isActive && !season.endedAt && (() => {
              const editorTiers: EditorTier[] = season.tiers.map((t) => ({
                id: t.id,
                name: t.name,
                position: t.position,
                color: tierColors(t.position),
              }));
              const editorDivisions = season.divisions.map((d) => ({
                id: d.id,
                name: d.name,
                tierId: d.tierId,
              }));
              const editorMembers: EditorMember[] = season.divisions.flatMap((d) =>
                d.members.map((m) => {
                  const ctx = memberContext.get(m.player.id);
                  return {
                    id: m.id,
                    playerId: m.player.id,
                    playerName: m.player.displayName,
                    divisionId: d.id,
                    draftOrder: m.draftOrder,
                    leagueRating: ctx?.leagueRating ?? m.player.rating,
                    bmpMmr: ctx?.bmpMmr ?? null,
                    bmpTier: ctx?.bmpTier ?? null,
                    priorFinalGlobalRank: ctx?.priorFinalGlobalRank ?? null,
                  };
                }),
              );
              // Remount key so the client component resets its drag
              // state when the server pushes new placements (e.g. after
              // a move via the dropdown, or rebuild). Otherwise
              // useState(initialMembers) keeps the stale view. Includes
              // draftOrder so within-division reorders also remount.
              const remountKey = editorMembers
                .map((m) => `${m.playerId}@${m.divisionId}#${m.draftOrder}`)
                .join("|");
              return (
                <DraggableDivisionsEditor
                  key={remountKey}
                  seasonId={season.id}
                  tiers={editorTiers}
                  divisions={editorDivisions}
                  initialMembers={editorMembers}
                />
              );
            })()}

            {(season.isActive || season.endedAt) && season.tiers.map((tier) => {
              const tierDivs = season.divisions.filter((d) => d.tierId === tier.id);
              const tc = tierColors(tier.position);
              const isDraft = !season.isActive && !season.endedAt;
              // Tier-level totals so admin sees at a glance how each tier is
              // sized relative to its target (6 per division). Highlights
              // tiers that are below 4 (too small for round-robin) or way
              // over 7 (probably should split).
              const tierMemberCount = tierDivs.reduce((sum, d) => sum + d.members.length, 0);
              const target = tierDivs.length * 6;
              const avgPerDiv = tierDivs.length === 0 ? 0 : tierMemberCount / tierDivs.length;
              const tierWarning =
                tierDivs.length === 0
                  ? null
                  : avgPerDiv < 4
                    ? { color: "#e74c3c", text: "too few players" }
                    : avgPerDiv > 7
                      ? { color: "#e74c3c", text: "too many — consider adding a division" }
                      : avgPerDiv < 5
                        ? { color: "#f1c40f", text: "below target" }
                        : null;
              return (
                <div key={tier.id} style={{ marginTop: 12 }}>
                  <h4 style={{ margin: "8px 0 4px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span className="pill" style={{ background: tc.bg, color: tc.fg }}>{tier.name}</span>
                    <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
                      {tierMemberCount} player{tierMemberCount === 1 ? "" : "s"} across {tierDivs.length} division{tierDivs.length === 1 ? "" : "s"}
                      {tierDivs.length > 0 && ` · ~${avgPerDiv.toFixed(1)}/div (target 5–6, capacity ${target})`}
                    </span>
                    {tierWarning && (
                      <span style={{ fontSize: 11, color: tierWarning.color }}>⚠ {tierWarning.text}</span>
                    )}
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
                              {d.members.length} member{d.members.length === 1 ? "" : "s"}
                              {!isDraft && ` · ${d.pairings.length}/${expectedSets} matches`}
                            </span>
                          </div>
                          {isDraft && d.members.length === 0 && (
                            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Empty division.</div>
                          )}
                          {isDraft && d.members.length > 0 && (
                            <table style={{ fontSize: 12, marginTop: 4, width: "100%" }}>
                              <tbody>
                                {d.members.map((m) => (
                                  <tr key={m.id}>
                                    <td style={{ padding: "2px 4px 2px 0" }}>
                                      <Link href={`/profile/${m.player.id}`} style={{ color: "var(--text)" }}>{m.player.displayName}</Link>
                                    </td>
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
                          )}
                          {isDraft && (
                            <form action={addLatePlayerToDivision} style={{ display: "flex", gap: 4, marginTop: 6, fontSize: 11 }}>
                              <input type="hidden" name="divisionId" value={d.id} />
                              <input
                                type="text"
                                name="discordId"
                                placeholder="+ Discord ID (17-20 digits)"
                                required
                                pattern="\d{17,20}"
                                style={{ flex: 1, fontSize: 11, padding: "1px 4px" }}
                              />
                              <button type="submit" className="secondary" style={{ fontSize: 11, padding: "1px 6px" }}>Add</button>
                            </form>
                          )}
                          {!isDraft && standings.length > 0 && (
                            <table style={{ fontSize: 12, marginTop: 4 }}>
                              <tbody>
                                {top3.map((r, i) => (
                                  <tr key={r.player.id}>
                                    <td style={{ width: 18 }}>{i + 1}.</td>
                                    <td>
                                      <Link href={`/profile/${r.player.id}`} style={{ color: "var(--text)" }}>{r.player.displayName}</Link>
                                    </td>
                                    <td style={{ textAlign: "right" }}><strong>{r.points}</strong></td>
                                  </tr>
                                ))}
                                {standings.length > 3 && (
                                  <tr><td colSpan={3} className="muted" style={{ fontSize: 11 }}>+ {standings.length - 3} more</td></tr>
                                )}
                              </tbody>
                            </table>
                          )}
                          {!isDraft && standings.length === 0 && (
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

        {season.endedAt && season.divisions.some((d) => d.discordChannelId) && (
          <div className="card" style={{ marginTop: 16 }}>
            <strong>📦 Archive Discord channels</strong>
            <p className="muted" style={{ fontSize: 12 }}>
              Season's ended — move every division channel into a <code>📦 {formatSeasonLabel(season)} Archive</code>
              category and lock them (read-only). History stays, channels just stop cluttering
              the active categories. Idempotent — safe to re-run if some channels failed last time.
            </p>
            <form action={archiveSeasonChannels}>
              <input type="hidden" name="id" value={season.id} />
              <button type="submit" className="secondary">Archive division channels →</button>
            </form>
          </div>
        )}

        {season.endedAt && season.divisions.length > 0 && (
          <div className="card" style={{ marginTop: 16, borderColor: "#f1c40f" }}>
            <strong style={{ color: "#f1c40f" }}>🏆 Award champion roles</strong>
            <p className="muted" style={{ fontSize: 12 }}>
              For each division, give the rank-1 finisher a permanent
              <code> 🏆 {formatSeasonLabel(season)} · &lt;Division&gt; Champion</code> role (gold, mentionable).
              Persists forever as a bragging-rights badge. Idempotent: re-running
              after a shootout resolves a previously-skipped tie at #1 will pick
              up just that division. Divisions with unresolved ties at #1 are
              skipped entirely until the shootout fixes the tie.
            </p>
            <form action={awardSeasonChampionRoles}>
              <input type="hidden" name="id" value={season.id} />
              <button type="submit" className="secondary">Award champion roles →</button>
            </form>
          </div>
        )}

        {season.endedAt && season.divisions.some((d) => d.discordRoleId) && (
          <div className="card" style={{ marginTop: 16 }}>
            <strong>🧹 Strip division roles</strong>
            <p className="muted" style={{ fontSize: 12 }}>
              Remove the per-division Discord role from every player who was in this season.
              Stops role accumulation across seasons. Fans out as one job per (player, role)
              through the queue — gentle on Discord, takes a few minutes for a full season.
              The roles themselves stay (so archived channels keep their permission anchor);
              delete them manually in Discord settings if you want a totally clean role list.
            </p>
            <form action={stripSeasonDivisionRoles}>
              <input type="hidden" name="id" value={season.id} />
              <button type="submit" className="secondary">Strip roles from players →</button>
            </form>
          </div>
        )}

        <LifecycleActions
          season={season}
          round={signupRound}
          channels={channels}
          playerCount={totalMembers}
        />

        <details className="card" style={{ marginTop: 16 }}>
          <summary style={{ cursor: "pointer", color: "#e74c3c", fontSize: 12 }}>Danger zone</summary>
          <form action={deleteSeason} style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="hidden" name="id" value={season.id} />
            <span className="muted" style={{ fontSize: 11 }}>Type "{formatSeasonLabel(season)}" to confirm:</span>
            <input type="text" name="confirm" placeholder={formatSeasonLabel(season)} required style={{ flex: 1, fontSize: 11 }} />
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

interface LifecycleSeason { id: string; isActive: boolean; endedAt: Date | null }
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
