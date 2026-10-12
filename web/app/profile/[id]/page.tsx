// Thin route wrapper — the actual UI lives in the shared <ProfileView>, which
// /me renders too (no redirect). This page just maps the [id] param +
// dispute query flags onto it.
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { ProfileView } from "@/components/ProfileView";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const player = await prisma.player.findUnique({ where: { id }, select: { displayName: true } });
  if (!player) return { title: "Balatro League" };
  return { title: `${player.displayName} - Balatro League` };
}

export default async function ProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ disputeOk?: string; disputeErr?: string }>;
}) {
  const { id } = await params;
  const { disputeOk, disputeErr } = await searchParams;
  return <ProfileView playerId={id} disputeOk={disputeOk} disputeErr={disputeErr} />;
}
