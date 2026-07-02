"use client";

// IANA timezone dropdown that auto-detects the visitor's zone as the default.
// Plain <select> so it posts with the form like a native field.
import { useEffect, useState } from "react";

export function TimezoneSelect({ name, defaultValue, className }: { name: string; defaultValue?: string | null; className?: string }) {
  const [zones, setZones] = useState<string[]>([]);
  const [value, setValue] = useState<string>(defaultValue ?? "");

  useEffect(() => {
    // Intl.supportedValuesOf is browser-only; build the list + detect on mount.
    let list: string[] = [];
    try {
      list = Intl.supportedValuesOf("timeZone");
    } catch {
      list = [];
    }
    setZones(list);
    if (!defaultValue) {
      try {
        setValue(Intl.DateTimeFormat().resolvedOptions().timeZone ?? "");
      } catch {
        /* leave empty */
      }
    }
  }, [defaultValue]);

  return (
    <select name={name} value={value} onChange={(e) => setValue(e.target.value)} className={className}>
      <option value="">— pick your timezone —</option>
      {/* Keep the saved value selectable even if the browser list omits it */}
      {value && !zones.includes(value) && <option value={value}>{value}</option>}
      {zones.map((z) => (
        <option key={z} value={z}>{z}</option>
      ))}
    </select>
  );
}
