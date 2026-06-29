import { signIn } from "@/auth";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Sign in · Team Tour" };

export default function SignIn() {
  return (
    <main>
      <h1>Sign in</h1>
      <p className="sub">Sign in with Discord to see your team, report your sets, and manage the Tour.</p>
      <form
        action={async () => {
          "use server";
          await signIn("discord", { redirectTo: "/" });
        }}
      >
        <Button type="submit">Continue with Discord</Button>
      </form>
    </main>
  );
}
