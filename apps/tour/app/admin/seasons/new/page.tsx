import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { isAdmin } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormSelect } from "@/components/FormSelect";
import { createSeasonAction } from "../../actions";

export default async function NewSeason() {
  if (!(await isAdmin())) {
    return (
      <main>
        <h1>Admins only</h1>
        <p className="sub">You don&apos;t have access to this page.</p>
      </main>
    );
  }

  return (
    <main>
      <p>
        <Link href="/admin" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> admin</Link>
      </p>
      <h1>New Season</h1>
      <form action={createSeasonAction} className="card flex max-w-[480px] flex-col gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required placeholder="e.g. Team Tour 11" />
        </div>
        <div className="grid gap-1.5">
          <Label>Format</Label>
          <FormSelect
            name="format"
            defaultValue="CONFERENCES"
            triggerClassName="w-full"
            options={[
              { value: "SWISS", label: "Swiss (one pool)" },
              { value: "CONFERENCES", label: "Conferences" },
            ]}
          />
        </div>
        <div className="flex gap-4">
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="teamSize">Team size</Label>
            <Input id="teamSize" name="teamSize" type="number" defaultValue={11} min={1} />
          </div>
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="setsToWin">Sets to win</Label>
            <Input id="setsToWin" name="setsToWin" type="number" placeholder="auto (majority)" min={1} />
          </div>
        </div>
        <div className="flex gap-4">
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="conferenceCount">Conferences</Label>
            <Input id="conferenceCount" name="conferenceCount" type="number" defaultValue={2} min={1} />
          </div>
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="playoffTeams">Playoff teams</Label>
            <Input id="playoffTeams" name="playoffTeams" type="number" defaultValue={8} min={2} />
          </div>
        </div>
        <Button type="submit" className="self-start">Create season</Button>
      </form>
    </main>
  );
}
