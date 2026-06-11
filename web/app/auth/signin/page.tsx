import { signIn } from "@/auth";
import { SiteNav } from "@/components/SiteNav";
import { Button } from "@/components/ui/button";

export default function SignInPage() {
  async function loginAction() {
    "use server";
    await signIn("discord", { redirectTo: "/me" });
  }

  return (
    <>
      <SiteNav activePath="" />
      <main>
        <h2>Sign in</h2>
        <div className="card">
          <p>
            Log in with your Discord account to view your profile, report match results, and join
            signup rounds.
          </p>
          <form action={loginAction}>
            <Button type="submit">Login with Discord</Button>
          </form>
        </div>
      </main>
    </>
  );
}
