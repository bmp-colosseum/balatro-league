"use client";

import { useRef, useState } from "react";
import type { TraitAdminRow } from "@/lib/loaders/traits-admin";

// Draw the chosen image onto a canvas scaled to fit `max`×`max` (never
// upscaling) and return a PNG data: URL. Keeps the stored blob tiny so it
// lives comfortably in a DB TEXT column and renders inline on profiles.
function resizeToDataUrl(file: File, max = 48): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(max / img.width, max / img.height, 1);
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("no 2d context"));
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("could not load image"));
    };
    img.src = url;
  });
}

export function TraitEditorRow({
  row,
  saveAction,
  resetAction,
}: {
  row: TraitAdminRow;
  saveAction: (formData: FormData) => Promise<void>;
  resetAction: (formData: FormData) => Promise<void>;
}) {
  const [preview, setPreview] = useState<string | null>(row.iconDataUrl);
  // "" = leave existing icon, "__clear__" = remove, or a fresh data: URL.
  const [iconField, setIconField] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const dataUrl = await resizeToDataUrl(file, 48);
      setPreview(dataUrl);
      setIconField(dataUrl);
    } catch {
      // ignore — bad image, leave current preview
    } finally {
      setBusy(false);
    }
  }

  function clearIcon() {
    setPreview(null);
    setIconField("__clear__");
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div className="card" style={{ display: "grid", gap: 10 }}>
      <form action={saveAction} style={{ display: "grid", gap: 10 }}>
        <input type="hidden" name="key" value={row.key} />
        <input type="hidden" name="iconDataUrl" value={iconField} />

        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          {/* Icon: custom image if set, else the emoji, with upload/clear. */}
          <div style={{ display: "grid", gap: 4, justifyItems: "center", width: 88 }}>
            <div
              style={{
                width: 48,
                height: 48,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 28,
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "rgba(155,89,182,0.10)",
                overflow: "hidden",
              }}
            >
              {preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={preview}
                  alt=""
                  width={44}
                  height={44}
                  style={{ objectFit: "contain" }}
                />
              ) : (
                <span>{row.emoji}</span>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={onFile}
              disabled={busy}
              style={{ display: "none" }}
              id={`icon-${row.key}`}
            />
            <label
              htmlFor={`icon-${row.key}`}
              className="muted"
              style={{ fontSize: 11, cursor: "pointer", textDecoration: "underline" }}
            >
              {busy ? "resizing…" : "upload icon"}
            </label>
            {preview && (
              <button
                type="button"
                onClick={clearIcon}
                className="muted"
                style={{ background: "none", border: "none", color: "#e74c3c", cursor: "pointer", fontSize: 11 }}
              >
                remove icon
              </button>
            )}
          </div>

          {/* Text fields. */}
          <div style={{ display: "grid", gap: 8, flex: 1 }}>
            <label style={{ display: "grid", gap: 2, fontSize: 12 }}>
              <span className="muted">Label</span>
              <input type="text" name="label" defaultValue={row.label} />
              <span className="muted" style={{ fontSize: 10 }}>default: {row.defaultLabel}</span>
            </label>
            <label style={{ display: "grid", gap: 2, fontSize: 12, maxWidth: 120 }}>
              <span className="muted">Emoji (fallback)</span>
              <input type="text" name="emoji" defaultValue={row.emoji} maxLength={8} />
            </label>
            <label style={{ display: "grid", gap: 2, fontSize: 12 }}>
              <span className="muted">Description</span>
              <textarea name="description" defaultValue={row.description} rows={2} style={{ resize: "vertical" }} />
              <span className="muted" style={{ fontSize: 10 }}>default: {row.defaultDescription}</span>
            </label>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button type="submit" disabled={busy}>Save</button>
          {row.overridden && <span className="muted" style={{ fontSize: 11 }}>customised</span>}
        </div>
      </form>

      {row.overridden && (
        <form action={resetAction}>
          <input type="hidden" name="key" value={row.key} />
          <button
            type="submit"
            className="muted"
            style={{ background: "none", border: "1px solid var(--border)", color: "#e74c3c", cursor: "pointer", fontSize: 12, padding: "2px 8px", borderRadius: 4 }}
          >
            Reset to default
          </button>
        </form>
      )}
    </div>
  );
}
