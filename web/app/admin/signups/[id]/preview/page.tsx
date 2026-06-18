import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { loadBuildSeasonPage } from "@/lib/loaders/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { PlacementSandbox, type SandboxPlayer } from "@/components/PlacementSandbox";
import { MmrSeedingTable } from "@/components/MmrSeedingTable";
import { owenLadder } from "@/lib/season-plan";

export const dynamic = "force-dynamic";

// Dry-run placement sandbox for an OPEN/CLOSED signup round. Runs the current
// signups through the real build math live in the browser so you can twist the
// structure and see where everyone lands — writing nothing.
export default async function PlacementPreviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await params;

  const result = await loadBuildSeasonPage(id);
  if (result === "NOT_FOUND") notFound();
  if (result === "BUILT_REDIRECT") redirect(`/admin/seasons`);

  const { round, sortedSignups, playerByDiscordId, snapshotByDiscordId } = result;

  const players: SandboxPlayer[] = sortedSignups.map((s) => {
    const p = playerByDiscordId.get(s.discordId);
    const snap = snapshotByDiscordId.get(s.discordId);
    return {
      discordId: s.discordId,
      displayName: s.displayName,
      rating: p?.rating ?? null,
      mmr: snap?.rankedMmr ?? null,
    };
  });

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/seasons" />
      <main>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>Placement preview — "{round.name}"</h2>
          <span className="pill" style={{ background: "rgba(118,199,255,0.2)", color: "#76c7ff" }}>
            {players.length} signups · dry run
          </span>
          <Link href={`/admin/signups/${round.id}`} className="muted" style={{ marginLeft: "auto" }}>
            ← Back to round
          </Link>
        </div>
        <p className="muted">
          A sandbox over the <strong>current</strong> signups, starting on Owen&apos;s ladder
          (Legendary · Rare/Uncommon/Common, sized to the signup count). Tweak the structure and watch
          where everyone lands; flip on <strong>Show schedules</strong> to see each player&apos;s 4
          opponents + the strength-of-schedule spread. Nothing is saved — use it to sanity-check the
          format and show people how their season would look.
        </p>

        {players.length === 0 ? (
          <div className="card">No signups yet — once people join, their projected placement shows here.</div>
        ) : (
          <>
            <MmrSeedingTable players={players} />
            <PlacementSandbox players={players} initialTiers={owenLadder(players.length)} initialTargetGroupSize={5} />
          </>
        )}
      </main>
    </>
  );
}
