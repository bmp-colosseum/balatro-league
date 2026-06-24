import Link from "next/link";
import { notFound } from "next/navigation";
import { hasTier } from "@/lib/admin";
import { loadSeasonDetail } from "@/lib/loaders/seasons";
import { loadAdminSeasonDetail, loadRulesTemplatePickerOptions } from "@/lib/loaders/admin";
import { loadAllPlayersForPicker } from "@/lib/loaders/players";
import { SiteNav } from "@/components/SiteNav";
import { Callout } from "@/components/Callout";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/SubmitButton";
import { Input } from "@/components/ui/input";
import { FormSelect } from "@/components/FormSelect";
import { DraggableDivisionsEditor, type EditorMember, type EditorTier } from "@/components/DraggableDivisionsEditor";
import { LocalDateTimeField } from "@/components/LocalDateTimeField";
import { LocalDateTime } from "@/components/LocalDateTime";
import { SeasonDeckPresetPicker } from "@/components/SeasonDeckPresetPicker";
import { tierColors } from "@/lib/tier-colors";
import { DivisionStandingsTable, type StandingsRowExtras } from "@/components/DivisionStandingsTable";
import { loadMmrForPlayerIds } from "@/lib/loaders/standings";
import { getShowBmpMmr } from "@/lib/preferences";
import { listGuildTextChannels } from "@/lib/discord";
import { formatSeasonLabel } from "@/lib/format-season";
import { setFinalGlobalRank } from "./actions";
import {
  activateSeason,
  clearSeasonScheduledStart,
  deleteSeason,
  finalizeSignupsForSeason,
  reopenSignupsForSeason,
  moveDivisionMember,
  openSignupsForSeason,
  renameSeason,
  setSeasonPreset,
  setSeasonScheduledStart,
  setSeasonScheduledEnd,
  clearSeasonScheduledEnd,
} from "@/app/admin/seasons/actions";
import { setSeasonRulesTemplate } from "@/app/admin/settings/actions";
import {
  archiveSeasonChannels,
  awardSeasonChampionRoles,
  bootstrapSeasonDiscord,
  setSeasonDiscordCategory,
  setSeasonResultsChannel,
  setSeasonResultsWebhook,
  stripSeasonDivisionRoles,
} from "@/app/admin/seasons/bootstrap-actions";
import { ConfirmButton } from "@/components/ConfirmButton";
import { DiscordId } from "@/components/DiscordId";
import { loadServerLeavers, type ServerLeaver } from "@/lib/loaders/server-leavers";
import { addFakePlayer, refreshActiveSeasonMmrs, replacePlayer, swapPlayers } from "@/app/admin/players/actions";

export const dynamic = "force-dynamic";

export default async function SeasonDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; err?: string; imported?: string; "just-built"?: string; swap?: string; swaperr?: string; replace?: string; replaceerr?: string; serverCheck?: string }>;
}) {
  const { id } = await params;
  const { ok, err, imported, ["just-built"]: justBuiltParam, swap, swaperr, replace, replaceerr, serverCheck } = await searchParams;
  const isAdmin = await hasTier("ADMIN");
  const justBuilt = justBuiltParam === "1";

  // Public path: only active OR ended seasons resolve.
  const seasonPublic = await loadSeasonDetail(id);

  // Admin path: load the full draft/active/ended detail incl. signup
  // round, presets, channels, draggable editor context. Falls back to
  // a 404 when not admin AND the public loader had no match.
  const adminData = isAdmin
    ? await loadAdminSeasonDetail(id, {
        listGuildTextChannels,
        guildId: process.env.DISCORD_GUILD_ID,
      })
    : null;

  // Non-admin viewer + draft (not active and not ended) → 404 publicly.
  if (!seasonPublic && !adminData) notFound();

  // On-demand server-membership scan for the roster tools — one Discord API call
  // per active member, so only when the admin clicks "check" on the active season.
  const leavers = adminData?.season.isActive && serverCheck ? await loadServerLeavers() : null;

  // Admin views the FULL admin page; non-admin views the read-only
  // public summary. We always render the public summary when it's
  // available and add admin extras underneath.
  return (
    <>
      <SiteNav activePath="/seasons" />
      <main>
        {seasonPublic ? (
          <PublicSummary
            season={seasonPublic}
            isAdmin={isAdmin}
            ok={ok}
            err={err}
          />
        ) : null}

        {isAdmin && adminData && (
          <AdminSeasonPanel
            adminData={adminData}
            imported={imported}
            justBuilt={justBuilt}
            errParam={err}
            seasonId={id}
            swap={swap}
            swaperr={swaperr}
            replace={replace}
            replaceerr={replaceerr}
            leavers={leavers}
            serverChecked={!!serverCheck}
          />
        )}
      </main>
    </>
  );
}

