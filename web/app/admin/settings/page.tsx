// League rules template manager. Each template carries two timeout
// settings. Scoring (3/1/0) and ban/pick policy (4/3/9/2) are hardcoded
// constants and not editable from this page. Locked to OWNER + DEVOPS.

import { requireOwnerOrDevops } from "@/lib/admin";
import { DEFAULTS } from "@/lib/league-settings";
import { loadRulesTemplates } from "@/lib/loaders/admin-settings";
import { AdminNav } from "@/components/AdminNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SiteNav } from "@/components/SiteNav";
import {
  deleteRulesTemplate,
  saveRulesTemplate,
  setDefaultRulesTemplate,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  await requireOwnerOrDevops();
  const { ok, err } = await searchParams;
  const templates = await loadRulesTemplates();

  return (
    <>
      <SiteNav activePath="" />
      <AdminNav activePath="/admin/settings" />
      <main>
        <h2>Rules templates</h2>
        <p className="muted" style={{ fontSize: 12 }}>
          Templates carry timeout values. The ★ default is used by any season that hasn't
          picked another; seasons opt into an alternate from their detail page. Scoring
          (3/1/0) and ban/pick (4/3/9 pool with 2 left) are league-wide constants and
          aren't editable here.
        </p>

        {ok && (
          <div className="card" style={{ borderColor: "#2ecc71", color: "#2ecc71" }}>
            ✓ Saved.
          </div>
        )}
        {err && (
          <div className="card" style={{ borderColor: "#e74c3c", color: "#e74c3c" }}>
            {err}
          </div>
        )}

        {templates.length === 0 && (
          <div className="card muted">
            No templates yet. Create one below and mark it default.
          </div>
        )}

        {templates.map((t) => (
          <details key={t.id} className="card" open={t.isDefault}>
            <summary style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}>
              {t.isDefault && (
                <span className="pill" style={{ background: "rgba(241,196,15,0.2)", color: "#f1c40f" }}>
                  ★ default
                </span>
              )}
              <strong style={{ fontSize: 16 }}>{t.name}</strong>
              <span className="muted" style={{ fontSize: 11 }}>
                Invite expires after {t.matchInviteExpiryMinutes} min · {t.reportAutoConfirmSeconds}s auto-confirm
                {" · "}{t._count.seasons} season{t._count.seasons === 1 ? "" : "s"}
              </span>
            </summary>

            <form action={saveRulesTemplate} style={{ marginTop: 12 }}>
              <input type="hidden" name="id" value={t.id} />
              <label style={{ display: "block", marginBottom: 12 }}>
                Name
                <Input name="name" defaultValue={t.name} required style={{ width: "100%", maxWidth: 320 }} />
              </label>

              <Section title="Timeouts">
                <Field
                  name="matchInviteExpiryMinutes"
                  label="Match invite expires after (minutes)"
                  hint="A challenge auto-cancels if the opponent hasn't accepted within this window."
                  value={t.matchInviteExpiryMinutes}
                  fallback={DEFAULTS.matchInviteExpiryMinutes}
                />
                <Field
                  name="reportAutoConfirmSeconds"
                  label="Result auto-confirms after (seconds)"
                  hint="If the loser doesn't dispute within this window, the reported result locks in."
                  value={t.reportAutoConfirmSeconds}
                  fallback={DEFAULTS.reportAutoConfirmSeconds}
                />
              </Section>

              <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
                <Button type="submit">Save changes</Button>
              </div>
            </form>

            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              {!t.isDefault && (
                <form action={setDefaultRulesTemplate}>
                  <input type="hidden" name="id" value={t.id} />
                  <Button type="submit" variant="secondary">★ Make default</Button>
                </form>
              )}
              {!t.isDefault && (
                <form action={deleteRulesTemplate}>
                  <input type="hidden" name="id" value={t.id} />
                  <Button type="submit" variant="destructive">Delete</Button>
                </form>
              )}
              {t.isDefault && (
                <span className="muted" style={{ fontSize: 11, alignSelf: "center" }}>
                  Default can't be deleted — make another default first.
                </span>
              )}
            </div>
          </details>
        ))}

        <details className="card">
          <summary style={{ cursor: "pointer" }}><strong>+ New template</strong></summary>
          <form action={saveRulesTemplate} style={{ marginTop: 12 }}>
            <label style={{ display: "block", marginBottom: 12 }}>
              Name
              <Input name="name" placeholder="e.g. Casual" required style={{ width: "100%", maxWidth: 320 }} />
            </label>
            <Section title="Timeouts">
              <Field
                name="matchInviteExpiryMinutes"
                label="Match invite expires after (minutes)"
                value={DEFAULTS.matchInviteExpiryMinutes}
                fallback={DEFAULTS.matchInviteExpiryMinutes}
              />
              <Field
                name="reportAutoConfirmSeconds"
                label="Result auto-confirms after (seconds)"
                value={DEFAULTS.reportAutoConfirmSeconds}
                fallback={DEFAULTS.reportAutoConfirmSeconds}
              />
            </Section>
            <Button type="submit" className="mt-4">Create template</Button>
          </form>
        </details>
      </main>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 12, padding: 12, border: "1px solid var(--border)", borderRadius: 6 }}>
      <strong style={{ fontSize: 14 }}>{title}</strong>
      <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 120px", gap: 8, alignItems: "center" }}>
        {children}
      </div>
    </div>
  );
}

function Field({
  name,
  label,
  hint,
  value,
  fallback,
}: {
  name: string;
  label: string;
  hint?: string;
  value: number;
  fallback: number;
}) {
  return (
    <>
      <label htmlFor={name}>
        {label}
        {value !== fallback && (
          <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
            (default {fallback})
          </span>
        )}
        {hint && <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>{hint}</div>}
      </label>
      <Input
        id={name}
        name={name}
        type="number"
        defaultValue={value}
        min={1}
        required
        style={{ width: "100%" }}
      />
    </>
  );
}
