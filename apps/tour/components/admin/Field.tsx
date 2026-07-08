// The ONE input class for admin forms -- import this instead of re-declaring a local
// `inputCls` per page. That copy-paste drifted into px-2 py-1 vs px-2 py-0.5 vs px-1.5
// across ~6 surfaces; a single source kills the drift by construction. Two densities:
//   fieldInput   -- standalone form fields (labeled inputs in a Section)
//   fieldInputSm -- inline / in-table inputs (dense, fits a table row)
import type { ReactNode } from "react";

export const fieldInput =
  "rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1";
export const fieldInputSm =
  "rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5";

// Labeled field wrapper for the common admin form field:
//   <Field label="Role ID"><input className={fieldInput} name="..." /></Field>
// The label is the muted `.sub` caption every admin form already uses; children is the
// control itself, so number / select / width-variant inputs stay flexible.
export function Field({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className ?? ""}`.trim()}>
      <span className="sub">{label}</span>
      {children}
    </label>
  );
}
