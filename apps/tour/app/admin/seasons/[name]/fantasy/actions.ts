"use server";

// Fantasy admin actions (TO only). Open a league, remove a pre-draft manager, start the
// snake draft. Standalone forms return an ActionResult (inline banner); the per-row manager
// remove redirects with a toast (per-row table convention).
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { openFantasyLeague, startFantasyDraft, removeFantasyTeam, advanceFantasyLock, setFantasyTradeConfig, decideTradeAsTO } from "@/lib/services/fantasy";
import type { ActionResult } from "@/lib/action-result";

function rev(season: string) {
  const enc = encodeURIComponent(season);
  revalidatePath(`/admin/seasons/${enc}/fantasy`);
  revalidatePath(`/admin/seasons/${enc}`);
  revalidatePath(`/seasons/${enc}/fantasy`);
}

// Per-row table action -> Sonner toast (not an inline banner). Redirect throws, so call it
// OUTSIDE the try.
function backToFantasy(season: string, msg: string, ok = true): never {
  const qs = new URLSearchParams();
  qs.set(ok ? "ok" : "err", msg);
  redirect(`/admin/seasons/${encodeURIComponent(season)}/fantasy?${qs.toString()}`);
}

export async function openFantasyAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  try {
    const scope = String(formData.get("scope") ?? "SEASON") === "PLAYOFFS" ? "PLAYOFFS" : "SEASON";
    const roster = Number(formData.get("rosterSize"));
    // Points may legitimately be 0 (game-only or set-only scoring), so an empty field -> the
    // service default, but a present 0 is honored.
    const pts = (k: string): number | undefined => {
      const raw = formData.get(k);
      if (raw == null || String(raw).trim() === "") return undefined;
      const v = Number(raw);
      return Number.isFinite(v) && v >= 0 ? v : undefined;
    };
    await openFantasyLeague(season, {
      scope,
      rosterSize: Number.isFinite(roster) && roster > 0 ? Math.floor(roster) : undefined,
      setWinPoints: pts("setWinPoints"),
      gameWinPoints: pts("gameWinPoints"),
    });
    rev(season);
    return { ok: true, message: `Fantasy league opened (${scope.toLowerCase()}). Managers can join now.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Couldn't open the league." };
  }
}

export async function startDraftAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  try {
    const order = formData.getAll("order").map(String).filter(Boolean);
    const r = await startFantasyDraft(season, order.length ? order : undefined);
    rev(season);
    return { ok: true, message: `Draft started - ${r.teams} managers, ${r.totalPicks} picks. Manager 1 is on the clock.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Couldn't start the draft." };
  }
}

export async function deleteFantasyTeamAction(formData: FormData) {
  if (!(await isAdmin())) return;
  const season = String(formData.get("season") ?? "");
  let msg = "Manager removed.";
  let ok = true;
  try {
    await removeFantasyTeam(String(formData.get("teamId") ?? ""));
  } catch (e) {
    ok = false;
    msg = e instanceof Error ? e.message : "Couldn't remove the manager.";
  }
  rev(season);
  backToFantasy(season, msg, ok);
}

export async function advanceLockAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  try {
    const r = await advanceFantasyLock(season, Number(formData.get("throughWeek") ?? 0));
    rev(season);
    return { ok: true, message: `Roster lock set through week ${r.lockedThroughWeek}. New trades land after it.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Couldn't set the lock." };
  }
}

export async function setTradeConfigAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  try {
    const deadlineRaw = String(formData.get("tradeDeadlineWeek") ?? "").trim();
    const deadline = deadlineRaw === "" ? null : Math.max(0, Math.floor(Number(deadlineRaw) || 0));
    await setFantasyTradeConfig(season, {
      tradesEnabled: String(formData.get("tradesEnabled") ?? "") === "on",
      tradeApproval: String(formData.get("tradeApproval") ?? "AUTO") === "TO_APPROVED" ? "TO_APPROVED" : "AUTO",
      tradeDeadlineWeek: deadline,
    });
    rev(season);
    return { ok: true, message: "Trade settings saved." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Couldn't save trade settings." };
  }
}

// TO approve/reject a queued trade (TO_APPROVED leagues) - per-row button -> toast.
export async function decideTradeAction(formData: FormData) {
  if (!(await isAdmin())) return;
  const season = String(formData.get("season") ?? "");
  const approve = String(formData.get("approve") ?? "") === "1";
  let msg = approve ? "Trade approved." : "Trade rejected.";
  let ok = true;
  try {
    await decideTradeAsTO(String(formData.get("tradeId") ?? ""), approve);
  } catch (e) {
    ok = false;
    msg = e instanceof Error ? e.message : "Couldn't decide that trade.";
  }
  rev(season);
  backToFantasy(season, msg, ok);
}
