// Shared "replace a player who left the server" UI — used on the season page
// AND the admin Divisions page so the experience is identical in both places.
// Pre-play only; the replacement inherits the departed's exact schedule.

import Link from "next/link";
import { replacePlayer } from "@/app/admin/players/actions";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Input } from "@/components/ui/input";
import { DiscordId } from "@/components/DiscordId";
import type { ServerLeaver } from "@/lib/loaders/server-leavers";

export function ReplacePlayerSection({
  leavers,
  serverChecked,
  checkHref,
  returnTo,
}: {
  leavers: ServerLeaver[] | null;
  serverChecked: boolean;
  checkHref: string;
  returnTo: string;
}) {
  return (
    <div>
      <strong style={{ fontSize: 13 }}>Replace a player who left the server</strong>
      <p className="muted" style={{ fontSize: 12, margin: "2px 0 6px" }}>
        Find active players who&apos;ve left Discord, then replace one with someone new — the replacement
        inherits their exact schedule. Pre-play only: blocked once the departing player has a reported result.
      </p>
      {!serverChecked ? (
        <Link href={checkHref} style={{ fontSize: 13 }}>🔍 Check who&apos;s left the server →</Link>
      ) : !leavers || leavers.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--success)", margin: 0 }}>✓ Everyone in the season is still in the server.</p>
      ) : (
        <table style={{ marginTop: 4 }}>
          <thead><tr><th>Left the server</th><th>Division</th><th>Replace with (Discord ID)</th></tr></thead>
          <tbody>
            {leavers.map((l) => (
              <tr key={l.playerId}>
                <td><strong>{l.displayName}</strong><DiscordId value={l.discordId} username={null} /></td>
                <td className="muted">{l.divisionName}</td>
                <td>
                  <form action={replacePlayer} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <input type="hidden" name="departedPlayerId" value={l.playerId} />
                    <Input name="newDiscordId" required placeholder="Discord ID" className="max-w-40" />
                    <ConfirmButton
                      message={`Replace ${l.displayName} with this person? They take over the exact schedule. Blocked if ${l.displayName} already has a reported result.`}
                      variant="secondary"
                    >
                      Replace
                    </ConfirmButton>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
