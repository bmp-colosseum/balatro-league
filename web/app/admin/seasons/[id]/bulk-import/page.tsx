import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { loadBulkImportSeasonContext } from "@/lib/loaders/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { bulkImportSeason } from "./actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export const dynamic = "force-dynamic";

export default async function BulkImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ result?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const { result } = await searchParams;
  const season = await loadBulkImportSeasonContext(id);
  if (!season) notFound();

  const summary = result ? new URLSearchParams(decodeURIComponent(result)) : null;

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/seasons" />
      <main>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <h2 style={{ margin: 0 }}>Bulk import → {season.name}</h2>
          <Link href="/admin/seasons" className="muted" style={{ marginLeft: "auto" }}>
            ← Back to seasons
          </Link>
        </div>
        <p className="muted">
          One-shot import for an entire season. Paste the two CSVs below and click
          Import — server matches divisions by name (case + whitespace tolerant),
          upserts Players + DivisionMembers, then creates CONFIRMED Pairings.
          Re-runnable safely; duplicates are upserted, not duplicated.
        </p>

        {summary && (
          <div className="card" style={{ borderColor: "#2ecc71" }}>
            <strong>Import done</strong>
            <ul className="muted" style={{ marginTop: 4 }}>
              <li>{summary.get("membersAdded")} member(s) added/updated</li>
              {Number(summary.get("membersSkipped") ?? 0) > 0 && (
                <li>{summary.get("membersSkipped")} member row(s) skipped</li>
              )}
              <li>{summary.get("pairingsRecorded")} pairing(s) recorded</li>
              {Number(summary.get("pairingsSkipped") ?? 0) > 0 && (
                <li>{summary.get("pairingsSkipped")} pairing row(s) skipped</li>
              )}
              {(summary.get("unknownDivisions") ?? "").length > 0 && (
                <li style={{ color: "#e74c3c" }}>
                  Unknown divisions (no Division row in this season): {summary.get("unknownDivisions")}
                </li>
              )}
              {(summary.get("membersErrors") ?? "").length > 0 && (
                <li style={{ color: "#e74c3c" }}>Member errors: {summary.get("membersErrors")}</li>
              )}
              {(summary.get("matchErrors") ?? "").length > 0 && (
                <li style={{ color: "#e74c3c" }}>Match errors: {summary.get("matchErrors")}</li>
              )}
              {(summary.get("transferred") ?? "").length > 0 && (
                <li style={{ color: "#f1c40f" }}>
                  ↪ Transferred (player listed in different division this season): {summary.get("transferred")}
                </li>
              )}
            </ul>
          </div>
        )}

        <div className="card">
          <strong>This season has {season.divisions.length} division(s)</strong>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 6 }}>
            {season.divisions.map((d) => (
              <code key={d.id} style={{ fontSize: 11, padding: "2px 6px", background: "var(--surface-2)", borderRadius: 3 }}>
                {d.name}
              </code>
            ))}
          </div>
          {season.divisions.length === 0 && (
            <p className="muted" style={{ marginTop: 6 }}>
              No divisions configured yet — set tier shape on the season card first.
              The bulk import matches by division name and will reject rows otherwise.
            </p>
          )}
        </div>

        <form action={bulkImportSeason}>
          <input type="hidden" name="seasonId" value={season.id} />

          <div className="card">
            <strong>1. Members</strong>
            <p className="muted" style={{ fontSize: 12 }}>
              Format: <code>division, display_name, discord_id</code> — one row per player.
              Matches <code>scripts/out/participants.csv</code> exactly (header row optional, auto-detected).
              Skips rows without a valid Discord ID.
            </p>
            <Textarea
              name="members"
              rows={12}
              placeholder={"division,display_name,discord_id\nCommon 6,Bob,123456789012345678\nCommon 6,DJ,234567890123456789\n..."}
              style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: 12 }}
              required
            />
          </div>

          <div className="card">
            <strong>2. Matches</strong>
            <p className="muted" style={{ fontSize: 12 }}>
              Format: <code>division, player1, player2, result, state</code> — one row per played set.
              Matches <code>scripts/out/matches.csv</code> exactly. <code>player1</code>/<code>player2</code> can be either
              a Discord ID or a display name from the members import. Rows where <code>state ≠ complete</code> are skipped.
            </p>
            <Textarea
              name="matches"
              rows={12}
              placeholder={"division,player1,player2,result,state\nCommon 6,Bob,DJ,2-0,complete\nCommon 6,Ohdamn,F8,1-1,complete\n..."}
              style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: 12 }}
            />
            <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              (Optional — leave blank if you just want to import members and no pre-played results.)
            </p>
          </div>

          <Button type="submit">Import everything</Button>
        </form>
      </main>
    </>
  );
}
