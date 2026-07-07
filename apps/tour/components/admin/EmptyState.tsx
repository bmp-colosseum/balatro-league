// One positive empty state for admin lists/tables -- a calm centered card, not a bare
// <p> in one place and a <Callout> in another. Tone "success" reads as "all handled".
import type { ReactNode } from "react";

export function EmptyState({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "success" }) {
  return (
    <div className="card" style={{ textAlign: "center", padding: "26px 16px" }}>
      <span style={{ color: tone === "success" ? "var(--success)" : "var(--muted)" }}>{children}</span>
    </div>
  );
}
