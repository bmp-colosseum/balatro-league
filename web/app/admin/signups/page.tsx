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
        <h2>Signups</h2>
        <p className="muted">
          Signup rounds let players opt in for an upcoming season. Use the Discord command{" "}
          <code>/league post-signup</code> to open one.
        </p>

        {rounds.length === 0 ? (
          <div className="card muted">
            No signup rounds yet. Run <code>/league post-signup name:"Season 2 Signups"</code> in
            your league's Discord.
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
                {round.status === "OPEN" && (
                  <form action={closeRound} style={{ marginTop: 8 }}>
                    <input type="hidden" name="roundId" value={round.id} />
                    <button type="submit" className="secondary">Finalize signups</button>
                  </form>
                )}
              </div>
            );
          })
        )}
      </main>
    </>
  );
}
