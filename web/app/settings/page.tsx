// Player preferences. Currently just the BMP MMR visibility toggle, but
// the page is set up to grow — every preference lives as a row here so
// new ones (notification opt-in, theme, etc.) drop in without UX work.
//
// Cookie-backed so anonymous viewers can set preferences too. No auth
// needed for the page itself.

import Link from "next/link";
import { getShowBmpMmr } from "@/lib/preferences";
import { SiteNav } from "@/components/SiteNav";
import { toggleShowBmpMmr } from "@/app/preferences/actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const showBmpMmr = await getShowBmpMmr();
  return (
    <>
      <SiteNav activePath="/settings" />
      <main>
        <h2>⚙️ Settings</h2>
        <p className="muted">
          Preferences are stored in a cookie on this browser. They don't follow you
          to other devices, and a fresh browser starts with the defaults.
        </p>

        <div className="card">
          <strong>Show BMP MMR everywhere</strong>
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            When on, each player's current Ranked MMR from balatromp.com is
            shown next to them on the standings table, and their full BMP
            history table appears on their profile page. Off by default
            since league standings already tell you who's winning the
            league — BMP MMR is a separate, external rating.
          </p>
          <form action={toggleShowBmpMmr} style={{ marginTop: 8 }}>
            <input type="hidden" name="next" value={showBmpMmr ? "0" : "1"} />
            <input type="hidden" name="returnTo" value="/settings" />
            <button type="submit" className={showBmpMmr ? undefined : "secondary"}>
              {showBmpMmr ? "✓ Showing BMP MMR — click to hide" : "Show BMP MMR"}
            </button>
          </form>
        </div>

        <p className="muted" style={{ marginTop: 16, fontSize: 12 }}>
          <Link href="/" className="muted">← Back to standings</Link>
        </p>
      </main>
    </>
  );
}
