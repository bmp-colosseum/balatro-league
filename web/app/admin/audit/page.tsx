// Append-only audit log viewer. Reads AdminAuditEvent and renders a
// filterable, cursor-paginated table. Server-rendered; no client JS
// needed — all filters are GET params on a form. Cursor is the
// createdAt timestamp + id of the last row on the current page so
// pagination survives concurrent inserts.

import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { unstable_cache } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { SiteNav } from "@/components/SiteNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormSelect } from "@/components/FormSelect";
import { AdminNav } from "@/components/AdminNav";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

// The filter-dropdown lists (distinct actors/actions/targets) and the unfiltered
// total require full scans of the audit table — expensive and slow-changing, so
// cache them. The paginated page rows stay live (cursor-based, indexed).
const loadAuditFilterOptions = unstable_cache(
  async () => {
    const [actorRows, actionRows, targetRows] = await Promise.all([
      prisma.adminAuditEvent.findMany({
        distinct: ["actorDiscordId"],
        select: { actorDiscordId: true, actorName: true },
        orderBy: { actorName: "asc" },
        take: 200,
      }),
      prisma.adminAuditEvent.findMany({
        distinct: ["action"],
        select: { action: true },
        orderBy: { action: "asc" },
        take: 200,
      }),
      prisma.adminAuditEvent.findMany({
        distinct: ["targetType"],
        where: { targetType: { not: null } },
        select: { targetType: true },
        orderBy: { targetType: "asc" },
        take: 200,
      }),
    ]);
    return { actorRows, actionRows, targetRows };
  },
  ["audit-filter-options"],
  { revalidate: 300, tags: ["audit"] },
);

const loadAuditTotalCount = unstable_cache(
  async () => prisma.adminAuditEvent.count(),
  ["audit-total-count"],
  { revalidate: 60, tags: ["audit"] },
);

interface SearchParams {
  actor?: string;
  action?: string;
  target?: string;
  since?: string;
  until?: string;
  q?: string;
  before?: string; // cursor: ISO timestamp of last row on previous page
}

