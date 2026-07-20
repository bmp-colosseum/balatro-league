// Compact "who won each division" view for /admin/seasons/[id]/winners. The
// season detail page shows every division's FULL standings table (too much to
// scan when all a TO wants is "who gets an award"); this is the one-row-per-
// division roll-up, including whether the champion role has actually been
// awarded to the current winner.

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Callout } from "@/components/Callout";
import { DiscordId } from "@/components/DiscordId";
import {
  loadSeasonWinners,
  winnerAwardStatus,
  type DivisionWinnerRow,
  type SeasonWinnerDivision,
  type WinnerAwardStatus,
} from "@/lib/loaders/admin-winners";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<WinnerAwardStatus, { text: string; color: string }> = {
  awarded: { text: "awarded", color: "var(--success)" },
  pending: { text: "pending", color: "var(--muted)" },
  mismatch: { text: "mismatch -- standings moved", color: "var(--danger)" },
  tied: { text: "tied -- award blocked until resolved", color: "var(--admin)" },
  "no-winner": { text: "no winner yet", color: "var(--muted)" },
};

export default async function SeasonWinnersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const data = await loadSeasonWinners(id);
  if (!data) notFound();

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/seasons" />
      <main>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 style={{ margin: 0 }}>Division winners -- {data.seasonLabel}</h2>
          <Link href="/admin/seasons" className="muted" style={{ marginLeft: "auto" }}>
            {"<- Back"}
          </Link>
        </div>
        <p className="muted">
          One row per division, ladder order. Use this to hand out awards without scrolling
          every division's full standings table.
        </p>

        {!data.seasonEnded && (
          <Callout type="info">
            This season hasn&apos;t ended yet -- these are the CURRENT standings, not final ones.
            They can still change.
          </Callout>
        )}

        {data.divisions.length === 0 ? (
          <Callout type="info">This season has no divisions yet.</Callout>
        ) : (
          <div className="table-scroll">
            <table className="table-dense">
              <thead>
                <tr>
                  <th>Division</th>
                  <th>Winner</th>
                  <th>Pts</th>
                  <th>Record</th>
                  <th>Award status</th>
                </tr>
              </thead>
              <tbody>
                {data.divisions.map((d) => (
                  <DivisionRow key={d.divisionId} division={d} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}

// Career title count next to a winner's name -- the detail a TO wants when
// handing out awards for repeat champions (Rare 1, Rare 2, Common 3, etc.).
function ChampionBadge({ winner: w }: { winner: DivisionWinnerRow }) {
  if (w.priorTitleCount === 0) {
    return (
      <div className="muted" style={{ fontSize: 11 }}>
        first title
      </div>
    );
  }
  const careerTotal = w.priorTitleCount + 1;
  const tooltip = w.priorTitles
    .map((t) => `${t.divisionName} (${t.seasonLabel})`)
    .join("; ");
  return (
    <div
      title={tooltip}
      style={{ fontSize: 11, color: "var(--admin)", cursor: "help" }}
    >
      {careerTotal}x champion
    </div>
  );
}

function DivisionRow({ division: d }: { division: SeasonWinnerDivision }) {
  const status = winnerAwardStatus(d);
  const label = STATUS_LABEL[status];

  return (
    <tr>
      <td>
        <strong>{d.divisionName}</strong>
        <div className="muted" style={{ fontSize: 11 }}>
          {d.tierName} - {d.memberCount} player{d.memberCount === 1 ? "" : "s"}
        </div>
      </td>
      <td>
        {d.winners.length === 0 ? (
          <span className="muted">
            {d.hasPlayedMatches ? "-- no clear winner --" : "no matches played yet"}
          </span>
        ) : (
          <div style={{ display: "grid", gap: 2 }}>
            {d.winners.map((w) => (
              <div key={w.playerId}>
                <Link href={`/profile/${w.playerId}`} style={{ color: "var(--text)" }}>
                  {w.displayName}
                </Link>
                <DiscordId value={w.discordId} username={w.username} />
                <ChampionBadge winner={w} />
              </div>
            ))}
          </div>
        )}
      </td>
      <td>
        {d.winners.length === 0 ? (
          <span className="muted">-</span>
        ) : d.tied ? (
          <span className="muted">{d.winners[0]!.points} each</span>
        ) : (
          <strong>{d.winners[0]!.points}</strong>
        )}
      </td>
      <td>
        {d.winners.length === 0 ? (
          <span className="muted">-</span>
        ) : d.tied ? (
          <span className="muted">
            {d.winners.map((w) => `${w.wins}-${w.losses}-${w.draws}`).join(" / ")}
          </span>
        ) : (
          <span style={{ whiteSpace: "nowrap" }}>
            <span style={{ color: "var(--success)" }}>{d.winners[0]!.wins}W</span>
            <span className="muted"> - </span>
            <span className="muted">{d.winners[0]!.draws}D</span>
            <span className="muted"> - </span>
            <span style={{ color: "var(--danger)" }}>{d.winners[0]!.losses}L</span>
          </span>
        )}
      </td>
      <td style={{ color: label.color }}>{label.text}</td>
    </tr>
  );
}
