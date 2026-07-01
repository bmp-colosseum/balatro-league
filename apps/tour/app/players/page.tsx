import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getAllTimePlayers } from "@/lib/stats";
import { canSeeDiscordIds } from "@/lib/discord-id";
import { PlayersTable } from "./PlayersTable";

export const dynamic = "force-dynamic";

const rate = (w: number, l: number) => (w + l ? w / (w + l) : 0);
const MIN_SETS = 10;

export default async function Players() {
  const [all, showIds] = await Promise.all([getAllTimePlayers(), canSeeDiscordIds()]);
  const ranked = all
    .filter((p) => p.setW + p.setL >= MIN_SETS)
    .sort((a, b) => rate(b.setW, b.setL) - rate(a.setW, a.setL) || b.setW - a.setW);

  return (
    <main>
      <p>
        <Link href="/" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> home</Link>
      </p>
      <h1>All-Time Player Leaderboard</h1>
      <p className="sub">
        By set win % · min {MIN_SETS} sets · {ranked.length} of {all.length} players.
      </p>
      <PlayersTable players={ranked} showIds={showIds} />
    </main>
  );
}
