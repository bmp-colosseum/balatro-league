"use client";

// A submit button that asks for confirmation before letting the form submit.
// For destructive/irreversible admin actions (drop/delete/wipe) that previously
// fired on a single misclick. Works inside a server-action <form>: declining
// cancels the native submit. While the action runs it disables + shows "Working…"
// so a slow op never looks frozen (and you can't double-fire it). Renders the
// shared <Button> so confirm actions look identical to every other button.

import { useFormStatus } from "react-dom";
import type { CSSProperties, ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function ConfirmButton({
  message,
  children,
  className,
  style,
  name,
  value,
  variant = "default",
  size,
  pendingText = "Working…",
}: {
  message: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  name?: string;
  value?: string;
  variant?: "default" | "secondary" | "destructive";
  size?: "default" | "sm";
  pendingText?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant={variant}
      size={size}
      disabled={pending}
      className={className}
      style={style}
      name={name}
      value={value}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {pending ? pendingText : children}
    </Button>
  );
}
