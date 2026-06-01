// Small toggle that flips the BMP-MMR visibility cookie. Renders as a
// link-styled form button so it fits in SiteNav without looking like a
// chunky action. Form posts to the toggle action which sets/clears the
// cookie + revalidates the path so the change takes effect immediately.

import { toggleShowBmpMmr } from "@/app/preferences/actions";
import { getShowBmpMmr } from "@/lib/preferences";

export async function BmpMmrToggle({ returnTo }: { returnTo: string }) {
  const showing = await getShowBmpMmr();
  return (
    <form action={toggleShowBmpMmr} style={{ display: "inline" }}>
      <input type="hidden" name="next" value={showing ? "0" : "1"} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <button
        type="submit"
        className="muted"
        style={{
          background: "none",
          border: "none",
          padding: 0,
          fontSize: 12,
          cursor: "pointer",
          color: "var(--muted)",
        }}
        title={showing ? "Hide BMP MMR columns on standings/profiles" : "Show each player's balatromp.com Ranked MMR"}
      >
        {showing ? "hide BMP MMR" : "show BMP MMR"}
      </button>
    </form>
  );
}
