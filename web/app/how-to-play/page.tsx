// /how-to-play -- superseded by the public /how-it-works page (same
// content as the onboarding DM, see web/app/how-it-works/page.tsx). Kept as
// a redirect so old links/bookmarks still land somewhere.

import { redirect } from "next/navigation";

export default function HowToPlayPage(): never {
  redirect("/how-it-works");
}
