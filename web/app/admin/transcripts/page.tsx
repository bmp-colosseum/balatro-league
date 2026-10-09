import { redirect } from "next/navigation";

// The transcripts list moved into the merged /admin/messages page's
// Transcripts tab -- see web/app/admin/messages/page.tsx. The detail page
// (/admin/transcripts/[threadId]) and the attachment route stay where they are.
export default function TranscriptsPageRedirect() {
  redirect("/admin/messages?tab=transcripts");
}
