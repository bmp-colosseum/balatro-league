"use client";

// Subscribes to a live scope via SSE and refreshes the (server-rendered) page when
// something changes — no client state, no polling. Renders nothing.
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export function LiveRefresh({ channel }: { channel: string }) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/live/${encodeURIComponent(channel)}`);
    es.onmessage = (e) => {
      if (e.data === "hello") return;
      // Debounce bursts (e.g. a pairing + rollup in quick succession).
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => router.refresh(), 150);
    };
    return () => {
      es.close();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [channel, router]);

  return null;
}
