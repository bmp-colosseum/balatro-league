// Dedicated /report route. Same flow as /me's report form, but a
// top-level entry point so players can bookmark it / find it from the
// nav without scrolling past their profile. Both surfaces go through
// reportSetFromWeb so the rules stay identical.

import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { reportSetFromWeb, type ReportResultStr } from "@/lib/report";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";

export const dynamic = "force-dynamic";

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/auth/signin?from=/report");

  const { ok, err } = await searchParams;
  const user = session.user as { discordId: string; name?: string | null };

  const player = user.discordId
    ? await prisma.player.findUnique({ where: { discordId: user.discordId } })
    : null;

  const myMembership = player
    ? await prisma.divisionMember.findFirst({
        where: {
          playerId: player.id,
          status: "ACTIVE",
          division: { season: { isActive: true, visibility: "PUBLIC" } },
        },
        include: {
          division: {
            include: {
              tier: true,
              season: true,
              members: { include: { player: true } },
              pairings: { select: { playerAId: true, playerBId: true, status: true } },
            },
          },
        },
      })
    : null;
  const division = myMembership?.division;

  // Opponent gating: hide players we've ALREADY confirmed against
  // (can't double-report), but keep PENDING ones visible so the
  // reporter sees a clear "already pending — wait for confirm" error
  // rather than the dropdown silently dropping them.
  const opponents = division?.members.filter((m) => m.playerId !== player!.id && m.status === "ACTIVE") ?? [];
  const confirmedOpponentIds = new Set<string>();
  const pendingOpponentIds = new Set<string>();
  if (division && player) {
    for (const p of division.pairings) {
      const opp = p.playerAId === player.id ? p.playerBId : p.playerBId === player.id ? p.playerAId : null;
      if (!opp) continue;
      if (p.status === "CONFIRMED") confirmedOpponentIds.add(opp);
      if (p.status === "PENDING") pendingOpponentIds.add(opp);
    }
  }
  const reportableOpponents = opponents.filter((m) => !confirmedOpponentIds.has(m.playerId));

  async function reportAction(formData: FormData) {
    "use server";
    const session = await auth();
    const discordId = (session?.user as { discordId?: string } | undefined)?.discordId;
    if (!discordId) redirect("/report?err=not-logged-in");
    const opponentId = String(formData.get("opponentId") ?? "");
    const result = String(formData.get("result") ?? "") as ReportResultStr;
    if (!opponentId || !["2-0", "1-1", "0-2"].includes(result)) {
      redirect("/report?err=missing-fields");
    }
    const r = await reportSetFromWeb(discordId!, opponentId, result);
    if (!r.ok) redirect(`/report?err=${encodeURIComponent(r.reason)}`);
    revalidatePath("/report");
    revalidatePath("/me");
    revalidatePath("/standings");
    redirect("/report?ok=1");
  }

  const tc = division ? tierColors(division.tier.position) : null;

  return (
    <>
      <SiteNav activePath="/report" />
      <main>
        <h2>Report a match</h2>

        {ok && (
          <div className="card" style={{ borderColor: "#2ecc71", color: "#2ecc71" }}>
            ✓ Reported. Your opponent has 2 minutes to confirm or dispute in #results, then it auto-confirms.
          </div>
        )}
        {err && (
          <div className="card" style={{ borderColor: "#e74c3c", color: "#e74c3c" }}>
            {err}
          </div>
        )}

        {!player ? (
          <div className="card">
            <strong>Not in the league yet</strong>
            <p className="muted">
              You're logged in but no Player record exists for your Discord ID. Sign up via the Discord
              bot first.
            </p>
          </div>
        ) : !division || !tc ? (
          <div className="card muted">
            You're not in an active public division right now — when you are, this is where you'll
            report results from.
          </div>
        ) : (
          <div className="card">
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              <span className="muted">Your division:</span>
              <span className="pill" style={{ background: tc.bg, color: tc.fg }}>{division.tier.name}</span>
              <Link href={`/divisions/${division.id}`} style={{ textDecoration: "none" }}>{division.name}</Link>
              <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>{division.season.name}</span>
            </div>

            {reportableOpponents.length === 0 ? (
              <p className="muted">No opponents left — you've played everyone in your division.</p>
            ) : (
              <form action={reportAction} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <span className="muted" style={{ fontSize: 12 }}>vs</span>
                <select name="opponentId" required style={{ flex: "1 1 240px" }}>
                  <option value="">— pick an opponent —</option>
                  {reportableOpponents.map((m) => {
                    const isPending = pendingOpponentIds.has(m.playerId);
                    return (
                      <option key={m.playerId} value={m.playerId}>
                        {m.player.displayName}{isPending ? " (already pending)" : ""}
                      </option>
                    );
                  })}
                </select>
                <select name="result" required defaultValue="2-0">
                  <option value="2-0">2-0 (I won both)</option>
                  <option value="1-1">1-1 (draw)</option>
                  <option value="0-2">0-2 (I lost both)</option>
                </select>
                <button type="submit">Report</button>
              </form>
            )}

            <p className="muted" style={{ fontSize: 11, marginTop: 12 }}>
              Reports go to <strong>#results</strong> in Discord with Confirm + Dispute buttons. Your opponent
              has 2 minutes — if no one clicks, it auto-confirms. Mistake? Ask an admin to use{" "}
              <code>/admin override-result</code>.
            </p>
          </div>
        )}

        <p className="muted" style={{ fontSize: 12, marginTop: 16 }}>
          New to the league? <Link href="/how-to-play">How to play →</Link>
        </p>
      </main>
    </>
  );
}
