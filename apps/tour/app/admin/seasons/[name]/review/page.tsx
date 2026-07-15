// Week-by-week review-and-correct hub. Pick a team, step through its weeks (and
// playoffs), and see the derived lineup + each matchup's pairings + results together,
// with the off-seed / empty / short flags called out -- the one place to eyeball a
// season and fix what's wrong. Works for imported flat seasons (TT4) and live ones,
// because getSeasonReview reads TourSet directly. TO-only.
import Link from "next/link";
import { ClipboardCheck, TriangleAlert, UserCog, BellOff, Bell } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { getSeasonReview, getSeasonCorrections, type ReviewMatchup, type ReviewPair, type Correction } from "@/lib/services/review";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { Section } from "@/components/admin/Section";
import { EmptyState } from "@/components/admin/EmptyState";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmButton } from "@/components/ConfirmButton";
import { SeedOrSub } from "@/components/SeedOrSub";
import { fieldInputSm } from "@/components/admin/Field";
import { reportSetAction, clearSetAction, dqSetAction, reassignAction, setSeedAction, removePairAction, addPairAction, dismissAction, undismissAction } from "./actions";

type PlayerOpt = { id: string; name: string };

export const dynamic = "force-dynamic";

const navStyle = (on: boolean) => ({
  padding: "3px 9px",
  borderRadius: 6,
  fontSize: 13,
  border: "1px solid var(--border)",
  background: on ? "var(--accent-2)" : "var(--surface-2)",
  color: on ? "var(--bg)" : "var(--fg)",
  fontWeight: on ? 600 : 400,
});
const dangerBadge = { color: "var(--danger)", borderColor: "var(--danger)" };

export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ team?: string; week?: string }>;
}) {
  if (!(await isAdmin())) {
    return (
      <main>
        <h1>Admin</h1>
        <Callout type="admin">Admins only {"--"} you don&apos;t have access.</Callout>
      </main>
    );
  }
  const { name } = await params;
  const sp = await searchParams;
  const seasonName = decodeURIComponent(name);
  const enc = encodeURIComponent(seasonName);
  const [review, corrections] = await Promise.all([getSeasonReview(seasonName, sp.team), getSeasonCorrections(seasonName)]);
  if (!review) {
    return (
      <main>
        <AdminPageHeader back={{ href: "/admin", label: "admin" }} title="Season not found" />
      </main>
    );
  }

  const { teamSeasonId, teamName, teams, teamPlayers, allPlayers, weeks, offSeedTotal, emptyMatchupCount } = review;
  const selWeek = weeks.find((w) => String(w.week) === sp.week) ?? weeks[0];
  const teamHref = (tsId: string) => `/admin/seasons/${enc}/review?team=${tsId}`;
  const weekHref = (wk: number) => `/admin/seasons/${enc}/review?team=${teamSeasonId}&week=${wk}`;

  return (
    <main>
      <AdminPageHeader
        back={{ href: `/admin/seasons/${enc}`, label: "season" }}
        icon={<ClipboardCheck className="size-5" />}
        title="Review & correct"
        sub={<>Season {seasonName} {"-"} step through a team week by week, verify who played, fix results.</>}
        actions={
          <Link href={`/admin/seasons/${enc}/roster`} className="badge inline-flex items-center gap-1" title="add/drop/sub players, reseed the roster">
            <UserCog className="size-3.5" /> Roster ops
          </Link>
        }
      />

      {(offSeedTotal > 0 || emptyMatchupCount > 0) && (
        <Callout type="danger">
          <TriangleAlert className="inline size-4" />{" "}
          {teamName}: {offSeedTotal > 0 && <>{offSeedTotal} off-seed pairing{offSeedTotal === 1 ? "" : "s"} (&gt;2 apart)</>}
          {offSeedTotal > 0 && emptyMatchupCount > 0 && <> {"|"} </>}
          {emptyMatchupCount > 0 && <>{emptyMatchupCount} empty / all-0-0 matchup{emptyMatchupCount === 1 ? "" : "s"}</>}. Weeks with a flag are marked <b>!</b> below.
        </Callout>
      )}

      <Section title="Team" description="Pick the team to review.">
        <div className="flex flex-wrap gap-1">
          {teams.map((t) => (
            <Link key={t.teamSeasonId} href={teamHref(t.teamSeasonId)} style={navStyle(t.teamSeasonId === teamSeasonId)}>
              #{t.seed} {t.name}
            </Link>
          ))}
        </div>
      </Section>

      {!weeks.length ? (
        <EmptyState>No sets recorded for {teamName} yet.</EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap gap-1" style={{ margin: "12px 0" }}>
            {weeks.map((w) => (
              <Link key={w.week} href={weekHref(w.week)} style={navStyle(w.week === selWeek.week)}>
                {w.tabLabel}
                {w.offSeedCount > 0 ? " !" : ""}
              </Link>
            ))}
          </div>

          <Section title={`${selWeek.label} lineup`} description={`Derived from the roster-move log. ${selWeek.lineup.length} active.`}>
            {selWeek.lineup.length ? (
              <div className="flex flex-wrap gap-2">
                {selWeek.lineup.map((p) => (
                  <span key={p.playerId} className="badge">
                    <SeedOrSub seed={p.seed} isSub={p.viaSub} /> {p.name}
                    {p.isCaptain ? " (C)" : ""}
                  </span>
                ))}
              </div>
            ) : (
              <span className="sub">No lineup derived for this week.</span>
            )}
          </Section>

          {selWeek.matchups.length ? (
            selWeek.matchups.map((m) => (
              <MatchupCard
                key={m.key}
                m={m}
                season={seasonName}
                teamSeasonId={teamSeasonId}
                teamSize={review.teamSize}
                teamPlayers={teamPlayers}
                allPlayers={allPlayers}
              />
            ))
          ) : (
            <EmptyState>No matchup recorded for {teamName} in {selWeek.label}.</EmptyState>
          )}
        </>
      )}

      {corrections && <CorrectionsBoard corrections={corrections} season={seasonName} enc={enc} />}
    </main>
  );
}

