import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { PlayTimesCharts } from "@/components/PlayTimesCharts";
import { loadPlayTimesData } from "@/lib/loaders/play-times";

export const dynamic = "force-dynamic";

export default async function PlayTimesPage() {
  await requireAdmin();
  const data = await loadPlayTimesData();

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/play-times" />
      <main>
        <h2>Play times</h2>
        <p className="muted">
          When league matches actually get played, in your local time -- use this to time check-in reminders, reporting
          deadlines, and maintenance windows around when players are actually online.
        </p>
        <PlayTimesCharts matches={data.matches} seasons={data.seasons} />
      </main>
    </>
  );
}
