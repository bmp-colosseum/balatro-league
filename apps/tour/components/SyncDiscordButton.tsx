"use client";

// Pull the Tour Discord guild member list into the id reference (username → numeric
// id) so signup @usernames resolve. Flash-shows the result like other admin actions.
import { RefreshCw } from "lucide-react";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { syncDiscordMembersAction } from "@/app/admin/identity/actions";

export function SyncDiscordButton({ configured }: { configured: boolean }) {
  return (
    <ActionFlashForm action={syncDiscordMembersAction}>
      <SubmitButton pendingText="Syncing Discord…" disabled={!configured}>
        <RefreshCw className="size-4" /> Sync Discord members
      </SubmitButton>
      {!configured && <span className="sub ml-2">Needs TOUR_DISCORD_TOKEN + TOUR_GUILD_ID (Server Members Intent).</span>}
    </ActionFlashForm>
  );
}
