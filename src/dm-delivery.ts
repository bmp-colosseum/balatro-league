// Shared outbound-DM delivery recorder. Every place the bot sends a DM
// directly (the notify.dm queue worker, the schedule-change worker, the
// roster check-in blast, the signup ask/reminder sender) records one row
// here so the web DM console can render a complete per-player thread: what
// the bot said, who sent it (a staff reply vs. the bot itself), and which
// inbound message it answers.
//
// Lives in its own module (not src/queue.ts) so roster-checkin.ts and
// src/signup/signup-reminders.ts -- both imported BY queue.ts -- can call it
// without a circular import.

import { prisma } from "./db.js";

export interface DmDeliveryRow {
  discordId: string;
  batchId?: string;
  batchKind?: string;
  status: "sent" | "failed";
  errorCode?: number | null;
  errorMsg?: string | null;
  // What was actually sent, so the admin thread view shows it verbatim.
  content?: string;
  // staff-reply | signup-ask | signup-reminder | schedule-change |
  // season-start | roster-checkin | shootout | ...
  kind?: string;
  senderDiscordId?: string;
  senderName?: string;
  inReplyToInboundDmId?: string;
}

// Best-effort record of one outbound DM attempt. Never throws into the
// caller's worker -- a missing delivery row is preferable to a broken send.
export async function recordDmDelivery(row: DmDeliveryRow): Promise<void> {
  try {
    await prisma.dmDelivery.create({
      data: {
        discordId: row.discordId,
        batchId: row.batchId ?? null,
        // A one-off DM has no batch; label it by its kind so the admin batches table never
        // shows "(unlabelled)" for signup asks, reminders or staff replies.
        batchKind: row.batchKind ?? row.kind ?? null,
        status: row.status,
        errorCode: row.errorCode ?? null,
        errorMsg: row.errorMsg ?? null,
        content: row.content ?? null,
        kind: row.kind ?? row.batchKind ?? null,
        senderDiscordId: row.senderDiscordId ?? null,
        senderName: row.senderName ?? null,
        inReplyToInboundDmId: row.inReplyToInboundDmId ?? null,
      },
    });
  } catch (err) {
    console.warn("[dm-delivery] failed to record delivery:", err);
  }
}
