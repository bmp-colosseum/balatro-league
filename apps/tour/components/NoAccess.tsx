import { Callout } from "@/components/Callout";

// Shown by an admin page when the viewer reached the /admin shell (has *some* access) but
// not the permission this specific page needs.
export function NoAccess({ what }: { what?: string }) {
  return (
    <main>
      <h1>Admin</h1>
      <Callout type="admin">You don&apos;t have permission to {what ?? "view this"}.</Callout>
    </main>
  );
}
