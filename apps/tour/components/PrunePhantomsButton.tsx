"use client";

// Remove phantom "players" that are actually team names (from older imports that turned
// team-vs-team Game Log rows into players). Flash-shows the result like other actions.
import { Eraser } from "lucide-react";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { prunePhantomsAction } from "@/app/admin/identity/actions";

export function PrunePhantomsButton() {
  return (
    <ActionFlashForm action={prunePhantomsAction}>
      <SubmitButton pendingText="Cleaning…" variant="secondary">
        <Eraser className="size-4" /> Remove phantom team-players
      </SubmitButton>
    </ActionFlashForm>
  );
}
