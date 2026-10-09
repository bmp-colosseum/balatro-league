import { redirect } from "next/navigation";

// The "message a player" send form moved into the merged /admin/messages
// page as the "New DM" disclosure -- see web/app/admin/messages/page.tsx.
// newdm=1 opens that disclosure so landing here still lands on the send form.
export default function AdminMessagePageRedirect() {
  redirect("/admin/messages?tab=inbox&newdm=1");
}
