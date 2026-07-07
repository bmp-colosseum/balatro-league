// One page header for every admin surface: an optional back-link, the title (with an
// optional icon), an optional right-aligned action cluster, and an optional sub line.
// Replaces the copy-pasted <p><Link ArrowLeft/></p><h1> block so the admin pages read
// as one tool. Server component -- pure presentation.
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

export function AdminPageHeader({
  back,
  title,
  icon,
  actions,
  sub,
}: {
  back?: { href: string; label: string };
  title: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      {back && (
        <p style={{ margin: "0 0 4px" }}>
          <Link href={back.href} className="sub inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {back.label}</Link>
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="inline-flex items-center gap-2" style={{ margin: 0 }}>{icon}{title}</h1>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {sub && <p className="sub" style={{ margin: "6px 0 0" }}>{sub}</p>}
    </div>
  );
}
