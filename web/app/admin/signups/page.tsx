import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { closeRound } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminSignupsPage() {
  await requireAdmin();

  const rounds = await prisma.signupRound.findMany({
    include: {
      signups: { orderBy: { signedUpAt: "asc" } },
      _count: { select: { signups: true } },
    },
    orderBy: [{ status: "asc" }, { openedAt: "desc" }],
  });

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/signups" />
      <main>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 style={{ margin: 0 }}>Signups</h2>
          <Link href="/admin/signups/new" style={{ marginLeft: "auto" }}>
            <button type="button">New round</button>
          </Link>
        </div>
        <p className="muted">
          Signup rounds let players opt in for an upcoming season. Open one from here or
          via <code>/league post-signup</code> in Discord.
        </p>

        {rounds.length === 0 ? (
          <div className="card muted">
            No signup rounds yet. Click <strong>New round</strong> above to open one.
          </div>
        ) : (
          rounds.map((round) => {
            const active = round.signups.filter((s) => !s.withdrawn);
            const withdrawn = round.signups.filter((s) => s.withdrawn);
            const statusPill =
              round.status === "OPEN"
                ? { bg: "rgba(46,204,113,0.2)", fg: "#2ecc71" }
                : round.status === "CLOSED"
                  ? { bg: "rgba(241,196,15,0.2)", fg: "#f1c40f" }
                  : { bg: "rgba(149,165,166,0.2)", fg: "#c0c8cb" };
            return (
              <div key={round.id} className="card">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <strong style={{ fontSize: 16 }}>{round.name}</strong>
                  <span className="pill" style={{ background: statusPill.bg, color: statusPill.fg }}>
                    {round.status}
                  </span>
                  <span style={{ marginLeft: "auto" }} className="muted">
                    {active.length} active · {withdrawn.length} withdrawn
                  </span>
                </div>
                <div className="muted" style={{ marginTop: 4 }}>
                  Round id: <code>{round.id}</code>
                  {round.status !== "OPEN" && round.closedAt && (
                    <> · closed {round.closedAt.toISOString().slice(0, 16).replace("T", " ")} UTC</>
                  )}
                </div>
                <table style={{ marginTop: 12 }}>
                  <thead>
                    <tr><th>Player</th><th>Signed up</th></tr>
                  </thead>
                  <tbody>
                    {active.length === 0 ? (
                      <tr><td colSpan={2} className="muted">No active signups in this round.</td></tr>
                    ) : active.map((s) => (
                      <tr key={s.id}>
                        <td><strong>{s.displayName}</strong> <span className="muted">{s.discordId}</span></td>
                        <td>{s.signedUpAt.toISOString().slice(0, 16).replace("T", " ")} UTC</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  {round.status === "OPEN" && (
                    <form action={closeRound}>
                      <input type="hidden" name="roundId" value={round.id} />
                      <button type="submit" className="secondary">Finalize signups</button>
                    </form>
                  )}
                  {round.status === "CLOSED" && (
                    <Link href={`/admin/signups/${round.id}/build`}>
                      <button type="button">Build season →</button>
                    </Link>
                  )}
                  {round.status === "BUILT" && round.resultingSeasonId && (
                    <Link href="/admin/seasons" className="muted" style={{ fontSize: 12 }}>
                      → built into season
                    </Link>
                  )}
                </div>
              </div>
            );
          })
        )}
      </main>
    </>
  );
}
