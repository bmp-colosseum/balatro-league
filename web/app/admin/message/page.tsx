import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Callout } from "@/components/Callout";
import { FormSelect } from "@/components/FormSelect";
import { SubmitButton } from "@/components/SubmitButton";
import { loadMessageablePlayers } from "@/lib/loaders/all-players";
import { sendBotDm } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminMessagePage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  await requireAdmin();
  const { ok, err } = await searchParams;
  const players = await loadMessageablePlayers();

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/message" />
      <main>
        <h2>Message a player</h2>
        <p className="muted">
          Send a one-off DM to a player via the bot. It goes out as a normal Discord DM from the league bot. Every
          send is logged (who sent it, to whom). For mass messages, use the signup / check-in flows instead.
        </p>

        {ok && <Callout type="success">✓ DM queued to <strong>{ok}</strong> — it&apos;ll arrive in a few seconds.</Callout>}
        {err && <Callout type="danger">{err.replace(/-/g, " ")}</Callout>}

        <div className="card">
          <form action={sendBotDm} style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 560 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="muted" style={{ fontSize: 12 }}>To</span>
              <FormSelect
                name="playerId"
                required
                placeholder="— pick a player —"
                options={players.map((p) => ({ value: p.id, label: p.label }))}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="muted" style={{ fontSize: 12 }}>Message</span>
              <textarea
                name="message"
                required
                rows={5}
                maxLength={1900}
                placeholder="What do you want to say to them?"
                style={{
                  width: "100%",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--surface-2)",
                  color: "var(--text)",
                  padding: "8px 10px",
                  fontSize: 14,
                  resize: "vertical",
                }}
              />
            </label>
            <div>
              <SubmitButton pendingText="Sending…">📨 Send DM</SubmitButton>
            </div>
            <span className="muted" style={{ fontSize: 11 }}>
              {players.length} player{players.length === 1 ? "" : "s"} can be DM&apos;d (those with a linked Discord account).
              If their DMs are closed, the message silently can&apos;t be delivered.
            </span>
          </form>
        </div>
      </main>
    </>
  );
}
