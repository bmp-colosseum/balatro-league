import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { loadAdminSeasonsIndex } from "@/lib/loaders/admin";
import { SiteNav } from "@/components/SiteNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormSelect } from "@/components/FormSelect";
import { AdminNav } from "@/components/AdminNav";
import { LocalDateTimeField } from "@/components/LocalDateTimeField";
import {
  activateSeason,
  archiveSeason,
  createSeason,
  deleteSeason,
  finalizeSignupsForSeason,
  openSignupsForSeason,
  updateSignupCloseDate,
  setSeasonPreset,
  unarchiveSeason,
  unendSeason,
} from "./actions";
import { bootstrapSeasonDiscord, setSeasonDiscordCategory } from "./bootstrap-actions";
import { SeasonDeckPresetPicker } from "@/components/SeasonDeckPresetPicker";
import { listGuildTextChannels } from "@/lib/discord";
import { formatSeasonLabel, nextSeasonNumber } from "@/lib/format-season";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function AdminSeasonsPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string; err?: string }>;
}) {
  await requireAdmin();
  const { archived: showArchivedFlag, err } = await searchParams;
  const showArchived = showArchivedFlag === "1";

  const {
    seasons,
    presets,
    defaultPreset,
    roundsBySeason,
    orphanRounds,
    channels,
    archivedCount,
  } = await loadAdminSeasonsIndex({
    showArchived,
    listGuildTextChannels,
    guildId: process.env.DISCORD_GUILD_ID,
  });
  const nextNumber = await nextSeasonNumber(prisma);

  // Timeline ordering: ACTIVE first, then ended descending by endedAt
  // (most-recently-ended is the one whose final standings drive next
  // season's build, so it gets the badge). Pre-active drafts (not yet
  // started) and archived show last. We sort a copy so the existing
  // grid below keeps the loader's order.
  const timelineSeasons = [...seasons].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    const aEnd = a.endedAt?.getTime() ?? 0;
    const bEnd = b.endedAt?.getTime() ?? 0;
    if (aEnd !== bEnd) return bEnd - aEnd;
    return b.startedAt.getTime() - a.startedAt.getTime();
  });
  const mostRecentlyEndedId = timelineSeasons.find((s) => s.endedAt && !s.isActive)?.id ?? null;

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/seasons" />
      <main>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <h2 style={{ margin: 0 }}>Seasons</h2>
          {archivedCount > 0 && (
            <Link href={showArchived ? "/admin/seasons" : "/admin/seasons?archived=1"} className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
              {showArchived ? `← hide archived` : `📦 show ${archivedCount} archived`}
            </Link>
          )}
        </div>

        {err && (
          <div className="card" style={{ borderColor: "#e74c3c", color: "#e74c3c" }}>
            {err}
          </div>
        )}

        {timelineSeasons.length > 0 && (
          <div className="card">
            <strong>Season timeline</strong>
            <p className="muted" style={{ marginTop: 4, fontSize: 12, marginBottom: 8 }}>
              Newest first. The season marked "ratings sourced from here" is
              what next season's build flow reads <code>Player.rating</code>{" "}
              from — every player's global rank was last written when that
              season ended.
            </p>
            <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 4 }}>
              {timelineSeasons.map((s) => {
                const label = formatSeasonLabel(s);
                const isRatingSource = s.id === mostRecentlyEndedId;
                const status = s.isActive
                  ? { label: "ACTIVE", bg: "rgba(46,204,113,0.2)", fg: "#2ecc71" }
                  : s.endedAt
                  ? { label: `ended ${s.endedAt.toISOString().slice(0, 10)}`, bg: "rgba(149,165,166,0.2)", fg: "#c0c8cb" }
                  : { label: "draft", bg: "rgba(241,196,15,0.2)", fg: "#f1c40f" };
                return (
                  <li
                    key={s.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "4px 0",
                      borderBottom: "1px solid var(--border, rgba(255,255,255,0.05))",
                    }}
                  >
                    <Link href={`/seasons/${s.id}`} style={{ textDecoration: "none", fontWeight: 600 }}>
                      {label}
                    </Link>
                    <span className="pill" style={{ background: status.bg, color: status.fg, fontSize: 10 }}>
                      {status.label}
                    </span>
                    {isRatingSource && (
                      <span
                        className="pill"
                        style={{ background: "rgba(118,199,255,0.2)", color: "#76c7ff", fontSize: 10 }}
                        title="Player.rating values were last written by this season's endSeason."
                      >
                        ratings sourced from here
                      </span>
                    )}
                    {s.archivedAt && (
                      <span className="muted" style={{ fontSize: 10 }}>
                        · 📦 archived {s.archivedAt.toISOString().slice(0, 10)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        {orphanRounds.length > 0 && (
          <div className="card" style={{ borderColor: "#76c7ff" }}>
            <strong style={{ color: "#76c7ff" }}>📋 Pending signup rounds ({orphanRounds.length})</strong>
            <p className="muted" style={{ marginTop: 4, fontSize: 12 }}>
              Signup rounds without a built season yet. From a seed script or
              admin closed signups without clicking Build. Click through to
              <code> /admin/signups/&lt;id&gt;/build</code> to assemble the season.
            </p>
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {orphanRounds.map((r) => (
                <li
                  key={r.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "4px 0",
                    borderBottom: "1px solid var(--border, rgba(255,255,255,0.05))",
                  }}
                >
                  <Link
                    href={`/admin/signups/${r.id}/build`}
                    style={{ textDecoration: "none", fontWeight: 600, flex: 1 }}
                  >
                    {r.name}
                  </Link>
                  <span
                    className="pill"
                    style={{
                      background:
                        r.status === "CLOSED"
                          ? "rgba(241,196,15,0.2)"
                          : "rgba(46,204,113,0.2)",
                      color: r.status === "CLOSED" ? "#f1c40f" : "#2ecc71",
                      fontSize: 11,
                    }}
                  >
                    {r.status} · {r.signupCount} signed up
                  </span>
                  <Link
                    href={`/admin/signups/${r.id}/build`}
                    style={{ fontSize: 12 }}
                  >
                    Build →
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-2">
          {seasons.length === 0 ? (
            <div className="muted">No seasons yet.</div>
          ) : seasons.map((s) => {
            const players = s.divisions.reduce((sum, d) => sum + d._count.members, 0);
            const sets = s.divisions.reduce((sum, d) => sum + d._count.matches, 0);
            const tierLine = s.tiers
              .map((t) => `${t.name}: ${t._count.divisions}`)
              .join(" · ");
            return (
              <div key={s.id} className="card">
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Link href={`/seasons/${s.id}`} style={{ fontSize: 16, fontWeight: 600, textDecoration: "none" }}>
                    {formatSeasonLabel(s)} <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>→ manage</span>
                  </Link>
                  {s.isActive ? (
                    <span className="pill" style={{ background: "rgba(46,204,113,0.2)", color: "#2ecc71" }}>ACTIVE</span>
                  ) : (
                    <span className="pill" style={{ background: "rgba(149,165,166,0.2)", color: "#c0c8cb" }}>Inactive</span>
                  )}
                </div>
                <div className="muted" style={{ marginTop: 4 }}>{tierLine}</div>
                <div className="muted">
                  {players} player(s) · {sets} match(es)
                </div>
                <SeasonDeckPresetPicker
                  seasonId={s.id}
                  presets={presets}
                  initialPresetId={s.matchConfigPresetId}
                  defaultPreset={defaultPreset}
                  saveAction={setSeasonPreset}
                />

                {s.divisions.length > 0 ? (
                  <div style={{ marginTop: 8 }}>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Divisions:</div>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {s.divisions.map((d) => (
                        <Link
                          key={d.id}
                          href={`/divisions/${d.id}`}
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
                ) : (
                  <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                    No divisions yet — they get built from the signups once you
                    finalize sign-ups (below). You set the tier shape at that
                    build step.
                  </p>
                )}

                <DiscordBootstrap season={s} />

                {s.divisions.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <Link href={`/admin/seasons/${s.id}/bulk-import`} style={{ fontSize: 12 }}>
                      📥 Bulk import members + pairings (all divisions in one shot)
                    </Link>
                  </div>
                )}

                <LifecycleActions
                  season={s}
                  round={roundsBySeason.get(s.id) ?? null}
                  channels={channels}
                  playerCount={players}
                />

                {s.archivedAt && (
                  <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                    📦 Archived {s.archivedAt.toISOString().slice(0, 10)}
                  </div>
                )}

                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  {s.archivedAt ? (
                    <form action={unarchiveSeason}>
                      <input type="hidden" name="id" value={s.id} />
                      <Button type="submit" variant="secondary" size="sm">Unarchive</Button>
                    </form>
                  ) : (
                    s.endedAt && (
                      <form action={archiveSeason}>
                        <input type="hidden" name="id" value={s.id} />
                        <Button type="submit" variant="secondary" size="sm">📦 Archive</Button>
                      </form>
                    )
                  )}
                </div>

                <details style={{ marginTop: 8 }}>
                  <summary className="muted" style={{ cursor: "pointer", fontSize: 11, color: "#e74c3c" }}>
                    Delete season
                  </summary>
                  <form action={deleteSeason} style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="hidden" name="id" value={s.id} />
                    <span className="muted" style={{ fontSize: 11 }}>Type "{formatSeasonLabel(s)}" to confirm:</span>
                    <Input type="text" name="confirm" placeholder={formatSeasonLabel(s)} required className="flex-1 text-[11px]" />
                    <Button type="submit" variant="destructive" size="sm">
                      Delete
                    </Button>
                  </form>
                  <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
                    Cascades: tiers, divisions, members, pairings. Signup rounds get unlinked but kept.
                  </div>
                </details>
              </div>
            );
          })}
        </div>

        <details className="card" style={{ marginTop: 24 }}>
          <summary style={{ cursor: "pointer" }}>
            <strong>+ Create new season</strong>
            <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
              Next up: Season {nextNumber}
            </span>
          </summary>
          <p className="muted" style={{ marginTop: 8 }}>
            Number is assigned automatically — just an optional subtitle and
            group sizes here. Tiers and divisions are built later, from the
            actual signups, after signups close.
          </p>
          <form action={createSeason}>
            <label>Subtitle <Input name="subtitle" placeholder="Optional subtitle (e.g. 'Launch')" /></label>
            <label>Group size <Input name="targetGroupSize" type="number" min={2} max={20} defaultValue={5} /></label>
            <label>Min group <Input name="minGroupSize" type="number" min={2} max={20} defaultValue={3} /></label>

            <Button type="submit" className="mt-3">Create season</Button>
          </form>
        </details>
      </main>
    </>
  );
}

interface LifecycleSeason {
  id: string;
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
  // Step 1: ended → show date + escape hatch to reopen. Unend doesn't
  // touch ratings; it just clears endedAt so endSeason can re-run if a
  // result was corrected post-end.
  if (season.endedAt) {
    return (
      <div style={{ marginTop: 8 }}>
        <div className="muted" style={{ fontSize: 12 }}>
          ✓ Ended {season.endedAt.toISOString().slice(0, 10)}
        </div>
        <details style={{ marginTop: 4 }}>
          <summary className="muted" style={{ cursor: "pointer", fontSize: 11 }}>
            Unend this season (clears endedAt, ratings untouched)
          </summary>
          <form action={unendSeason} style={{ marginTop: 6 }}>
            <input type="hidden" name="id" value={season.id} />
            <Button type="submit" variant="secondary" size="sm">
              Unend
            </Button>
            <span className="muted" style={{ fontSize: 10, marginLeft: 6 }}>
              Re-running End season afterwards will rewrite Player.rating from this season's standings.
            </span>
          </form>
        </details>
      </div>
    );
  }

  // Step 5: active → end-season button
  if (season.isActive) {
    return (
      <div style={{ marginTop: 8 }}>
        <Link href={`/admin/seasons/${season.id}/end`}>
          <Button type="button">End season →</Button>
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
          <Button type="submit"><strong>Start season →</strong></Button>
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
          <Button type="button"><strong>Build divisions from {round._count.signups} signups →</strong></Button>
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
          <Button type="submit" variant="secondary">Finalize signups →</Button>
        </form>
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: "pointer", fontSize: 12 }} className="muted">Change close date</summary>
          <form action={updateSignupCloseDate} style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap", alignItems: "flex-end" }}>
            <input type="hidden" name="roundId" value={round.id} />
            <LocalDateTimeField name="closesAt" label="New close time (your time — blank = no deadline)" />
            <Button type="submit" variant="secondary">Update</Button>
          </form>
        </details>
      </div>
    );
  }

  // Step 1: no signup round yet → open one
  return (
    <details style={{ marginTop: 8 }}>
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
        <Button type="submit" disabled={channels.length === 0}>Open signups</Button>
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
          <Input
            type="text"
            name="discordCategoryId"
            defaultValue={season.discordCategoryId ?? ""}
            placeholder="(optional — channels at top level if blank)"
            style={{ flex: 1, fontSize: 12 }}
          />
          <Button type="submit" variant="secondary" size="sm">Save</Button>
        </form>
        <form action={bootstrapSeasonDiscord}>
          <input type="hidden" name="id" value={season.id} />
          <Button type="submit" disabled={remaining === 0}>
            {remaining === 0 ? "All divisions ready" : `Set up ${remaining} remaining division(s)`}
          </Button>
        </form>
      </div>
    </details>
  );
}