const KIND_LABEL: Record<Correction["kind"], string> = {
  OFF_SEED: "Off-seed",
  SHORT: "Short matchup",
  ALL_ZERO: "All 0-0",
};

// The season-wide "corrections needed" punch-list: everything worth a second look
// across ALL teams, each silenceable when it's actually intentional (an off-seed the
// captains agreed to, a genuinely-short week). Silenced items drop to a collapsed list.
function CorrectionsBoard({
  corrections,
  season,
  enc,
}: {
  corrections: NonNullable<Awaited<ReturnType<typeof getSeasonCorrections>>>;
  season: string;
  enc: string;
}) {
  const { active, silenced, activeByKind } = corrections;
  const jump = (c: Correction) =>
    c.teamSeasonId
      ? `/admin/seasons/${enc}/review?team=${c.teamSeasonId}${c.week != null ? `&week=${c.week}` : ""}`
      : null;
  const summary =
    active.length === 0
      ? "Nothing outstanding -- every flag is clean or silenced."
      : [
          activeByKind.OFF_SEED ? `${activeByKind.OFF_SEED} off-seed` : "",
          activeByKind.SHORT ? `${activeByKind.SHORT} short` : "",
          activeByKind.ALL_ZERO ? `${activeByKind.ALL_ZERO} all-0-0` : "",
        ]
          .filter(Boolean)
          .join(" | ");

  return (
    <Section
      title={`Corrections needed: ${active.length}`}
      description={`Every flag across the whole season. Fix it, or silence it if it's intentional. ${summary}`}
      className="mt-4"
    >
      {active.length === 0 ? (
        <span className="sub">All clear. {silenced.length > 0 && `${silenced.length} silenced below.`}</span>
      ) : (
        <div className="flex flex-col gap-1">
          {active.map((c) => (
            <div key={c.key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5" style={{ padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
              <span className="badge" style={dangerBadge}>{KIND_LABEL[c.kind]}{c.gap != null ? ` ${c.gap}` : ""}</span>
              <span className="sub" style={{ minWidth: 42 }}>{c.weekLabel}</span>
              <span>{c.title}</span>
              {jump(c) && (
                <Link href={jump(c)!} className="sub" style={{ marginLeft: "auto" }}>review &rarr;</Link>
              )}
              <ActionFlashForm action={dismissAction} style={jump(c) ? undefined : { marginLeft: "auto" }}>
                <input type="hidden" name="season" value={season} />
                <input type="hidden" name="kind" value={c.kind} />
                <input type="hidden" name="targetId" value={c.targetId} />
                <SubmitButton size="sm" variant="secondary" pendingText="..." title="mark intentional -- stop flagging it">
                  <BellOff className="inline size-3" /> silence
                </SubmitButton>
              </ActionFlashForm>
            </div>
          ))}
        </div>
      )}

      {silenced.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary className="sub" style={{ cursor: "pointer" }}>{silenced.length} silenced (marked intentional)</summary>
          <div className="flex flex-col gap-1" style={{ marginTop: 8 }}>
            {silenced.map((c) => (
              <div key={c.key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5" style={{ padding: "3px 0", borderBottom: "1px solid var(--border)", opacity: 0.7 }}>
                <span className="badge">{KIND_LABEL[c.kind]}{c.gap != null ? ` ${c.gap}` : ""}</span>
                <span className="sub" style={{ minWidth: 42 }}>{c.weekLabel}</span>
                <span className="sub">{c.title}</span>
                <ActionFlashForm action={undismissAction} style={{ marginLeft: "auto" }}>
                  <input type="hidden" name="season" value={season} />
                  <input type="hidden" name="kind" value={c.kind} />
                  <input type="hidden" name="targetId" value={c.targetId} />
                  <SubmitButton size="sm" variant="secondary" pendingText="..." title="put it back on the list">
                    <Bell className="inline size-3" /> un-silence
                  </SubmitButton>
                </ActionFlashForm>
              </div>
            ))}
          </div>
        </details>
      )}
    </Section>
  );
}

function MatchupCard({
  m,
  season,
  teamSeasonId,
  teamSize,
  teamPlayers,
  allPlayers,
}: {
  m: ReviewMatchup;
  season: string;
  teamSeasonId: string;
  teamSize: number;
  teamPlayers: PlayerOpt[];
  allPlayers: PlayerOpt[];
}) {
  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="bracket-title" style={{ padding: 0 }}>vs {m.opponentName}</span>
      <span className="sub">{m.ourSetsWon}-{m.theirSetsWon}{m.decided ? "" : " (in progress)"}</span>
      {m.offSeedCount > 0 && <span className="badge" style={dangerBadge}>! {m.offSeedCount} off-seed</span>}
      {m.short && <span className="badge">short: {m.pairs.length}/{teamSize}</span>}
      {m.noPairs && <span className="badge" style={dangerBadge}>no pairings</span>}
      {m.allZero && !m.noPairs && <span className="badge" style={dangerBadge}>all 0-0</span>}
      {m.matchupId && (
        <Link href={`/admin/matchups/${m.matchupId}`} className="sub" style={{ marginLeft: "auto" }}>
          full console &rarr;
        </Link>
      )}
    </div>
  );
  const template = m.pairs[0];

  return (
    <Section title={header}>
      {m.pairs.length === 0 ? (
        <span className="sub">No pairings recorded.</span>
      ) : (
        <div className="flex flex-col gap-2">
          {m.pairs.map((p) => (
            <PairRow key={p.setId} p={p} season={season} teamSeasonId={teamSeasonId} teamPlayers={teamPlayers} allPlayers={allPlayers} />
          ))}
        </div>
      )}
      {template && (
        <details style={{ marginTop: 8 }}>
          <summary className="sub" style={{ cursor: "pointer" }}>+ add a pairing</summary>
          <ActionFlashForm action={addPairAction} className="flex flex-wrap items-end gap-2" style={{ marginTop: 6 }}>
            <input type="hidden" name="season" value={season} />
            <input type="hidden" name="templateSetId" value={template.setId} />
            <input type="hidden" name="teamSeasonId" value={teamSeasonId} />
            <label className="sub">our player<br />
              <select name="ourPlayerId" className={fieldInputSm} defaultValue="">
                <option value="" disabled>pick</option>
                {teamPlayers.map((tp) => <option key={tp.id} value={tp.id}>{tp.name}</option>)}
              </select>
            </label>
            <label className="sub">seed<br />
              <input type="number" name="ourSeed" min={1} className={`${fieldInputSm} w-16 text-center`} />
            </label>
            <label className="sub">their player<br />
              <select name="theirPlayerId" className={fieldInputSm} defaultValue="">
                <option value="" disabled>pick</option>
                {allPlayers.map((tp) => <option key={tp.id} value={tp.id}>{tp.name}</option>)}
              </select>
            </label>
            <label className="sub">seed<br />
              <input type="number" name="theirSeed" min={1} className={`${fieldInputSm} w-16 text-center`} />
            </label>
            <SubmitButton size="sm" variant="secondary" pendingText="...">Add</SubmitButton>
          </ActionFlashForm>
        </details>
      )}
    </Section>
  );
}

