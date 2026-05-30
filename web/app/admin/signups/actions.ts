"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";

export async function closeRound(formData: FormData) {
  await requireAdmin();
  const roundId = String(formData.get("roundId") ?? "");
  if (!roundId) return;
  const round = await prisma.signupRound.findUnique({ where: { id: roundId } });
  if (!round || round.status !== "OPEN") return;
  await prisma.signupRound.update({
    where: { id: roundId },
    data: { status: "CLOSED", closedAt: new Date() },
  });
  revalidatePath("/admin/signups");
}
