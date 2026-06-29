"use client";

// Apply-all button for the duplicate-recovery dry-run. Submits the currently-shown
// plan (as JSON) to applyRecoveryAction, which re-derives + validates before merging.
// Uses ActionFlashForm so the result flashes like every other admin action.
import { Wrench } from "lucide-react";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { applyRecoveryAction } from "@/app/admin/identity/actions";

export function RecoverApply({ pairs }: { pairs: { keepId: string; dropId: string }[] }) {
  return (
    <ActionFlashForm action={applyRecoveryAction}>
      <input type="hidden" name="pairs" value={JSON.stringify(pairs)} />
      <SubmitButton pendingText="Recovering…" disabled={pairs.length === 0}>
        <Wrench className="size-4" /> Apply {pairs.length} merge{pairs.length === 1 ? "" : "s"}
      </SubmitButton>
    </ActionFlashForm>
  );
}