function PairRow({
  p,
  season,
  teamSeasonId,
  teamPlayers,
  allPlayers,
}: {
  p: ReviewPair;
  season: string;
  teamSeasonId: string;
  teamPlayers: PlayerOpt[];
  allPlayers: PlayerOpt[];
}) {
  const theirSlot = p.ourSlot === "A" ? "B" : "A";
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1"
      style={{ padding: "6px 0", borderBottom: "1px solid var(--border)" }}
    >
      {/* our player */}
      <div style={{ minWidth: 230 }}>
        <div className="flex items-center gap-1">
          <SeedEdit season={season} setId={p.setId} slot={p.ourSlot} seed={p.ourSeed} />
          <b>{p.ourName}</b>
          {p.ourIsSub && <span className="sub">(sub)</span>}
        </div>
        {p.reassignedFrom && <span className="sub">was {p.reassignedFrom}</span>}
        <FixPlayer season={season} setId={p.setId} teamSeasonId={teamSeasonId} side="our" current={p.ourPlayerId} options={teamPlayers} />
      </div>

      {/* score + set-level actions */}
      <ActionFlashForm action={reportSetAction} className="flex flex-wrap items-center gap-1">
        <input type="hidden" name="season" value={season} />
        <input type="hidden" name="setId" value={p.setId} />
        <input type="hidden" name="ourSlot" value={p.ourSlot} />
        <input type="number" name="gamesOur" min={0} defaultValue={p.ourGames ?? undefined} className={`${fieldInputSm} w-12 text-center`} />
        <span className="sub">-</span>
        <input type="number" name="gamesTheir" min={0} defaultValue={p.theirGames ?? undefined} className={`${fieldInputSm} w-12 text-center`} />
        <SubmitButton size="sm" variant="secondary" pendingText="...">{p.reported ? "Update" : "Report"}</SubmitButton>
      </ActionFlashForm>
      {p.reported && (
        <ActionFlashForm action={clearSetAction}>
          <input type="hidden" name="season" value={season} />
          <input type="hidden" name="setId" value={p.setId} />
          <SubmitButton size="sm" variant="secondary" pendingText="...">Clear</SubmitButton>
        </ActionFlashForm>
      )}
      <ActionFlashForm action={dqSetAction}>
        <input type="hidden" name="season" value={season} />
        <input type="hidden" name="setId" value={p.setId} />
        <SubmitButton size="sm" variant="secondary" pendingText="..." title="mark 0-0 -- nobody played">0-0</SubmitButton>
      </ActionFlashForm>
      <ActionFlashForm action={removePairAction}>
        <input type="hidden" name="season" value={season} />
        <input type="hidden" name="setId" value={p.setId} />
        <ConfirmButton size="sm" variant="destructive" message={`Remove this pairing (${p.ourName} vs ${p.theirName}) entirely?`}>remove</ConfirmButton>
      </ActionFlashForm>

      {/* seed gap -- red when off-seed, muted "(allowed)" when a TO silenced it */}
      <span className="sub" style={p.offSeed && !p.offSeedDismissed ? dangerBadge : undefined}>
        {p.seedGap == null ? "" : `gap ${p.seedGap}${p.offSeed ? (p.offSeedDismissed ? " (allowed)" : " !") : ""}`}
      </span>

      {/* their player */}
      <div style={{ marginLeft: "auto", minWidth: 210, textAlign: "right" }}>
        <div className="flex items-center gap-1 justify-end">
          <b>{p.theirName}</b>
          <SeedEdit season={season} setId={p.setId} slot={theirSlot} seed={p.theirSeed} />
        </div>
        <div className="flex justify-end">
          <FixPlayer season={season} setId={p.setId} teamSeasonId={teamSeasonId} side="their" current={p.theirPlayerId} options={allPlayers} />
        </div>
      </div>
    </div>
  );
}

