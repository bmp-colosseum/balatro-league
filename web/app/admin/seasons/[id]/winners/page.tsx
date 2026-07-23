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
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { tierColors } from "@/lib/tier-colors";
import {
  loadSeasonWinners,
  winnerAwardStatus,
  type DivisionWinnerRow,
  type SeasonWinnerDivision,
  type WinnerAwardStatus,
} from "@/lib/loaders/admin-winners";
import { setDivisionAwarded } from "./actions";

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
          every division's full standings table. &quot;Mark awarded&quot; is bookkeeping only --
          it checks the division off here without assigning any Discord role.
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

// Rarity-colored tier pill (gold Legendary / purple Rare / blue Uncommon /
// grey Common, cycling for custom tiers) -- so the award's rarity is scannable.
function RarityPill({
  name,
  position,
  size = 11,
  title,
}: {
  name: string;
  position: number;
  size?: number;
  title?: string;
}) {
  const c = tierColors(position);
  return (
    <span
      className="pill"
      title={title}
      style={{ background: c.bg, color: c.fg, fontSize: size, whiteSpace: "nowrap" }}
    >
      {name}
    </span>
  );
}

// Career title history next to a winner's name -- the detail a TO wants when
// handing out awards for repeat champions. A flat "2x champion" hides WHICH
// rarities those titles were, so instead we break the career down by tier:
// one counted rarity pill per tier (this season's title + all prior titles),
// most-prestigious first, so "2x" can't be mistaken for 2 Common wins when one
// was Legendary. Each pill's tooltip lists the exact divisions/seasons.
function ChampionBadge({
  winner: w,
  currentTier,
  // False when this division is still TIED for #1 -- the current title isn't
  // clinched yet, so it must not be counted toward the career breakdown (both
  // co-leaders would otherwise be credited a title neither has won).
  currentTitleClinched,
}: {
  winner: DivisionWinnerRow;
  currentTier: { name: string; position: number; divisionName: string };
  currentTitleClinched: boolean;
}) {
  // Nothing to show when there are no prior titles and this one isn't clinched.
  if (w.priorTitleCount === 0 && !currentTitleClinched) return null;
  if (w.priorTitleCount === 0) {
    return (
      <div className="muted" style={{ fontSize: 11 }}>
        first title
      </div>
    );
  }

  // Aggregate career titles by tier position (1 = top). Seed with this season's
  // title only if it's clinched (not a live tie), then fold in every prior title.
  const byTier = new Map<number, { name: string; titles: string[] }>();
  const add = (position: number, name: string, label: string) => {
    const e = byTier.get(position);
    if (e) e.titles.push(label);
    else byTier.set(position, { name, titles: [label] });
  };
  if (currentTitleClinched) {
    add(currentTier.position, currentTier.name, `${currentTier.divisionName} (this season)`);
  }
  for (const t of w.priorTitles) add(t.tierPosition, t.tierName, `${t.divisionName} (${t.seasonLabel})`);

  const tiers = [...byTier.entries()].sort((a, b) => a[0] - b[0]); // top rarity first
  const careerTotal = w.priorTitleCount + (currentTitleClinched ? 1 : 0);

  return (
    <div style={{ display: "grid", gap: 3, marginTop: 2 }}>
      <div style={{ fontSize: 11, color: "var(--admin)" }}>{careerTotal}x champion</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
        {tiers.map(([position, { name, titles }]) => (
          <RarityPill
            key={position}
            name={titles.length > 1 ? `${name} x${titles.length}` : name}
            position={position}
            size={10}
            title={titles.join("; ")}
          />
        ))}
      </div>
    </div>
  );
}

function DivisionRow({ division: d }: { division: SeasonWinnerDivision }) {
  const status = winnerAwardStatus(d);
  const label = STATUS_LABEL[status];

  return (
    <tr>
      <td>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <strong>{d.divisionName}</strong>
          <RarityPill name={d.tierName} position={d.tierPosition} />
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          {d.memberCount} player{d.memberCount === 1 ? "" : "s"}
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
                <ChampionBadge
                  winner={w}
                  currentTier={{
                    name: d.tierName,
                    position: d.tierPosition,
                    divisionName: d.divisionName,
                  }}
                  currentTitleClinched={!d.tied}
                />
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
      <td>
        <AwardStatusCell division={d} status={status} label={label} />
      </td>
    </tr>
  );
}

// Award-status cell with a manual bookkeeping toggle. "pending"/"mismatch" get
// a "Mark awarded" button (re-points championPlayerId at the current winner);
// "awarded" gets a "Mark pending" undo. "tied"/"no-winner" can't be awarded, so
// they show status text only. The toggle NEVER touches Discord roles -- it's
// pure check-off bookkeeping (see ./actions.ts).
function AwardStatusCell({
  division: d,
  status,
  label,
}: {
  division: SeasonWinnerDivision;
  status: WinnerAwardStatus;
  label: { text: string; color: string };
}) {
  if (status === "no-winner" || status === "tied") {
    return <span style={{ color: label.color }}>{label.text}</span>;
  }
  const isAwarded = status === "awarded";
  return (
    <div style={{ display: "grid", gap: 4, justifyItems: "start" }}>
      <span style={{ color: label.color }}>{label.text}</span>
      <ActionFlashForm action={setDivisionAwarded}>
        <input type="hidden" name="divisionId" value={d.divisionId} />
        <input type="hidden" name="awarded" value={isAwarded ? "0" : "1"} />
        <SubmitButton size="sm" variant="secondary">
          {isAwarded ? "Mark pending" : "Mark awarded"}
        </SubmitButton>
      </ActionFlashForm>
    </div>
  );
}
