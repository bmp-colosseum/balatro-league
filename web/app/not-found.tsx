// Global 404 -- Next.js renders this for any unmatched route (and any
// explicit notFound() call) inside the root layout, so it needs its own
// SiteNav rather than leaving a visitor on an unbranded, nav-less page with
// no way back in (see .claude/knowledge/ux-audit/01-findings.md, backlog #33).

import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { SiteNav } from "@/components/SiteNav";
import { TOUR_PUBLIC_URL } from "@/lib/tour-profile";

export default function NotFound() {
  return (
    <>
      <SiteNav activePath="" />
      <main>
        <div className="card" style={{ textAlign: "center", padding: "32px 16px" }}>
          <h1 style={{ marginTop: 0 }}>That page does not exist</h1>
          <p className="muted">The link may be old, or the page may have moved.</p>
          <p style={{ marginTop: 16, display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap", alignItems: "center" }}>
            <Link
              href="/"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                background: "var(--accent)",
                color: "#2a1d05",
                padding: "8px 16px",
                borderRadius: 4,
                textDecoration: "none",
                fontWeight: 600,
              }}
            >
              <ArrowLeft size={16} /> Back to standings
            </Link>
            {/* Lucide arrow icon, not a typed "->" beside a button that uses
                a real arrow glyph (ux-round5 L43). */}
            <Link href="/join" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              Join the league <ArrowRight size={14} aria-hidden="true" />
            </Link>
            {/* The league's sibling site -- same URL the Tour's own product
                switcher uses to link back (lib/tour-profile.ts). */}
            <a href={TOUR_PUBLIC_URL} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              Team Tour <ArrowRight size={14} aria-hidden="true" />
            </a>
          </p>
        </div>
      </main>
    </>
  );
}
