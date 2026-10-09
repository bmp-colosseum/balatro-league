import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Callout } from "@/components/Callout";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { loadRoleAuditData, type SeasonRecordRow } from "@/lib/loaders/role-audit";
import type { RoleAuditEntry, RoleExpectationKind, UnmappedRole } from "@/lib/role-audit-core";
import { fixRole } from "./actions";
import { RarityText } from "@/components/RarityText";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

const GROUP_LABEL: Record<RoleExpectationKind, string> = {
  "league-player": "League Player",
  division: "Division roles",
  champion: "Champion roles",
  winner: "Winner roles",
};
const GROUP_ORDER: RoleExpectationKind[] = ["league-player", "division", "champion", "winner"];

export default async function RoleAuditPage() {
  await requireAdmin();
  const data = await loadRoleAuditData();

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/roles" />
      <main>
        <h2>Role audit</h2>
        <p className="muted">
          Who SHOULD hold each league-managed Discord role vs who actually does, plus every other role in the
          server so you can decide which extras (star / winner badges, etc.) deserve a rule of their own.
        </p>

        {!data.guildConfigured ? (
          <Callout type="danger">DISCORD_GUILD_ID is not configured -- the role audit can&apos;t run.</Callout>
        ) : (
          <>
            <p>
              <strong>{data.report.entries.length}</strong> role{data.report.entries.length === 1 ? "" : "s"}{" "}
              audited, <strong>{data.report.totals.missing}</strong> missing,{" "}
              <strong>{data.report.totals.extra}</strong> extra, <strong>{data.report.unmapped.length}</strong>{" "}
              unmapped role{data.report.unmapped.length === 1 ? "" : "s"}.
            </p>

            {GROUP_ORDER.map((kind) => (
              <EntryGroup
                key={kind}
                kind={kind}
                entries={data.report.entries.filter((e) => e.kind === kind)}
                displayNames={data.displayNames}
              />
            ))}

            {data.unmatchedChampions.length > 0 && (
              <section style={{ marginTop: 24 }}>
                <h3>Champions without a matching role</h3>
                <p className="muted">
                  A clear champion exists for these divisions but no Discord role name matched it -- create or
                  rename the role, then re-check this page.
                </p>
                <ul>
                  {data.unmatchedChampions.map((c, i) => (
                    <li key={i}>
                      {c.seasonLabel} <RarityText position={c.tierPosition}>{c.divisionName}</RarityText>: <strong>{c.championName}</strong>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {data.missingWinnerRoles.length > 0 && (
              <section style={{ marginTop: 24 }}>
                <h3>No winner role exists yet</h3>
                <p className="muted">
                  Players have reached these title counts but no guild role names that count yet -- create one
                  (e.g. &quot;{data.missingWinnerRoles[0]!.count}x {data.missingWinnerRoles[0]!.tierName} Winner&quot;)
                  then re-check this page.
                </p>
                <ul>
                  {data.missingWinnerRoles.map((m, i) => (
                    <li key={i}>
                      {m.count}x {m.tierName}: {m.players.map((id) => data.displayNames[id] ?? id).join(", ")}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <SeasonRecordSection rows={data.seasonRecords} />

            <section style={{ marginTop: 24 }}>
              <h3>Other roles in the server</h3>
              <p className="muted">
                Every non-managed role that isn&apos;t covered by an expectation above, with who currently holds
                it -- use this to spot star/winner roles worth adding rules for.
              </p>
              {data.report.unmapped.length === 0 ? (
                <p className="muted">No unmapped roles.</p>
              ) : (
                <div className="table-scroll">
                  <table className="table-dense">
                    <thead>
                      <tr>
                        <th>Role</th>
                        <th>Holders</th>
                        <th>Who</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.report.unmapped.map((u) => (
                        <UnmappedRow key={u.roleId} role={u} displayNames={data.displayNames} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}

function EntryGroup({
  kind,
  entries,
  displayNames,
}: {
  kind: RoleExpectationKind;
  entries: RoleAuditEntry[];
  displayNames: Record<string, string>;
}) {
  if (entries.length === 0) return null;
  return (
    <section style={{ marginTop: 24 }}>
      <h3>{GROUP_LABEL[kind]}</h3>
      <div className="table-scroll">
        <table className="table-dense">
          <thead>
            <tr>
              <th>Role</th>
              <th>Expected</th>
              <th>Holders</th>
              <th>Missing</th>
              <th>Extra</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <EntryRow key={e.roleId} entry={e} displayNames={displayNames} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function names(ids: string[], displayNames: Record<string, string>): string {
  if (ids.length === 0) return "-";
  return ids.map((id) => displayNames[id] ?? id).join(", ");
}

function EntryRow({
  entry,
  displayNames,
}: {
  entry: RoleAuditEntry;
  displayNames: Record<string, string>;
}) {
  return (
    <tr>
      <td>
        <strong>{entry.roleName}</strong>
        {entry.description && <div className="muted" style={{ fontSize: 11 }}>{entry.description}</div>}
      </td>
      <td>{entry.expectedCount}</td>
      <td>{entry.holderCount}</td>
      <td>
        <span className={entry.missing.length > 0 ? undefined : "muted"}>{names(entry.missing, displayNames)}</span>
        {entry.notInGuild.length > 0 && (
          <div className="muted" style={{ fontSize: 11 }}>
            +{entry.notInGuild.length} not in server: {names(entry.notInGuild, displayNames)}
          </div>
        )}
      </td>
      <td>
        <span className={entry.extra.length > 0 ? undefined : "muted"}>{names(entry.extra, displayNames)}</span>
      </td>
      <td>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <ActionFlashForm action={fixRole}>
            <input type="hidden" name="roleId" value={entry.roleId} />
            <input type="hidden" name="mode" value="add-missing" />
            <SubmitButton size="sm" variant="secondary" disabled={entry.missing.length === 0}>
              Add missing ({entry.missing.length})
            </SubmitButton>
          </ActionFlashForm>
          <ActionFlashForm action={fixRole}>
            <input type="hidden" name="roleId" value={entry.roleId} />
            <input type="hidden" name="mode" value="remove-extra" />
            <SubmitButton size="sm" variant="secondary" disabled={entry.extra.length === 0}>
              Remove extra ({entry.extra.length})
            </SubmitButton>
          </ActionFlashForm>
        </div>
      </td>
    </tr>
  );
}

function compactSeasons(row: SeasonRecordRow): ReactNode {
  if (row.memberships.length === 0) return "-";
  return row.memberships.map((m, i) => (
    <span key={`${m.seasonNumber}-${m.divisionName}`}>
      {i > 0 && ", "}
      S{m.seasonNumber} <RarityText position={m.tierPosition}>{m.divisionName}</RarityText>
      {m.finish ? ` #${m.finish}` : ""}
      {m.champion ? " *" : ""}
    </span>
  ));
}

function titlesByTierText(titlesByTier: Record<string, number>): string {
  const entries = Object.entries(titlesByTier);
  if (entries.length === 0) return "-";
  return entries.map(([tier, count]) => `${tier} x${count}`).join(", ");
}

function flagFor(row: SeasonRecordRow): { text: string; danger: boolean } {
  const parts: string[] = [];
  if (row.missingRoleNames.length > 0) parts.push(`missing ${row.missingRoleNames.join(", ")}`);
  if (row.extraRoleNames.length > 0) parts.push(`extra ${row.extraRoleNames.join(", ")}`);
  return parts.length > 0 ? { text: parts.join("; "), danger: true } : { text: "ok", danger: false };
}

function SeasonRecordSection({ rows }: { rows: SeasonRecordRow[] }) {
  return (
    <section style={{ marginTop: 24 }}>
      <h3>Season record</h3>
      <p className="muted">
        Every player with at least one division title or a winner-looking role, discrepancies first -- cross-check
        titles earned against winner roles actually held.
      </p>
      {rows.length === 0 ? (
        <p className="muted">No titled players or winner-role holders yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="table-dense">
            <thead>
              <tr>
                <th>Player</th>
                <th>Titles</th>
                <th>Seasons</th>
                <th>Roles held</th>
                <th>Flag</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const flag = flagFor(row);
                return (
                  <tr key={row.discordId}>
                    <td>{row.displayName}</td>
                    <td>{titlesByTierText(row.titlesByTier)}</td>
                    <td>{compactSeasons(row)}</td>
                    <td>{row.rolesHeld.length === 0 ? <span className="muted">-</span> : row.rolesHeld.join(", ")}</td>
                    <td style={flag.danger ? { color: "var(--danger)" } : undefined}>{flag.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function UnmappedRow({ role, displayNames }: { role: UnmappedRole; displayNames: Record<string, string> }) {
  const holderNames = role.holders.map((id) => displayNames[id] ?? id);
  return (
    <tr>
      <td>{role.roleName}</td>
      <td>{role.holders.length}</td>
      <td>
        {holderNames.length === 0 ? (
          <span className="muted">-</span>
        ) : holderNames.length <= 12 ? (
          holderNames.join(", ")
        ) : (
          <details>
            <summary style={{ cursor: "pointer" }}>{holderNames.length} holders</summary>
            {holderNames.join(", ")}
          </details>
        )}
      </td>
    </tr>
  );
}
