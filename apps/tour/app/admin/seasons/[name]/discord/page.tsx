import Link from "next/link";
import { ArrowLeft, ShieldCheck, AlertTriangle, Crown, Users } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { getRolePreview } from "@/lib/services/discord-roles";
import { Callout } from "@/components/Callout";

export const dynamic = "force-dynamic";

export default async function DiscordRolesAdmin({ params }: { params: Promise<{ name: string }> }) {
  if (!(await isAdmin())) {
    return (
      <main>
        <h1>Admin</h1>
        <Callout type="admin">Not authorized. Set <code>TOUR_DEV_ADMIN=1</code>.</Callout>
      </main>
    );
  }

  const { name } = await params;
  const seasonName = decodeURIComponent(name);
  const enc = encodeURIComponent(seasonName);
  const p = await getRolePreview(seasonName);

  if (!p) {
    return (
      <main>
        <p><Link href="/admin" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> admin</Link></p>
        <h1>Season not found</h1>
      </main>
    );
  }

  return (
    <main>
      <p>
        <Link href={`/admin/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {seasonName}</Link>
      </p>
      <h1>Discord roles</h1>
      <p className="sub">
        Who <em>should</em> hold the season&apos;s Player / Captain role — derived from the roster + captains + the move
        log. The Tour bot (Phase C) reconciles Discord to this; here&apos;s the preview.
      </p>

      <Callout type={p.provisioned ? "success" : "info"}>
        {p.provisioned ? (
          <span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-4" /> Roles provisioned — Player <code>{p.playerRoleId}</code> · Captain <code>{p.captainRoleId}</code></span>
        ) : (
          "Roles not created yet — the bot will create the Player + Captain roles on its first sync (needs the Tour bot token + guild)."
        )}
      </Callout>

      {p.unmappable.length > 0 && (
        <Callout type="admin">
          <span className="inline-flex items-center gap-1.5"><AlertTriangle className="size-4" /> {p.unmappable.length} player{p.unmappable.length === 1 ? "" : "s"} can&apos;t be roled yet</span> — they have no linked Discord ID. Map them in{" "}
          <Link href="/admin/identity">Identity</Link> first. ({p.unmappable.slice(0, 8).map((u) => u.name).join(", ")}{p.unmappable.length > 8 ? "…" : ""})
        </Callout>
      )}

      <div className="grid grid-2">
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="bracket-title flex items-center gap-1.5"><Users className="size-4" /> Player role ({p.players.length})</div>
          {p.players.length === 0 ? (
            <p className="sub">No mappable players yet.</p>
          ) : (
            <ul className="list-none p-0 columns-2" style={{ margin: 0 }}>
              {p.players.map((n) => <li key={n} className="py-0.5">{n}</li>)}
            </ul>
          )}
        </div>
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="bracket-title flex items-center gap-1.5"><Crown className="size-4" /> Captain role ({p.captains.length})</div>
          {p.captains.length === 0 ? (
            <p className="sub">No mappable captains yet.</p>
          ) : (
            <ul className="list-none p-0" style={{ margin: 0 }}>
              {p.captains.map((n) => <li key={n} className="py-0.5">{n}</li>)}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}
