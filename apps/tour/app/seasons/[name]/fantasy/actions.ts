"use server";

// Manager-facing fantasy actions. Identity ALWAYS comes from getViewer() (the signed-in
// Discord user) - never from FormData - so a manager can only act as themselves. Join is a
// standalone form (inline banner); picks are a grid of buttons (toast, per the many-actions
// convention). The service enforces turn order, ownership, and unique picks.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/auth";
import { joinFantasyLeague, makeFantasyPick, proposeTrade, respondToTrade, cancelTrade, getFantasyTradePanel } from "@/lib/services/fantasy";
import type { ActionResult } from "@/lib/action-result";

export async function joinFantasyAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const v = await getViewer();
  if (!v.discordId) return { ok: false, message: "Sign in with Discord to join." };
  const season = String(formData.get("season") ?? "");
  try {
    const name = String(formData.get("managerName") ?? "").trim() || v.name || v.discordId;
    const r = await joinFantasyLeague(season, { discordId: v.discordId, name });
    revalidatePath(`/seasons/${encodeURIComponent(season)}/fantasy`);
    return { ok: true, message: `You're in as manager ${r.managerCount} of up to ${r.cap}. The draft starts when the TO opens it.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Couldn't join the league." };
  }
}

export async function makePickAction(formData: FormData) {
  const season = String(formData.get("season") ?? "");
  const enc = encodeURIComponent(season);
  const v = await getViewer();
  let ok = true;
  let msg = "Picked.";
  if (!v.discordId) {
    ok = false;
    msg = "Sign in with Discord to draft.";
  } else {
    try {
      const r = await makeFantasyPick(season, v.discordId, String(formData.get("playerId") ?? ""));
      msg = r.done ? "That's a wrap - the fantasy draft is complete!" : "Picked.";
    } catch (e) {
      ok = false;
      msg = e instanceof Error ? e.message : "Couldn't make that pick.";
    }
  }
  revalidatePath(`/seasons/${enc}/fantasy/draft`);
  revalidatePath(`/seasons/${enc}/fantasy`);
  const qs = new URLSearchParams();
  qs.set(ok ? "ok" : "err", msg);
  redirect(`/seasons/${enc}/fantasy/draft?${qs.toString()}`);
}

// Propose an N-for-N trade. The client sends the partner (receiverTeamId) + the multi-selected
// give[]/receive[]; the service re-validates ownership (all give are the proposer's, all receive
// are the receiver's) and the even swap, so a spoofed receiverTeamId simply fails those checks.
// receiverTeamId is derived from the first requested player's owner as a fallback (no client field).
export async function proposeTradeAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const v = await getViewer();
  if (!v.discordId) return { ok: false, message: "Sign in with Discord to trade." };
  const season = String(formData.get("season") ?? "");
  const give = formData.getAll("give").map(String).filter(Boolean);
  const receive = formData.getAll("receive").map(String).filter(Boolean);
  if (!give.length || !receive.length) return { ok: false, message: "Pick at least one player to give and one to get." };
  try {
    let receiverTeamId = String(formData.get("receiverTeamId") ?? "");
    if (!receiverTeamId) {
      const panel = await getFantasyTradePanel(season, v.discordId);
      if (!panel) return { ok: false, message: "No fantasy league for this season." };
      receiverTeamId = Object.entries(panel.rosterByTeam).find(([, roster]) => roster.some((p) => p.playerId === receive[0]))?.[0] ?? "";
    }
    if (!receiverTeamId) return { ok: false, message: "Couldn't tell who you're trading with." };
    await proposeTrade(season, v.discordId, { receiverTeamId, give, receive, reason: String(formData.get("reason") ?? "") || undefined });
    revalidatePath(`/seasons/${encodeURIComponent(season)}/fantasy`);
    return { ok: true, message: `Trade offer sent (${give.length}-for-${receive.length}).` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Couldn't propose that trade." };
  }
}

// Accept/reject an incoming offer (receiver) - per-row button -> toast.
export async function respondTradeAction(formData: FormData) {
  const season = String(formData.get("season") ?? "");
  const enc = encodeURIComponent(season);
  const v = await getViewer();
  let ok = true;
  let msg = "Done.";
  if (!v.discordId) {
    ok = false;
    msg = "Sign in with Discord.";
  } else {
    try {
      const accept = String(formData.get("accept") ?? "") === "1";
      const r = await respondToTrade(String(formData.get("tradeId") ?? ""), v.discordId, accept);
      msg = !accept ? "Offer rejected." : r.status === "APPLIED" ? "Trade accepted - rosters updated." : "Accepted - awaiting TO approval.";
    } catch (e) {
      ok = false;
      msg = e instanceof Error ? e.message : "Couldn't respond to that offer.";
    }
  }
  revalidatePath(`/seasons/${enc}/fantasy`);
  const qs = new URLSearchParams();
  qs.set(ok ? "ok" : "err", msg);
  redirect(`/seasons/${enc}/fantasy?${qs.toString()}`);
}

// Withdraw an offer you proposed - per-row button -> toast.
export async function cancelTradeAction(formData: FormData) {
  const season = String(formData.get("season") ?? "");
  const enc = encodeURIComponent(season);
  const v = await getViewer();
  let ok = true;
  let msg = "Offer withdrawn.";
  if (!v.discordId) {
    ok = false;
    msg = "Sign in with Discord.";
  } else {
    try {
      await cancelTrade(String(formData.get("tradeId") ?? ""), v.discordId);
    } catch (e) {
      ok = false;
      msg = e instanceof Error ? e.message : "Couldn't withdraw that offer.";
    }
  }
  revalidatePath(`/seasons/${enc}/fantasy`);
  const qs = new URLSearchParams();
  qs.set(ok ? "ok" : "err", msg);
  redirect(`/seasons/${enc}/fantasy?${qs.toString()}`);
}
