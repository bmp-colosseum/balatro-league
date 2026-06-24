import { requireAdmin } from "@/lib/admin";
import { loadActivityData } from "@/lib/loaders/activity";

// CSV export of the inactive registry — for working the list outside Discord.
export async function GET() {
  await requireAdmin();
  const data = await loadActivityData();
  const rows = data.ghosts ?? [];

  const esc = (s: string | number) => `"${String(s).replace(/"/g, '""')}"`;
  const header = ["Name", "Division", "Last post", "Played a previous season", "Check-in status", "Opted out"];
  const lines = [header.map(esc).join(",")];
  for (const r of rows) {
    const last = r.lastPostMs === null ? "never" : new Date(r.lastPostMs).toISOString().slice(0, 10);
    lines.push(
      [
        esc(r.name),
        esc(r.division),
        esc(last),
        esc(r.playedPrevSeason ? "yes" : "no"),
        esc(r.checkinStatus ?? "not asked"),
        esc(r.optedOut ? "yes" : "no"),
      ].join(","),
    );
  }

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="inactive-players.csv"',
    },
  });
}
