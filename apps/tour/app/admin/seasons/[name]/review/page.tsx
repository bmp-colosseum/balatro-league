// Week-by-week review-and-correct hub. Pick a team, step through its weeks (and
// playoffs), and see the derived lineup + each matchup's pairings + results together,
// with the off-seed / empty / short flags called out -- the one place to eyeball a
// season and fix what's wrong. Works for imported flat seasons (TT4) and live ones,
// because getSeasonReview reads TourSet directly. TO-only.
import Link from "next/link";
import { ClipboardCheck, TriangleAlert } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { getSeasonReview, type ReviewMatchup, type ReviewPair } from "@/lib/services/review";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { Section } from "@/components/admin/Section";
import { EmptyState } from "@/components/admin/EmptyState";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { SeedOrSub } from "@/components/SeedOrSub";
import { fieldInputSm } from "@/components/admin/Field";
import { reportSetAction, clearSetAction, reassignAction, setSeedAction } from "./actions";

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
  const review = await getSeasonReview(seasonName, sp.team);
  if (!review) {
    return (
      <main>
        <AdminPageHeader back={{ href: "/admin", label: "admin" }} title="Season not found" />
      </main>
    );
  }

  const { teamSeasonId, teamName, teams, teamPlayers, weeks, offSeedTotal, emptyMatchupCount } = review;
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
                {w.isPlayoff ? "Playoffs" : `W${w.week}`}
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
                enc={enc}
              />
            ))
          ) : (
            <EmptyState>No matchup recorded for {teamName} in {selWeek.label}.</EmptyState>
          )}
        </>
      )}
    </main>
  );
}

function MatchupCard({
  m,
  season,
  teamSeasonId,
  teamSize,
  teamPlayers,
  enc,
}: {
  m: ReviewMatchup;
  season: string;
  teamSeasonId: string;
  teamSize: number;
  teamPlayers: { id: string; name: string }[];
  enc: string;
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

  return (
    <Section title={header}>
      {m.pairs.length === 0 ? (
        <span className="sub">No pairings recorded.</span>
      ) : (
        <div className="flex flex-col gap-2">
          {m.pairs.map((p) => (
            <PairRow key={p.setId} p={p} season={season} teamSeasonId={teamSeasonId} teamPlayers={teamPlayers} />
          ))}
        </div>
      )}
    </Section>
  );
}

function PairRow({
  p,
  season,
  teamSeasonId,
  teamPlayers,
}: {
  p: ReviewPair;
  season: string;
  teamSeasonId: string;
  teamPlayers: { id: string; name: string }[];
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
        <details>
          <summary className="sub" style={{ cursor: "pointer", fontSize: 12 }}>fix player</summary>
          <ActionFlashForm action={reassignAction} className="flex flex-wrap items-center gap-1" style={{ marginTop: 4 }}>
            <input type="hidden" name="season" value={season} />
            <input type="hidden" name="setId" value={p.setId} />
            <input type="hidden" name="teamSeasonId" value={teamSeasonId} />
            <input type="hidden" name="side" value="our" />
            <select name="playerId" defaultValue={p.ourPlayerId} className={fieldInputSm}>
              {teamPlayers.map((tp) => (
                <option key={tp.id} value={tp.id}>{tp.name}</option>
              ))}
            </select>
            <SubmitButton size="sm" variant="secondary" pendingText="...">Save</SubmitButton>
          </ActionFlashForm>
        </details>
      </div>

      {/* score */}
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

      {/* seed gap */}
      <span className="sub" style={p.offSeed ? dangerBadge : undefined}>
        {p.seedGap == null ? "" : `gap ${p.seedGap}${p.offSeed ? " !" : ""}`}
      </span>

      {/* their player */}
      <div className="flex items-center gap-1" style={{ marginLeft: "auto" }}>
        <b>{p.theirName}</b>
        <SeedEdit season={season} setId={p.setId} slot={theirSlot} seed={p.theirSeed} />
      </div>
    </div>
  );
}

// Inline seed corrector for one side of a set -- writes TourSet.seedA/seedB directly.
function SeedEdit({ season, setId, slot, seed }: { season: string; setId: string; slot: "A" | "B"; seed: number }) {
  return (
    <ActionFlashForm action={setSeedAction} className="inline-flex items-center gap-1">
      <input type="hidden" name="season" value={season} />
      <input type="hidden" name="setId" value={setId} />
      <input type="hidden" name="slot" value={slot} />
      <input type="number" name="seed" min={1} defaultValue={seed} className={`${fieldInputSm} w-11 text-center`} title="seed -- edit and save" />
      <SubmitButton size="sm" variant="secondary" pendingText="...">seed</SubmitButton>
    </ActionFlashForm>
  );
}
