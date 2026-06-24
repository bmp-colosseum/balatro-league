"use client";

// A calendar date picker that records the chosen day as a UTC ISO instant (noon
// local, so the date renders correctly in every viewer's timezone — same reason
// LocalDateTimeField exists). Click the button → a calendar pops; pick a day →
// it closes and fills the hidden input the server action reads. First real
// calendar input in the app; reuse it for any date field.

import { useState } from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { Button } from "@/components/ui/button";

function toIso(d: Date | undefined): string {
  if (!d) return "";
  const x = new Date(d);
  x.setHours(12, 0, 0, 0); // noon local → safe across timezones for date-only
  return x.toISOString();
}

export function DatePickerField({
  name,
  defaultIso,
  placeholder = "Pick a date",
}: {
  name: string;
  defaultIso?: string | null;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Date | undefined>(defaultIso ? new Date(defaultIso) : undefined);

  const label = selected
    ? selected.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : placeholder;

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <input type="hidden" name={name} value={toIso(selected)} />
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen((o) => !o)}>
        📅 <span suppressHydrationWarning>{label}</span>
      </Button>
      {open && (
        <div
          style={
            {
              position: "absolute",
              zIndex: 60,
              marginTop: 4,
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: 8,
              boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
              color: "var(--text)",
              "--rdp-accent-color": "var(--accent-2)",
              "--rdp-accent-background-color": "color-mix(in srgb, var(--accent-2) 28%, transparent)",
              "--rdp-today-color": "var(--accent)",
            } as React.CSSProperties
          }
        >
          <DayPicker
            mode="single"
            selected={selected}
            onSelect={(d) => {
              setSelected(d);
              if (d) setOpen(false);
            }}
            captionLayout="dropdown"
          />
        </div>
      )}
    </div>
  );
}
