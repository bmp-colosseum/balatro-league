"use client";

// Admin import-by-upload: pick a .zip of the Google-Sheets exports → a server
// action imports from it (works in prod; no local folder dependency). Uses
// ActionFlashForm so the result/pending shows the same way as other admin forms.
import { useState } from "react";
import { Upload } from "lucide-react";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { uploadImportAction } from "@/app/admin/actions";

export function ImportUpload() {
  const [fileName, setFileName] = useState<string | null>(null);
  return (
    <ActionFlashForm action={uploadImportAction}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="file"
          name="file"
          accept=".zip"
          onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
          className="text-sm file:mr-2 file:rounded file:border file:border-[var(--border)] file:bg-[var(--surface-2)] file:px-2 file:py-1 file:text-[var(--foreground)]"
        />
        <SubmitButton pendingText="Importing…" disabled={!fileName}><Upload className="size-4" /> Upload &amp; import</SubmitButton>
      </div>
    </ActionFlashForm>
  );
}
