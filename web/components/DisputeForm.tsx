"use client";

// Shared per-match dispute affordance: a "Dispute" disclosure that opens a
// small form proposing what the result should be (the reporter's POV) plus an
// optional note for the helper. Used on /report and on the profile match
// history so both look + read identically. Submits to whatever server action
// is passed; the proposed-result labels come from the shared result-label
// helper so they match every other surface.

import { FormSelect } from "@/components/FormSelect";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { resultLabelBySelf } from "@/lib/result-labels";

export function DisputeForm({
  action,
  pairingId,
  opponentName,
  isDisputed = false,
  hiddenFields,
}: {
  action: (formData: FormData) => void | Promise<void>;
  pairingId: string;
  opponentName: string;
  isDisputed?: boolean;
  // Extra context the server action needs (e.g. profileId to redirect back).
  hiddenFields?: Record<string, string>;
}) {
  return (
    <details>
      <summary style={{ cursor: "pointer", fontSize: 11 }} className="muted">
        {isDisputed ? "Update dispute" : "Dispute"}
      </summary>
      <form
        action={action}
        style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4, minWidth: 220 }}
      >
        <input type="hidden" name="pairingId" value={pairingId} />
        {hiddenFields &&
          Object.entries(hiddenFields).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
        <label style={{ fontSize: 11 }} className="muted">What it should be (your POV):</label>
        <FormSelect
          name="proposed"
          defaultValue="unsure"
          options={[
            { value: "unsure", label: "— not sure, let helper decide —" },
            { value: "2-0", label: resultLabelBySelf("2-0", opponentName) },
            { value: "1-1", label: resultLabelBySelf("1-1", opponentName) },
            { value: "0-2", label: resultLabelBySelf("0-2", opponentName) },
          ]}
        />
        <Textarea
          name="reason"
          rows={2}
          placeholder="Optional context for the helper…"
          maxLength={500}
          style={{ fontSize: 12, width: "100%" }}
        />
        <Button type="submit" variant="secondary" size="sm" style={{ fontSize: 11 }}>
          Submit dispute
        </Button>
      </form>
    </details>
  );
}
