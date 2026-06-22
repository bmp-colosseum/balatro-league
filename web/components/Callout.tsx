import type { ReactNode, CSSProperties } from "react";

// A success / danger / info / accent callout box: a .card with a colored border
// AND matching text color. Replaces the ~28 hand-rolled inline copies of this
// exact pattern so every alert/notice in the app looks identical. For a card
// that only wants a colored BORDER (not colored text), use the .card-<tone>
// class instead. See web/AGENTS.md styling conventions.

const TONE: Record<string, string> = {
  success: "var(--success)",
  danger: "var(--danger)",
  info: "var(--info)",
  accent: "var(--accent)",
  admin: "var(--admin)",
};

export function Callout({
  type = "info",
  children,
  className,
  style,
}: {
  type?: "success" | "danger" | "info" | "accent" | "admin";
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={"card" + (className ? " " + className : "")}
      style={{ borderColor: TONE[type], color: TONE[type], ...style }}
    >
      {children}
    </div>
  );
}
