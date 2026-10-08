"use client";

// "Select all" for a bulk form whose rows are `<input type="checkbox" name="ids">`
// (either inside the form or joined to it with the HTML form="" attribute). A client
// component rather than an inline <script>: React does not execute inline scripts it
// renders on a client-side navigation, so the script version only worked after a hard
// reload -- which is exactly how the TO reached the page and found it dead.

export function SelectAllCheckbox({ formId, label }: { formId: string; label: string }) {
  function toggle(checked: boolean): void {
    const inputs = document.querySelectorAll<HTMLInputElement>(
      `#${formId} input[name="ids"], input[name="ids"][form="${formId}"]`,
    );
    inputs.forEach((cb) => {
      cb.checked = checked;
    });
  }
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
      <input type="checkbox" onChange={(e) => toggle(e.currentTarget.checked)} />
      {label}
    </label>
  );
}