// ─── Public read-only summary ────────────────────────────────────────

async function PublicSummary({
  season,
  isAdmin,
  ok,
  err,
}: {
  season: NonNullable<Awaited<ReturnType<typeof loadSeasonDetail>>>;
  isAdmin: boolean;
  ok?: string;
  err?: string;
}) {
  const isEnded = !season.isActive && season.endedAt != null;
  const period = season.endedAt
    ? `${season.startedAt.toISOString().slice(0, 10)} → ${season.endedAt.toISOString().slice(0, 10)}`
    : `Started ${season.startedAt.toISOString().slice(0, 10)}`;

  // BMP MMR for the shared standings table (empty unless the preference is on).
  const showBmpMmr = await getShowBmpMmr();
  const { mmrByPlayerId, bmpCurrentSeason } = await loadMmrForPlayerIds(
    season.tiers.flatMap((t) => t.divisions.flatMap((d) => d.rows.map((r) => r.player.id))),
    showBmpMmr,
  );
  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{season.name}</h2>
        {season.isActive ? (
          <span className="pill" style={{ background: "rgba(46,204,113,0.2)", color: "var(--success)" }}>ACTIVE</span>
        ) : (
          <span className="pill" style={{ background: "rgba(149,165,166,0.2)", color: "var(--muted)" }}>FINISHED</span>
        )}
        <span className="muted">· {period}</span>
        <Link href="/seasons" style={{ marginLeft: "auto" }}>← all seasons</Link>
      </div>

      {ok && (
        <Callout type="success">✓ Final rank updated.</Callout>
      )}
      {err && (
        <Callout type="danger">{err}</Callout>
      )}
      {isEnded && isAdmin && (
        <p className="muted" style={{ fontSize: 12 }}>
          Admin: you can edit any player&apos;s final rank inline. If this is the most-recent ended
          season, the change also flows into the player&apos;s current rating used by the next
          season build.
        </p>
      )}

      {season.tiers.filter((t) => t.divisions.length > 0).map((tier) => (
        <section key={tier.id} style={{ marginTop: 24 }}>
          <h3 style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span>{tier.name}</span>
            {isAdmin && (
              <Link href="/admin/divisions" className="muted" style={{ fontSize: 11, fontWeight: 400 }}>
                ↑↓ Set promote/relegate per division →
              </Link>
            )}
          </h3>
          <div className="grid grid-2">
            {tier.divisions.map((div) => {
              const extras = new Map<string, StandingsRowExtras>(
                div.rows.map((r) => [r.player.id, { mmr: mmrByPlayerId.get(r.player.id) }]),
              );
              const finalRanks = new Map(div.rows.map((r) => [r.player.id, r.finalGlobalRank]));
              return (
                <div key={div.id} className="card">
                  <strong className="pixel" style={{ fontSize: 18 }}>
                    <Link href={`/divisions/${div.id}`} style={{ textDecoration: "none" }}>{div.name}</Link>
                  </strong>
                  <DivisionStandingsTable
                    rows={div.rows}
                    extras={extras}
                    showBmpMmr={showBmpMmr}
                    bmpCurrentSeason={bmpCurrentSeason}
                    finalRankHeader={isEnded ? "Final rank" : undefined}
                    finalRankCell={
                      isEnded
                        ? (r) => {
                            const fr = finalRanks.get(r.player.id) ?? null;
                            return isAdmin ? (
                              <form action={setFinalGlobalRank} style={{ display: "flex", gap: 4 }}>
                                <input type="hidden" name="seasonId" value={season.id} />
                                <input type="hidden" name="playerId" value={r.player.id} />
                                <Input
                                  type="number"
                                  name="rank"
                                  defaultValue={fr ?? ""}
                                  min={1}
                                  placeholder="—"
                                  style={{ width: 60, fontSize: 12, padding: "1px 4px" }}
                                />
                                <Button type="submit" variant="secondary" size="sm">Save</Button>
                              </form>
                            ) : (
                              <span className="muted">{fr != null ? `#${fr}` : "—"}</span>
                            );
                          }
                        : undefined
                    }
                  />
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </>
  );
}

// ─── Admin panel (folded in from old /admin/seasons/[id]) ────────────

async function AdminSeasonPanel({
  adminData,
  imported,
  justBuilt,
  errParam,
  seasonId,
  swap,
  swaperr,
  replace,
  replaceerr,
  leavers,
  serverChecked,
}: {
  adminData: NonNullable<Awaited<ReturnType<typeof loadAdminSeasonDetail>>>;
  imported: string | undefined;
  justBuilt: boolean;
  errParam: string | undefined;
  seasonId: string;
  swap?: string;
  swaperr?: string;
  replace?: string;
  replaceerr?: string;
  leavers: ServerLeaver[] | null;
  serverChecked: boolean;
}) {
  const {
    season,
    presets,
    defaultPreset,
    signupRound,
    totalMembers,
    totalConfirmed,
    totalExpected,
    channels,
    memberContext,
  } = adminData;

  // Loaded inline (small table, cheap query) — not worth threading
  // through loadAdminSeasonDetail just for this picker.
  const rulesTemplates = await loadRulesTemplatePickerOptions();
  // Existing players for the draft editor's "add existing player" search.
  const allPlayers = await loadAllPlayersForPicker();

  // Season-wide roster tools (active seasons only): swap operates across all
  // divisions, so its pickers list every active member with their division.
  const swappable = season.isActive
    ? season.divisions.flatMap((d) =>
        d.members
          .filter((m) => m.status === "ACTIVE")
          .map((m) => ({ id: m.player.id, label: `${m.player.displayName} · ${d.name}` })),
      )
    : [];
  const divisionOptions = season.divisions.map((d) => ({ value: d.id, label: d.name }));

  return (
    <>
      <div className="card card-accent" style={{ marginTop: 24 }}>
        <strong style={{ color: "var(--accent)" }}>🔧 Admin tools</strong>
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
          Draft editor, lifecycle, settings, and danger zone — only visible to admins.
        </p>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        <Link href="/admin/seasons" className="muted" style={{ fontSize: 12 }}>← All seasons (admin)</Link>
        <h3 style={{ margin: 0, fontSize: 18 }}>Season {season.number}</h3>
        <form action={renameSeason} style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <input type="hidden" name="id" value={season.id} />
          <span className="muted" style={{ fontSize: 12 }}>—</span>
          <Input
            type="text"
            name="subtitle"
            defaultValue={season.subtitle ?? ""}
            placeholder="Optional subtitle (e.g. 'Launch')"
            style={{ fontSize: 14, padding: "2px 6px", minWidth: 240 }}
          />
          <Button type="submit" variant="secondary" size="sm">Save</Button>
        </form>
        {season.isActive && (
          <span className="pill" style={{ background: "rgba(46,204,113,0.2)", color: "var(--success)" }}>ACTIVE</span>
        )}
        {!season.isActive && !season.endedAt && (
          <span className="pill" style={{ background: "rgba(149,165,166,0.2)", color: "var(--muted)" }}>Inactive</span>
        )}
        {season.endedAt && (
          <span className="pill" style={{ background: "rgba(231,76,60,0.2)", color: "var(--danger)" }}>Ended</span>
        )}
      </div>
      <div className="muted" style={{ marginTop: 4 }}>
        {season.tiers.length} {season.tiers.length === 1 ? "tier" : "tiers"} · {season.divisions.length} {season.divisions.length === 1 ? "division" : "divisions"} · {totalMembers} {totalMembers === 1 ? "player" : "players"} · {totalConfirmed}/{totalExpected} {totalExpected === 1 ? "match" : "matches"}
        {season.endedAt && (
          <>
            {" "}·{" "}ended <LocalDateTime iso={season.endedAt.toISOString()} style="date" />
          </>
        )}
      </div>

      {errParam && (
        <Callout type="danger">{errParam}</Callout>
      )}
      {swap === "ok" && (
        <Callout type="success">✓ Players swapped — they&apos;ve traded divisions and schedules.</Callout>
      )}
      {swaperr && (
        <Callout type="danger">Couldn&apos;t swap: {swaperr}</Callout>
      )}
      {replace && (
        <Callout type="success">✓ Replaced: {replace}</Callout>
      )}
      {replaceerr && (
        <Callout type="danger">Couldn&apos;t replace: {replaceerr}</Callout>
      )}

      {imported && (
        <div className="card card-success">
          ✓ Bulk import succeeded. Review the divisions below, then Start the season when ready.
        </div>
      )}

      {season.divisions.length === 0 ? (
        <div className="card">
          <strong>No divisions yet</strong>
          <p className="muted" style={{ fontSize: 12 }}>
            Divisions get built from the signups after you finalize sign-ups —
            do that from <Link href="/admin/seasons">Manage seasons</Link> →
            “Set up divisions from signups” (you set the tier shape there).
            {signupRound?._count.signups != null && ` ${signupRound._count.signups} signed up so far.`}
          </p>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
            <h3 style={{ margin: 0 }}>Divisions</h3>
            <DiscordBootstrap season={season} />
          </div>

          {/* Draft mode: inactive + un-ended season. Show ALL members per division
              with a "Move to..." dropdown so admin can adjust auto-seeded placements
              before starting the league. Active/ended seasons keep the top-3
              standings preview below. */}
          {!season.isActive && !season.endedAt && (
            <>
              <div className="card" style={{ background: justBuilt ? "rgba(46,204,113,0.10)" : "rgba(241,196,15,0.08)", borderColor: justBuilt ? "var(--success)" : "var(--accent)", marginTop: 12 }}>
                <strong style={{ color: justBuilt ? "var(--success)" : "var(--accent)" }}>
                  {justBuilt ? "✓ Season built — review below" : "📝 Draft mode"}
                </strong>{" "}
                <span className="muted" style={{ fontSize: 12 }}>
                  Fine-tune the placement below — changes save instantly — then <strong>Start season →</strong> below.
                </span>
              </div>
              <h4 style={{ margin: "16px 0 2px" }}>Place players into divisions</h4>
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                Drag a player between divisions to reseed them, or use a card&apos;s <strong>+ Add player</strong>.
              </p>
            </>
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
            const editorDivisions = season.divisions.map((d, i) => ({
              id: d.id,
              name: d.name,
              tierId: d.tierId,
              globalIndex: i,
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
                  hiddenMmr: m.player.hiddenMmr ?? null,
                  bmpMmr: ctx?.bmpMmr ?? null,
                  bmpPeak: ctx?.bmpPeak ?? null,
                  bmpPeakSeason: ctx?.bmpPeakSeason ?? null,
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
                allPlayers={allPlayers}
              />
            );
          })()}

          {/* Tier/division summary block used to render here for
              active/ended seasons — top-3 + "+ N more" duplicating
              the per-division standings tables earlier in the file.
              Removed since those tables (W-D-L, Games, medals, per-row
              admin actions, full membership) cover the same ground with
              strictly more info. Draft mode editing remains in the
              DraggableDivisionsEditor above. */}
        </>
      )}

      {season.isActive && (
        <SeasonRosterTools
          seasonId={seasonId}
          swappable={swappable}
          divisionOptions={divisionOptions}
          leavers={leavers}
          serverChecked={serverChecked}
        />
      )}

      {/* Post-season cleanup actions — collapsed by default since
          they only apply to ended seasons and admin runs each at most
          once per season. */}
      {season.endedAt && season.divisions.length > 0 && (
        <details className="card" style={{ marginTop: 16 }}>
          <summary style={{ cursor: "pointer" }}>
            <strong>🧹 Post-season cleanup</strong>
            <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
              archive Discord channels, award champion roles, strip division roles
            </span>
          </summary>
          <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
            {season.divisions.some((d) => d.discordChannelId) && (
              <div>
                <strong>📦 Archive Discord channels</strong>
                <p className="muted" style={{ fontSize: 12 }}>
                  Move every division channel into a <code>📦 {formatSeasonLabel(season)} Archive</code>
                  {" "}category and lock them (read-only). History stays, channels just stop cluttering
                  the active categories. Idempotent.
                </p>
                <form action={archiveSeasonChannels}>
                  <input type="hidden" name="id" value={season.id} />
                  <Button type="submit" variant="secondary">Archive division channels →</Button>
                </form>
              </div>
            )}

            <div>
              <strong style={{ color: "var(--accent)" }}>🏆 Award champion roles</strong>
              <p className="muted" style={{ fontSize: 12 }}>
                Rank-1 finisher in each division gets a permanent
                <code> 🏆 {formatSeasonLabel(season)} · &lt;Division&gt; Champion</code> role. Idempotent;
                tied divisions are skipped until the shootout resolves them.
              </p>
              <form action={awardSeasonChampionRoles}>
                <input type="hidden" name="id" value={season.id} />
                <Button type="submit" variant="secondary">Award champion roles →</Button>
              </form>
            </div>

            {season.divisions.some((d) => d.discordRoleId) && (
              <div>
                <strong>🧹 Strip division roles</strong>
                <p className="muted" style={{ fontSize: 12 }}>
                  Remove the per-division Discord role from every player. Stops role accumulation across
                  seasons; the roles themselves stay for archived channel permissions. Fans out via queue,
                  takes a few minutes for a full season.
                </p>
                <form action={stripSeasonDivisionRoles}>
                  <input type="hidden" name="id" value={season.id} />
                  <Button type="submit" variant="secondary">Strip roles from players →</Button>
                </form>
              </div>
            )}
          </div>
        </details>
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
        <form action={setSeasonRulesTemplate} style={{ marginTop: 8, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <input type="hidden" name="seasonId" value={season.id} />
          <label className="muted" style={{ fontSize: 12 }}>Rules template:</label>
          <FormSelect
            name="leagueRulesTemplateId"
            defaultValue={season.leagueRulesTemplateId ?? ""}
            size="sm"
            options={[
              { value: "", label: "— Use default —" },
              ...rulesTemplates.map((t) => ({ value: t.id, label: `${t.isDefault ? "★ " : ""}${t.name}` })),
            ]}
          />
          <Button type="submit" variant="secondary" size="sm">Save</Button>
          <Link href="/admin/settings" className="muted" style={{ fontSize: 11 }}>Manage templates →</Link>
        </form>
        <div style={{ marginTop: 8 }}>
          <span className="muted" style={{ fontSize: 12 }}>Planned end date</span>
          {season.scheduledEndAt ? (
            <span className="muted" style={{ fontSize: 11 }}>
              {" "}· currently <LocalDateTime iso={season.scheduledEndAt.toISOString()} style="date" />{" "}
              <form action={clearSeasonScheduledEnd} style={{ display: "inline" }}>
                <input type="hidden" name="id" value={season.id} />
                <button type="submit" className="link-action" style={{ color: "var(--danger)", fontSize: 11 }}>clear</button>
              </form>
            </span>
          ) : (
            <span className="muted" style={{ fontSize: 11 }}> · not set</span>
          )}
          <form action={setSeasonScheduledEnd} style={{ display: "flex", gap: 6, alignItems: "flex-end", flexWrap: "wrap", marginTop: 4 }}>
            <input type="hidden" name="id" value={season.id} />
            <LocalDateTimeField name="scheduledEndAt" label="Pick a date & time (your time)" />
            <Button type="submit" variant="secondary" size="sm">Save</Button>
            <span className="muted" style={{ fontSize: 11 }}>Shown to players in check-in DMs. Doesn&apos;t auto-end the season.</span>
          </form>
        </div>
        <details style={{ marginTop: 8 }}>
          <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>Discord overrides for this season</summary>
          <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
            <form action={setSeasonDiscordCategory} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="hidden" name="id" value={season.id} />
              <Input
                type="text"
                name="discordCategoryId"
                defaultValue={season.discordCategoryId ?? ""}
                placeholder="Category ID for division channels (auto-created if blank)"
                style={{ flex: 1, fontSize: 12 }}
              />
              <Button type="submit" variant="secondary" size="sm">Save</Button>
            </form>
            <form action={setSeasonResultsWebhook} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="hidden" name="id" value={season.id} />
              <Input
                type="text"
                name="resultsWebhookUrl"
                defaultValue={season.resultsWebhookUrl ?? ""}
                placeholder="Results webhook URL (falls back to global if blank)"
                style={{ flex: 1, fontSize: 12 }}
              />
              <Button type="submit" variant="secondary" size="sm">Save</Button>
            </form>
            <form action={setSeasonResultsChannel} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="hidden" name="id" value={season.id} />
              <Input
                type="text"
                name="resultsChannelId"
                defaultValue={season.resultsChannelId ?? ""}
                placeholder="Results channel ID for bot-REST fallback (optional)"
                style={{ flex: 1, fontSize: 12 }}
              />
              <Button type="submit" variant="secondary" size="sm">Save</Button>
            </form>
          </div>
        </details>
      </div>

      <details className="card" style={{ marginTop: 16 }}>
        <summary style={{ cursor: "pointer", color: "var(--danger)", fontSize: 12 }}>Danger zone</summary>
        <form action={deleteSeason} style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "center" }}>
          <input type="hidden" name="id" value={season.id} />
          <span className="muted" style={{ fontSize: 11 }}>Type "{formatSeasonLabel(season)}" to confirm:</span>
          <Input type="text" name="confirm" placeholder={formatSeasonLabel(season)} required className="flex-1 text-[11px]" />
          <Button type="submit" variant="destructive" size="sm">
            Delete season
          </Button>
        </form>
        <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
          Cascades: tiers, divisions, members, pairings. Signup rounds get unlinked but kept.
        </div>
      </details>
    </>
  );
}

// Season-wide roster tools, folded in from the retired /admin/players page.
// Per-division add / drop / remove live on each division page; these are the
// moves that span divisions or the whole season: swap, replace-a-leaver, refresh
// BMP MMRs, add a fake player. Active season only — the only one with a live roster.
function SeasonRosterTools({
  seasonId,
  swappable,
  divisionOptions,
  leavers,
  serverChecked,
}: {
  seasonId: string;
  swappable: { id: string; label: string }[];
  divisionOptions: { value: string; label: string }[];
  leavers: ServerLeaver[] | null;
  serverChecked: boolean;
}) {
  const returnTo = `/seasons/${seasonId}`;
  const checkHref = `/seasons/${seasonId}?serverCheck=1`;
  return (
    <div className="card">
      <strong>🔧 Roster tools</strong>
      <p className="muted" style={{ fontSize: 12, margin: "4px 0 12px" }}>
        Season-wide player moves. Per-division add / drop / remove live on each division page.
      </p>

      {swappable.length >= 2 && (
        <div style={{ marginBottom: 16 }}>
          <strong style={{ fontSize: 13 }}>Swap two players</strong>
          <p className="muted" style={{ fontSize: 12, margin: "2px 0 6px" }}>
            Trade two players between their divisions — each takes over the other&apos;s exact schedule, nobody
            else changes. Blocked if either already has a reported result.
          </p>
          <form action={swapPlayers} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <input type="hidden" name="returnTo" value={returnTo} />
            <FormSelect
              name="playerAId"
              defaultValue=""
              options={[{ value: "", label: "— player A —" }, ...swappable.map((p) => ({ value: p.id, label: p.label }))]}
            />
            <span className="muted">↔</span>
            <FormSelect
              name="playerBId"
              defaultValue=""
              options={[{ value: "", label: "— player B —" }, ...swappable.map((p) => ({ value: p.id, label: p.label }))]}
            />
            <ConfirmButton
              message="Swap these two players between their divisions? They'll trade schedules entirely. Blocked if either already has a reported result."
              variant="secondary"
            >
              Swap
            </ConfirmButton>
          </form>
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <strong style={{ fontSize: 13 }}>Left the server?</strong>
        <p className="muted" style={{ fontSize: 12, margin: "2px 0 6px" }}>
          Find active players who&apos;ve left Discord, then replace one with someone new — the replacement
          inherits their exact schedule. Pre-play only: blocked once the departing player has a reported result.
        </p>
        {!serverChecked ? (
          <Link href={checkHref} style={{ fontSize: 13 }}>🔍 Check server membership →</Link>
        ) : !leavers || leavers.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--success)", margin: 0 }}>✓ Everyone in the season is still in the server.</p>
        ) : (
          <table style={{ marginTop: 4 }}>
            <thead><tr><th>Left the server</th><th>Division</th><th>Replace with (Discord ID)</th></tr></thead>
            <tbody>
              {leavers.map((l) => (
                <tr key={l.playerId}>
                  <td><strong>{l.displayName}</strong><DiscordId value={l.discordId} username={null} /></td>
                  <td className="muted">{l.divisionName}</td>
                  <td>
                    <form action={replacePlayer} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <input type="hidden" name="departedPlayerId" value={l.playerId} />
                      <Input name="newDiscordId" required placeholder="Discord ID" className="max-w-40" />
                      <ConfirmButton
                        message={`Replace ${l.displayName} with this person? They take over the exact schedule. Blocked if ${l.displayName} already has a reported result.`}
                        variant="secondary"
                      >
                        Replace
                      </ConfirmButton>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        <form action={refreshActiveSeasonMmrs}>
          <input type="hidden" name="returnTo" value={returnTo} />
          <SubmitButton variant="secondary" size="sm">Refresh BMP MMRs</SubmitButton>
        </form>
        <form action={addFakePlayer} style={{ display: "flex", gap: 6, alignItems: "flex-end", flexWrap: "wrap" }}>
          <input type="hidden" name="returnTo" value={returnTo} />
          <Input name="name" required placeholder="Fake player name" className="max-w-40" />
          <FormSelect
            name="divisionId"
            defaultValue=""
            options={[{ value: "", label: "— no division —" }, ...divisionOptions]}
          />
          <SubmitButton variant="secondary" size="sm">Add fake player</SubmitButton>
        </form>
      </div>
    </div>
  );
}

// Format a Date as a `datetime-local` input value in UTC. The input
// expects "YYYY-MM-DDTHH:mm" with no timezone — the browser interprets
// it in the user's local TZ when submitting, which matches how
// setSeasonScheduledStart parses it back (no Z suffix).
// Server-rendered, so we use UTC to get a stable string; the resulting
// input will display as UTC wall-clock until the user edits it, at
// which point the browser handles their local TZ correctly. Good enough
// — the displayed scheduled time uses LocalDateTime above which IS
// timezone-correct.
function toLocalDatetimeInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// ---- Inline components (duplicated from seasons list for now; will dedupe later) ----

interface LifecycleSeason {
  id: string;
  isActive: boolean;
  endedAt: Date | null;
  scheduledStartAt: Date | null;
}
interface LifecycleRound { id: string; status: string; closedAt: Date | null; channelId: string; _count: { signups: number } }
interface LifecycleChannel { id: string; name: string }

function LifecycleActions({
  season, round, channels, playerCount,
}: {
  season: LifecycleSeason; round: LifecycleRound | null; channels: LifecycleChannel[]; playerCount: number;
}) {
  if (season.endedAt) return null; // header pill covers this
  // Signups are accepted while OPEN, or BUILT-but-still-draft (building doesn't
  // close them). closedAt is the authoritative close signal, independent of build
  // state — so we can offer "close signups" even after the season is built.
  const acceptingSignups = !!round && !round.closedAt && (round.status === "OPEN" || round.status === "BUILT");
  if (season.isActive) {
    return (
      <div className="card">
        <Link href={`/admin/seasons/${season.id}/end`}>
          <Button type="button">End season →</Button>
        </Link>
      </div>
    );
  }
  if (playerCount > 0) {
    return (
      <div className="card">
        {acceptingSignups ? (
          <div style={{ marginBottom: 12, paddingBottom: 12, borderBottom: "1px solid var(--border, rgba(255,255,255,0.08))" }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              🟢 Signups are still open — {round!._count.signups} joined. Anyone who joins now won&apos;t be in your divisions until you re-open the arranger, so close them before you start.
            </div>
            <form action={finalizeSignupsForSeason}>
              <input type="hidden" name="seasonId" value={season.id} />
              <SubmitButton variant="secondary" size="sm">Close signups →</SubmitButton>
            </form>
          </div>
        ) : round?.closedAt ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span className="muted" style={{ fontSize: 11 }}>✓ Signups closed.</span>
            <form action={reopenSignupsForSeason}>
              <input type="hidden" name="seasonId" value={season.id} />
              <Button type="submit" variant="secondary" size="sm" className="text-[11px]">Reopen</Button>
            </form>
          </div>
        ) : null}
        <form action={activateSeason} style={{ display: "inline-flex" }}>
          <input type="hidden" name="id" value={season.id} />
          <SubmitButton><strong>Start season →</strong></SubmitButton>
        </form>
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          {playerCount} {playerCount === 1 ? "player" : "players"} placed. Starting makes this the active season for /standings and /report.
        </div>

        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border, rgba(255,255,255,0.08))" }}>
          <strong style={{ fontSize: 13 }}>Or schedule the start</strong>
          {season.scheduledStartAt ? (
            <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span className="muted" style={{ fontSize: 12 }}>
                Scheduled for <LocalDateTime iso={season.scheduledStartAt.toISOString()} />
              </span>
              <form action={setSeasonScheduledStart} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                <input type="hidden" name="id" value={season.id} />
                <Input
                  type="datetime-local"
                  name="scheduledStartAt"
                  defaultValue={toLocalDatetimeInput(season.scheduledStartAt)}
                  style={{ fontSize: 12 }}
                />
                <Button type="submit" variant="secondary" size="sm">Update</Button>
              </form>
              <form action={clearSeasonScheduledStart}>
                <input type="hidden" name="id" value={season.id} />
                <Button type="submit" variant="secondary" size="sm" className="text-[#e74c3c]">Cancel schedule</Button>
              </form>
            </div>
          ) : (
            <form
              action={setSeasonScheduledStart}
              style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}
            >
              <input type="hidden" name="id" value={season.id} />
              <label className="muted" style={{ fontSize: 12 }}>
                Auto-start at (your local time):
              </label>
              <Input type="datetime-local" name="scheduledStartAt" required style={{ fontSize: 12 }} />
              <Button type="submit" variant="secondary" size="sm">Schedule</Button>
            </form>
          )}
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            The bot auto-activates this season at the scheduled time and posts to the announcements channel.
            You can edit, cancel, or just click <strong>Start season →</strong> above any time before it fires.
          </div>
        </div>
      </div>
    );
  }
  if (round && round.status === "CLOSED") {
    return (
      <div className="card">
        <Link href={`/admin/signups/${round.id}/build`}>
          <Button type="button"><strong>Set up divisions from {round._count.signups} signups →</strong></Button>
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
          <SubmitButton variant="secondary">Finalize signups →</SubmitButton>
        </form>
      </div>
    );
  }
  return (
    <details className="card">
      <summary style={{ cursor: "pointer" }}><strong>Open signups for this season →</strong></summary>
      <form action={openSignupsForSeason} style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
        <input type="hidden" name="seasonId" value={season.id} />
        <FormSelect
          name="channelId"
          required
          triggerClassName="flex-1 min-w-[200px]"
          placeholder="— Pick a Discord channel —"
          options={channels.map((c) => ({ value: c.id, label: `#${c.name}` }))}
        />
        <LocalDateTimeField name="closesAt" label="Signups close (your time, optional)" />
        <SubmitButton disabled={channels.length === 0}>Open signups</SubmitButton>
      </form>
    </details>
  );
}

function DiscordBootstrap({
  season,
}: {
  season: {
    id: string;
    discordCategoryId: string | null;
    divisions: Array<{
      discordRoleId: string | null;
      discordChannelId: string | null;
    }>;
  };
}) {
  const total = season.divisions.length;
  const ready = season.divisions.filter((d) => d.discordRoleId && d.discordChannelId).length;
  const channelsRemaining = total - ready;
  const allDone = channelsRemaining === 0;
  return (
    <details style={{ marginLeft: 8 }}>
      <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>
        🎭 Discord: {ready}/{total} channel{total === 1 ? "" : "s"}
      </summary>
      <div style={{ marginTop: 8, padding: 8, background: "var(--surface-2)", borderRadius: 4, display: "grid", gap: 6, minWidth: 320 }}>
        <form action={bootstrapSeasonDiscord}>
          <input type="hidden" name="id" value={season.id} />
          <Button type="submit" disabled={allDone}>
            {allDone ? "All set up" : `Set up ${channelsRemaining} division(s)`}
          </Button>
        </form>
      </div>
    </details>
  );
}
