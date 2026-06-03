"use client";

// Render a server-supplied Date in the viewer's local timezone.
//
// Server components have no idea what timezone the user is in (they're
// running in UTC on Railway). Doing `date.toLocaleString()` on the
// server returns a UTC-formatted string. To get the viewer's actual
// local time we have to format on the client — useEffect kicks in
// after hydration to swap the rendered string.
//
// Until hydration, we render the server-stamped fallback (ISO date in
// UTC) so the SSR HTML isn't blank. Once mounted, that gets replaced
// with the locale-formatted string. Brief flash, but no hydration
// mismatch warning since both branches render the same `<time>` shape.

import { useEffect, useState } from "react";

export interface LocalDateTimeProps {
  iso: string;
  // Style of output. "datetime" = "Jun 3, 2026, 3:00 PM"; "date" = just
  // the date; "relative" = "3 days from now" (not implemented yet,
  // falls back to datetime).
  style?: "datetime" | "date";
  // Optional fallback string used during SSR before hydration. Defaults
  // to the ISO truncated to the date — readable enough for the first
  // paint without giving away that we're swapping.
  fallback?: string;
}

export function LocalDateTime({ iso, style = "datetime", fallback }: LocalDateTimeProps) {
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      setLocal(iso);
      return;
    }
    const fmt = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      ...(style === "datetime" ? { timeStyle: "short" } : {}),
    });
    setLocal(fmt.format(d));
  }, [iso, style]);
  return <time dateTime={iso}>{local ?? fallback ?? iso.slice(0, 10)}</time>;
}
