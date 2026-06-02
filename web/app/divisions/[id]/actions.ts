"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { hasTier } from "@/lib/admin";
import { actorFromAdminUser, recordAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { enqueueAnnounceResult } from "@/lib/queue";
import { reportSetFromWeb, type ReportResultStr } from "@/lib/report";
import { recomputeDivisionStandings } from "@/lib/standings-cache";

// Report a match from the public division page. Same backend as /me
// and /profile dropdowns; redirect lands you back on the division.
export async function reportFromDivisionAction(formData: FormData) {
  const session = await auth();
  const discordId = (session?.user as { discordId?: string } | undefined)?.discordId;
  const divisionId = String(formData.get("divisionId") ?? "");
  if (!discordId) redirect(`/divisions/${divisionId}?reportErr=not-logged-in`);
  const opponentId = String(formData.get("opponentId") ?? "");
  const result = String(formData.get("result") ?? "") as ReportResultStr;
  if (!opponentId || !["2-0", "1-1", "0-2"].includes(result)) {
    redirect(`/divisions/${divisionId}?reportErr=missing-fields`);
  }
  const r = await reportSetFromWeb(discordId!, opponentId, result);
  if (!r.ok) redirect(`/divisions/${divisionId}?reportErr=${encodeURIComponent(r.reason)}`);
  revalidatePath(`/divisions/${divisionId}`);
  revalidatePath("/standings");
  revalidatePath("/me");
  redirect(`/divisions/${divisionId}?reportOk=1`);
}

// Admin path: record a result without being one of the players.
// Visible on the public division page only when the viewer is an
// admin. Form posts player A id, player B id, and a result from
// either side's POV — server canonicalizes + writes.
export async function recordFromDivisionAction(formData: FormData) {
  const session = await auth();
  const viewerUser = session?.user as { discordId?: string; name?: string | null } | undefined;
  if (!viewerUser?.discordId) redirect(`/divisions/${String(formData.get("divisionId") ?? "")}?reportErr=not-logged-in`);
  if (!(await hasTier("ADMIN"))) {
    redirect(`/divisions/${String(formData.get("divisionId") ?? "")}?reportErr=admin-only`);
  }
  const divisionId = String(formData.get("divisionId") ?? "");
  const playerAId = String(formData.get("playerAId") ?? "");
  const playerBId = String(formData.get("playerBId") ?? "");
  const result = String(formData.get("result") ?? "") as ReportResultStr;
  if (!divisionId || !playerAId || !playerBId || !["2-0", "1-1", "0-2"].includes(result)) {
    redirect(`/divisions/${divisionId}?reportErr=missing-fields`);
  }
  const [canonA, canonB] = playerAId < playerBId ? [playerAId, playerBId] : [playerBId, playerAId];
  const aIsCanon = playerAId === canonA;
  const games = result === "2-0" ? { a: 2, b: 0 } : result === "1-1" ? { a: 1, b: 1 } : { a: 0, b: 2 };
  const gamesWonA = aIsCanon ? games.a : games.b;
  const gamesWonB = aIsCanon ? games.b : games.a;

  const recorded = await prisma.pairing.upsert({
    where: { divisionId_playerAId_playerBId: { divisionId, playerAId: canonA, playerBId: canonB } },
    create: {
      divisionId,
      playerAId: canonA,
      playerBId: canonB,
      gamesWonA,
      gamesWonB,
      status: "CONFIRMED",
      reportedAt: new Date(),
      confirmedAt: new Date(),
      adminOverrideBy: viewerUser.discordId,
      adminOverrideReason: "Admin recorded from /divisions",
    },
    update: {
      gamesWonA,
      gamesWonB,
      status: "CONFIRMED",
      confirmedAt: new Date(),
      adminOverrideBy: viewerUser.discordId,
      adminOverrideReason: "Admin recorded from /divisions (overwrite)",
    },
  });
  enqueueAnnounceResult(recorded.id).catch(() => {});
  recomputeDivisionStandings(divisionId).catch(() => {});
  recordAudit({
    actor: actorFromAdminUser({ discordId: viewerUser.discordId, name: viewerUser.name ?? null }),
    action: "pairing.record-from-division-page",
    targetType: "Pairing",
    targetId: recorded.id,
    summary: `Admin recorded ${result} from /divisions/${divisionId.slice(-6)}`,
    metadata: { divisionId, playerAId: canonA, playerBId: canonB, result },
  });
  revalidatePath(`/divisions/${divisionId}`);
  revalidatePath("/standings");
  redirect(`/divisions/${divisionId}?reportOk=1`);
}
