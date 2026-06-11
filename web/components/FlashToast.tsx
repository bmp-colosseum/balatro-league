"use client";

// Turns server-action redirect flashes (?ok=… / ?err=…) into Sonner toasts,
// then strips the params from the URL so they don't re-fire on refresh/back.
// Drop <FlashToast /> on any page whose actions redirect with ?ok / ?err.
// Optionally pass `messages` to map short codes (e.g. "recorded") to friendly
// text; unmapped values are shown as-is.

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

export function FlashToast({ messages = {} }: { messages?: Record<string, string> }) {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    const ok = sp.get("ok");
    const err = sp.get("err");
    if (!ok && !err) return;
    fired.current = true;

    if (ok) toast.success(messages[ok] ?? ok);
    if (err) toast.error(messages[err] ?? err);

    const next = new URLSearchParams(sp.toString());
    next.delete("ok");
    next.delete("err");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [sp, router, pathname, messages]);

  return null;
}
