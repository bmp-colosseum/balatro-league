"use client";

// Cosmetic live-ticking elapsed timer ("on the clock for 2h 14m 3s") — a clock is fun,
// never a gate. Renders nothing until mounted (avoids SSR/client time mismatch).
import { useEffect, useState } from "react";

function fmt(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function ElapsedClock({ since, prefix = "on the clock for " }: { since: string; prefix?: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);
  if (now == null) return null;
  const start = new Date(since).getTime();
  if (!Number.isFinite(start)) return null;
  return (
    <span style={{ fontVariantNumeric: "tabular-nums" }}>
      {prefix}
      {fmt((now - start) / 1000)}
    </span>
  );
}
