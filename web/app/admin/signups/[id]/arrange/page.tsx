import { redirect } from "next/navigation";

// The arrange editor now lives ON the preview page itself (one URL, no bounce).
// Keep this route as a permanent redirect so any old/shared links still land in
// the right place.
export const dynamic = "force-dynamic";

export default async function ArrangeRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/admin/signups/${id}/preview?basis=current`);
}
