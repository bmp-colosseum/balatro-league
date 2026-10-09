"use server";

// Admin-only toggle for the v2 "Card Table" redesign preview. Flips the
// `league-ui=v2` cookie that web/app/layout.tsx reads to decide whether to
// render <html data-ui="v2">. Both actions redirect back to wherever the
// control was clicked from (same-origin only -- the referer header is never
// trusted blindly, since it can be spoofed into an open redirect).

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { setUiPreviewV2 } from "@/lib/preferences";

async function returnPath(): Promise<string> {
  const h = await headers();
  const referer = h.get("referer");
  const host = h.get("host");
  if (!referer || !host) return "/admin";
  try {
    const url = new URL(referer);
    if (url.host !== host) return "/admin";
    return url.pathname + url.search;
  } catch {
    return "/admin";
  }
}

export async function enableUiPreviewAction(): Promise<void> {
  await requireAdmin();
  await setUiPreviewV2(true);
  redirect(await returnPath());
}

export async function disableUiPreviewAction(): Promise<void> {
  await requireAdmin();
  await setUiPreviewV2(false);
  redirect(await returnPath());
}
