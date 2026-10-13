import { signIn } from "@/auth";
import { SiteNav } from "@/components/SiteNav";
import { Button } from "@/components/ui/button";
import { safeSignInRedirect } from "@/lib/signin-redirect";

// Noindex (SEO audit L5) -- an auth gateway, not content.
export const metadata = {
  title: "Sign in",
  robots: { index: false },
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await searchParams;
  const redirectTo = safeSignInRedirect(from);

  async function loginAction() {
    "use server";
    await signIn("discord", { redirectTo });
  }

  return (
    <>
      <SiteNav activePath="" />
      <main>
        <h1>Sign in with Discord</h1>
        <div className="card">
          <p>
            Log in with Discord to view your profile, report results, and join signups.
          </p>
          {redirectTo !== "/me" && (
            <p className="muted" style={{ fontSize: 13 }}>
              You&apos;ll come back to <strong>{redirectTo}</strong> after signing in.
            </p>
          )}
          <form action={loginAction}>
            <Button type="submit" style={{ background: "var(--gold)", color: "var(--gold-ink)" }}>
              Sign in with Discord
            </Button>
          </form>
        </div>
      </main>
    </>
  );
}
