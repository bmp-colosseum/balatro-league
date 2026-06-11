// Admin-only "work in progress" banner. Pages that render this are gated to
// admins (non-admins 404), so this is the visual reminder that what you're
// looking at is a draft not yet visible to players.
export function WipBanner({ note }: { note?: string }) {
  return (
    <div
      role="note"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        margin: "0 0 16px",
        padding: "8px 12px",
        borderRadius: 8,
        border: "1px solid #f1c40f",
        background: "rgba(241,196,15,0.12)",
        color: "#f1c40f",
        fontSize: 13,
        fontWeight: 600,
      }}
    >
      <span aria-hidden>🚧</span>
      <span>
        WIP — admin-only preview.{" "}
        <span style={{ fontWeight: 400 }}>{note ?? "Not visible to players yet."}</span>
      </span>
    </div>
  );
}
