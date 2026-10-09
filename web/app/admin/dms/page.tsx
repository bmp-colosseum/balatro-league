import { redirect } from "next/navigation";

// The DM console moved into the merged /admin/messages page (Inbox tab) --
// see web/app/admin/messages/page.tsx. This route is kept only so existing
// links/bookmarks (the admin home "Needs attention" block, the mobile menu's
// unread badge, and anything else pointing at /admin/dms) keep working.
export default function DmsPageRedirect() {
  redirect("/admin/messages?tab=inbox");
}
