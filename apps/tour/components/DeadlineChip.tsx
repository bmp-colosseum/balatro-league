// A soft "target date" chip for a week's deadline. Renders nothing when there's no
// target (blank = no nudge). Never alarmist: an upcoming target is accent-blue, a past
// one just goes muted -- a nudge, not a lock ("rails not gates"). Server component.
import { CalendarClock } from "lucide-react";
import { formatDeadlineShortET, formatDeadlineFullET, deadlineRelative } from "@/lib/date";

export function DeadlineChip({ deadline, now, prefix = "target" }: { deadline: Date | string | null; now?: Date; prefix?: string }) {
  if (!deadline) return null;
  const d = typeof deadline === "string" ? new Date(deadline) : deadline;
  if (Number.isNaN(d.getTime())) return null;
  const rel = deadlineRelative(d, now ?? new Date());
  return (
    <span
      className="badge inline-flex items-center gap-1"
      title={`Target to play by ${formatDeadlineFullET(d)} (soft -- a nudge, not a hard deadline)`}
      style={{ color: rel.past ? "var(--muted)" : "var(--accent-2)", whiteSpace: "nowrap" }}
    >
      <CalendarClock className="size-3" />
      {prefix} {formatDeadlineShortET(d)} ({rel.text})
    </span>
  );
}