function parseDate(input: string | undefined): Date | null {
  if (!input) return null;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatTimestamp(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function buildSearchString(params: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v && v.length > 0) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAdmin();
  const sp = await searchParams;

  // Build the WHERE clause from filters.
  const where: Prisma.AdminAuditEventWhereInput = {};
  if (sp.actor) where.actorDiscordId = sp.actor;
  if (sp.action) where.action = sp.action;
  if (sp.target) where.targetType = sp.target;
  const since = parseDate(sp.since);
  const until = parseDate(sp.until);
  if (since || until) {
    where.createdAt = {
      ...(since ? { gte: since } : {}),
      ...(until ? { lte: until } : {}),
    };
  }
  if (sp.q) {
    where.summary = { contains: sp.q, mode: "insensitive" };
  }
  const before = parseDate(sp.before);
  if (before) {
    where.createdAt = { ...(where.createdAt as object | undefined), lt: before };
  }

  // The live, indexed bit: this page's rows. The filter dropdowns + the
  // unfiltered total come from the cached helpers (slow-changing). An exact
  // filtered count is only computed when a filter is actually applied.
  const hasFilter = !!(sp.actor || sp.action || sp.target || sp.since || sp.until || sp.q);
  const [rows, { actorRows, actionRows, targetRows }, totalCount] = await Promise.all([
    prisma.adminAuditEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE + 1, // one extra to know if there's a next page
    }),
    loadAuditFilterOptions(),
    hasFilter ? prisma.adminAuditEvent.count({ where }) : loadAuditTotalCount(),
  ]);

  const hasNextPage = rows.length > PAGE_SIZE;
  const pageRows = hasNextPage ? rows.slice(0, PAGE_SIZE) : rows;
  const nextCursor = hasNextPage ? pageRows[pageRows.length - 1]!.createdAt.toISOString() : null;

  // Preserve current filters on the next-page link (everything except `before`).
  const nextHref = nextCursor
    ? `/admin/audit${buildSearchString({
        actor: sp.actor,
        action: sp.action,
        target: sp.target,
        since: sp.since,
        until: sp.until,
        q: sp.q,
        before: nextCursor,
      })}`
    : null;
  const firstPageHref = `/admin/audit${buildSearchString({
    actor: sp.actor,
    action: sp.action,
    target: sp.target,
    since: sp.since,
    until: sp.until,
    q: sp.q,
  })}`;

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/audit" />
      <main>
        <h2>📜 Audit log</h2>
        <p className="muted">
          Append-only log of admin actions + key system events. Filters are GET params, so
          you can bookmark / share a specific view.
        </p>

        <form method="get" action="/admin/audit" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, alignItems: "end", marginBottom: 16 }}>
          <label>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Actor</div>
            <FormSelect
              name="actor"
              defaultValue={sp.actor ?? ""}
              triggerClassName="w-full"
              options={[
                { value: "", label: "All actors" },
                ...actorRows.map((a) => ({
                  value: a.actorDiscordId,
                  label: `${a.actorName}${a.actorDiscordId === "system" ? "" : ` · ${a.actorDiscordId.slice(-6)}`}`,
                })),
              ]}
            />
          </label>
          <label>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Action</div>
            <FormSelect
              name="action"
              defaultValue={sp.action ?? ""}
              triggerClassName="w-full"
              options={[
                { value: "", label: "All actions" },
                ...actionRows.map((a) => ({ value: a.action, label: a.action })),
              ]}
            />
          </label>
          <label>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Target type</div>
            <FormSelect
              name="target"
              defaultValue={sp.target ?? ""}
              triggerClassName="w-full"
              options={[
                { value: "", label: "Any target" },
                ...targetRows.map((t) => ({ value: t.targetType!, label: t.targetType! })),
              ]}
            />
          </label>
          <label>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Summary contains</div>
            <Input name="q" type="text" placeholder="text search…" defaultValue={sp.q ?? ""} />
          </label>
          <label>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Since</div>
            <Input name="since" type="datetime-local" defaultValue={sp.since ?? ""} />
          </label>
          <label>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Until</div>
            <Input name="until" type="datetime-local" defaultValue={sp.until ?? ""} />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <Button type="submit">Apply</Button>
            <Link href="/admin/audit" className="secondary" style={{ alignSelf: "center" }}>Reset</Link>
          </div>
          <div className="muted" style={{ textAlign: "right", fontSize: 12 }}>
            {totalCount.toLocaleString()} matching row(s)
          </div>
        </form>

        {pageRows.length === 0 ? (
          <p className="muted">No audit events match your filters.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #444", textAlign: "left" }}>
                <th style={{ padding: "8px 4px", whiteSpace: "nowrap" }}>When</th>
                <th style={{ padding: "8px 4px" }}>Actor</th>
                <th style={{ padding: "8px 4px" }}>Action</th>
                <th style={{ padding: "8px 4px" }}>Target</th>
                <th style={{ padding: "8px 4px" }}>Summary</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => (
                <tr key={row.id} style={{ borderBottom: "1px solid #2a2a2a", verticalAlign: "top" }}>
                  <td style={{ padding: "6px 4px", whiteSpace: "nowrap", fontFamily: "monospace", color: "#888" }}>
                    {formatTimestamp(row.createdAt)}
                  </td>
                  <td style={{ padding: "6px 4px", whiteSpace: "nowrap" }}>
                    {row.actorDiscordId === "system" ? (
                      <span className="muted">system</span>
                    ) : (
                      <span>
                        {row.actorName}{" "}
                        <span className="muted" style={{ fontSize: 11, fontFamily: "monospace" }}>{row.actorDiscordId}</span>
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "6px 4px", fontFamily: "monospace", fontSize: 12, color: "#bdc3c7" }}>
                    {row.action}
                  </td>
                  <td style={{ padding: "6px 4px", fontFamily: "monospace", fontSize: 12, color: "#95a5a6" }}>
                    {row.targetType ? `${row.targetType}${row.targetId ? ` ${row.targetId.slice(-6)}` : ""}` : "—"}
                  </td>
                  <td style={{ padding: "6px 4px" }}>
                    {row.summary}
                    {row.metadata != null && (
                      <details style={{ marginTop: 4 }}>
                        <summary className="muted" style={{ cursor: "pointer", fontSize: 11 }}>metadata</summary>
                        <pre style={{ fontSize: 11, color: "#7f8c8d", marginTop: 4, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                          {JSON.stringify(row.metadata, null, 2)}
                        </pre>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16 }}>
          {sp.before ? (
            <Link href={firstPageHref} className="secondary">← First page</Link>
          ) : (
            <span />
          )}
          {nextHref ? (
            <Link href={nextHref} className="secondary">Next page →</Link>
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>End of log</span>
          )}
        </div>
      </main>
    </>
  );
}
