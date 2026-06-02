// Centralized formatter for Discord API errors. The bot peppers
// fire-and-forget `.catch(() => {})` everywhere because most failures
// shouldn't fail the user action — but the silent catches mean
// permission problems / kicks / deleted channels go unlogged and
// debugging is guesswork.
//
// logDiscordError() extracts the useful bits: HTTP status, Discord
// error code, and the request URL when present. Keeps logs scannable
// so admins can grep for '50013' (missing permissions) etc.
//
// Use:
//   .catch((err) => logDiscordError("matchSweep.lockThread", err, { threadId }))

export interface DiscordErrorContext {
  threadId?: string;
  channelId?: string;
  guildId?: string;
  userId?: string;
  messageId?: string;
  sessionId?: string;
  pairingId?: string;
}

interface DiscordRESTError {
  status?: number;       // HTTP status (403, 404, etc)
  code?: number;         // Discord error code (50013 = missing perms, 10003 = unknown channel, etc)
  rawError?: { message?: string };
  message?: string;
  url?: string;
}

const COMMON_DISCORD_CODES: Record<number, string> = {
  10003: "Unknown channel (deleted or bot doesn't have access)",
  10004: "Unknown guild (bot not in server)",
  10008: "Unknown message (deleted)",
  10013: "Unknown user",
  50001: "Missing access (bot lacks View Channel)",
  50013: "Missing permissions (check role hierarchy + channel overwrites)",
  50007: "Cannot send to user (DMs closed / not in mutual guild)",
  50025: "Invalid OAuth state",
  160005: "Thread is locked",
  160006: "Thread is archived",
};

export function logDiscordError(
  operation: string,
  err: unknown,
  ctx: DiscordErrorContext = {},
): void {
  const e = err as DiscordRESTError;
  const status = e?.status ?? null;
  const code = e?.code ?? null;
  const ctxParts: string[] = [];
  if (ctx.threadId) ctxParts.push(`thread=${ctx.threadId}`);
  if (ctx.channelId) ctxParts.push(`channel=${ctx.channelId}`);
  if (ctx.guildId) ctxParts.push(`guild=${ctx.guildId}`);
  if (ctx.userId) ctxParts.push(`user=${ctx.userId}`);
  if (ctx.messageId) ctxParts.push(`msg=${ctx.messageId}`);
  if (ctx.sessionId) ctxParts.push(`session=${ctx.sessionId}`);
  if (ctx.pairingId) ctxParts.push(`pairing=${ctx.pairingId}`);
  const ctxStr = ctxParts.length > 0 ? ` (${ctxParts.join(" ")})` : "";

  const codeHint = code && COMMON_DISCORD_CODES[code] ? ` — ${COMMON_DISCORD_CODES[code]}` : "";
  const rawMessage = e?.rawError?.message ?? e?.message ?? "(no message)";

  console.warn(
    `[discord-error] ${operation}${ctxStr}: ` +
      `status=${status ?? "?"} code=${code ?? "?"}${codeHint} — ${rawMessage}`,
  );
}
