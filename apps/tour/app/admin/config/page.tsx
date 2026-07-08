import Link from "next/link";
import { ArrowLeft, Settings2 } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { allConfig, KNOWN_KEYS } from "@/lib/services/config";
import { NoAccess } from "@/components/NoAccess";
import { ActionFlashForm } from "@/components/ActionFlashForm";
import { SubmitButton } from "@/components/SubmitButton";
import { fieldInput as inputCls } from "@/components/admin/Field";
import { setConfigAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function ConfigAdmin() {
  if (!(await isAdmin())) return <NoAccess what="edit configuration" />;
  const cfg = await allConfig();
  const extraKeys = Object.keys(cfg).filter((k) => !KNOWN_KEYS.some((kk) => kk.key === k));

  return (
    <main>
      <p><Link href="/admin" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> admin</Link></p>
      <h1 className="flex items-center gap-2"><Settings2 className="size-5" /> Configuration</h1>
      <p className="sub">Bot channel ids + site knobs. Paste a Discord channel id (right-click a channel → Copy Channel ID). Empty value deletes the key.</p>

      <div className="card">
        {KNOWN_KEYS.map((k) => (
          <ActionFlashForm key={k.key} action={setConfigAction} className="mb-3">
            <input type="hidden" name="key" value={k.key} />
            <div className="flex flex-wrap items-end gap-2">
              <label className="block" style={{ minWidth: 340 }}>
                <span className="sub"><code>{k.key}</code> — {k.hint}</span>
                <input name="value" defaultValue={cfg[k.key] ?? ""} placeholder="e.g. 123456789012345678" className={`${inputCls} w-full`} />
              </label>
              <SubmitButton size="sm" variant="secondary" pendingText="…">Save</SubmitButton>
            </div>
          </ActionFlashForm>
        ))}
      </div>

      {extraKeys.length > 0 && (
        <div className="card">
          <div className="bracket-title">Other keys</div>
          {extraKeys.map((k) => (
            <div key={k} className="sub py-0.5"><code>{k}</code> = <code>{cfg[k]}</code></div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="bracket-title">Set any key</div>
        <ActionFlashForm action={setConfigAction}>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block"><span className="sub">Key</span><input name="key" className={`${inputCls} w-56`} /></label>
            <label className="block flex-1" style={{ minWidth: 200 }}><span className="sub">Value</span><input name="value" className={`${inputCls} w-full`} /></label>
            <SubmitButton size="sm" variant="secondary" pendingText="…">Save</SubmitButton>
          </div>
        </ActionFlashForm>
      </div>
    </main>
  );
}
