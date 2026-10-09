// Global 404 -- Next.js renders this for any unmatched route (and any
// explicit notFound() call) inside the root layout, so it needs its own
// SiteNav rather than leaving a visitor on an unbranded, nav-less page with
// no way back in (see .claude/knowledge/ux-audit/01-findings.md, backlog #33).

import Link from "next/link";
import { SiteNav } from "@/components/SiteNav";

export default function NotFound() {
  return (
    <>
      <SiteNav activePath="" />
      <main>
        <div className="card" style={{ textAlign: "center", padding: "32px 16px" }}>
          <h2 style={{ marginTop: 0 }}>That page does not exist</h2>
          <p className="muted">The link may be old, or the page may have moved.</p>
          <p style={{ marginTop: 16, display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap" }}>
            <Link href="/standings">&lt;- Standings</Link>
            <Link href="/join">Join the league -&gt;</Link>
          </p>
        </div>
      </main>
    </>
  );
}
