// One card grouping unit for admin pages: an optional title (+ optional right-aligned
// action) and description, then the content. Standardizes on the .card token so every
// admin section looks the same instead of a mix of .bracket-title and bare <h2>.
import type { ReactNode } from "react";

export function Section({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const hasHead = title != null || action != null || description != null;
  return (
    <div className={`card ${className ?? ""}`.trim()}>
      {(title != null || action != null) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {title != null ? <div className="bracket-title" style={{ padding: 0 }}>{title}</div> : <span />}
          {action}
        </div>
      )}
      {description != null && <p className="sub" style={{ margin: "4px 0 0" }}>{description}</p>}
      <div className={hasHead ? "mt-2" : ""}>{children}</div>
    </div>
  );
}
