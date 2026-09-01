// Compact, self-updating "when does this season run" line for public season
// surfaces (standings, /seasons, /seasons/[id]) — server component, renders
// dates via LocalDateTime so they show in the viewer's own timezone instead
// of a server-stamped UTC string.
//
// Takes two OPTIONAL dates and picks the phrasing from what's actually known:
//   both start + end  -> "Runs <start> to <end>"
//   start only        -> "Starts <start>" / "Started <start>" once it's passed
//   end only          -> "Ends <end>" / "Ended <end>" once it's passed
//   neither           -> a TBA line
// Tense is derived from the date itself rather than a caller-passed flag, so a
// live season never reads "Starts <a month ago>".
// Callers decide which concrete fields map to "start"/"end" for their
// season's state (e.g. an active season passes startedAt + scheduledEndAt;
// a not-yet-started one passes scheduledStartAt + nothing).

import type { ReactNode } from "react";
import { LocalDateTime } from "./LocalDateTime";

export interface SeasonWindowProps {
  start?: Date | string | null;
  end?: Date | string | null;
  className?: string;
}

function toIso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return typeof d === "string" ? d : d.toISOString();
}

// Past tense once the moment has passed. An unparseable date falls back to the
// future form rather than throwing.
function isPast(iso: string | null): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t < Date.now();
}

export function SeasonWindow({ start, end, className }: SeasonWindowProps) {
  const startIso = toIso(start);
  const endIso = toIso(end);

  let content: ReactNode;
  if (startIso && endIso) {
    content = (
      <>
        Runs <LocalDateTime iso={startIso} style="date" /> to <LocalDateTime iso={endIso} style="date" />
      </>
    );
  } else if (startIso) {
    content = (
      <>
        {isPast(startIso) ? "Started" : "Starts"} <LocalDateTime iso={startIso} style="date" />
      </>
    );
  } else if (endIso) {
    content = (
      <>
        {isPast(endIso) ? "Ended" : "Ends"} <LocalDateTime iso={endIso} style="date" />
      </>
    );
  } else {
    content = "Season dates TBA";
  }

  return (
    <div className={["muted", className].filter(Boolean).join(" ")} style={{ fontSize: 12 }}>
      {content}
    </div>
  );
}
