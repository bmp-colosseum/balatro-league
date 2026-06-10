"use client";

// A submit button that asks for confirmation before letting the form submit.
// For destructive admin actions (drop/delete/wipe) that previously fired on a
// single misclick. Works inside a server-action <form>: declining cancels the
// native submit.

import type { CSSProperties, ReactNode } from "react";

export function ConfirmButton({
  message,
  children,
  className,
  style,
  name,
  value,
}: {
  message: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  name?: string;
  value?: string;
}) {
  return (
    <button
      type="submit"
      className={className}
      style={style}
      name={name}
      value={value}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