// Reassign who played one side of a set. `teamSeasonId` is always OUR team's id; the
// service maps side (our/their) to the set's A/B slot from it.
function FixPlayer({
  season,
  setId,
  teamSeasonId,
  side,
  current,
  options,
}: {
  season: string;
  setId: string;
  teamSeasonId: string;
  side: "our" | "their";
  current: string;
  options: PlayerOpt[];
}) {
  const hasCurrent = options.some((o) => o.id === current);
  return (
    <details>
      <summary className="sub" style={{ cursor: "pointer", fontSize: 12 }}>fix player</summary>
      <ActionFlashForm action={reassignAction} className="inline-flex flex-wrap items-center gap-1" style={{ marginTop: 4 }}>
        <input type="hidden" name="season" value={season} />
        <input type="hidden" name="setId" value={setId} />
        <input type="hidden" name="teamSeasonId" value={teamSeasonId} />
        <input type="hidden" name="side" value={side} />
        <select name="playerId" defaultValue={hasCurrent ? current : ""} className={fieldInputSm}>
          {!hasCurrent && <option value="" disabled>pick</option>}
          {options.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
        <SubmitButton size="sm" variant="secondary" pendingText="...">Save</SubmitButton>
      </ActionFlashForm>
    </details>
  );
}

// Inline seed corrector for one side of a set -- writes TourSet.seedA/seedB directly.
function SeedEdit({ season, setId, slot, seed }: { season: string; setId: string; slot: "A" | "B"; seed: number }) {
  return (
    <ActionFlashForm action={setSeedAction} className="inline-flex items-center gap-1">
      <input type="hidden" name="season" value={season} />
      <input type="hidden" name="setId" value={setId} />
      <input type="hidden" name="slot" value={slot} />
      <input type="number" name="seed" min={1} defaultValue={seed} className={`${fieldInputSm} w-16 text-center`} title="seed -- edit and save" />
      <SubmitButton size="sm" variant="secondary" pendingText="...">seed</SubmitButton>
    </ActionFlashForm>
  );
}
