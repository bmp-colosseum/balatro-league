"use client";

// Submit button that shows a pending state while its <form>'s server action
// runs — disables + flips to "Working…" so a slow admin op never looks frozen
// and can't be double-fired. For plain (non-confirm) forms; destructive ones use
// ConfirmButton, which is also pending-aware.

import { useFormStatus } from "react-dom";
import type { CSSProperties, ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function SubmitButton({
  children,
  pendingText = "Working…",
  className,
  variant,
  size,
  style,
  title,
  disabled,
}: {
  children: ReactNode;
  pendingText?: string;
  className?: string;
  variant?: "default" | "secondary";
  size?: "sm" | "default";
  style?: CSSProperties;
  title?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || disabled} className={className} variant={variant} size={size} style={style} title={title}>
      {pending ? pendingText : children}
    </Button>
  );
}
