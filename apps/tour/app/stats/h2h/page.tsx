import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { CSSProperties } from "react";
import { getH2HMatrix } from "@/lib/records";

export const dynamic = "force-dynamic";

function cellBg(rec: { w: number; l: number } | undefined): string {
  if (!rec) return "var(--surface)";
  if (rec.w > rec.l) return "rgba(46,204,113,0.20)";
  if (rec.w < rec.l) return "rgba(231,76,60,0.20)";
  return "var(--surface-2)";
}
const short = (n: string) => (n.length > 10 ? n.slice(0, 9) + "…" : n);
const cell: CSSProperties = { border: "none", fontSize: 11, padding: "3px 5px", borderRadius: 4, textAlign: "center" };

export default async function H2HMatrixPage() {
  const m = await getH2HMatrix(16);

  return (
    <main>
      <p>
        <Link href="/stats" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> stats</Link>
      </p>
      <h1>Head-to-head matrix</h1>
      <p className="sub">
        Set records between the {m.players.length} most-active players — each row&apos;s record vs the column.
        <span style={{ color: "var(--success)" }}> Green</span> = row leads,
        <span style={{ color: "var(--danger)" }}> red</span> = column leads, blank = never played (sparse — players
        rarely replay across seasons).
      </p>

      <div className="card table-scroll">
        <table style={{ borderCollapse: "separate", borderSpacing: 2 }}>
          <thead>
            <tr>
              <th style={{ border: "none" }}></th>
              {m.players.map((c) => (
                <th key={c.id} style={{ ...cell, color: "var(--muted)", maxWidth: 64 }} title={c.name}>
                  {short(c.name)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.players.map((r) => (
              <tr key={r.id}>
                <td style={{ border: "none", whiteSpace: "nowrap", fontWeight: 600, fontSize: 12, paddingRight: 8 }}>
                  <Link href={`/players/${r.id}`}>{short(r.name)}</Link>
                </td>
                {m.players.map((c) => {
                  if (r.id === c.id) return <td key={c.id} style={{ ...cell, background: "var(--surface-2)" }} />;
                  const rec = m.records[r.id]?.[c.id];
                  return (
                    <td key={c.id} style={{ ...cell, background: cellBg(rec) }} title={`${r.name} vs ${c.name}`}>
                      {rec ? `${rec.w}–${rec.l}` : ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
