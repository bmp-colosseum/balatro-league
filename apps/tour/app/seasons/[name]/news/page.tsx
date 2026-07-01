import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Newspaper } from "lucide-react";
import { prisma } from "@/lib/db";
import { listSeasonNews } from "@/lib/services/news";

export const dynamic = "force-dynamic";

const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export default async function SeasonNews({ params }: { params: Promise<{ name: string }> }) {
  const name = decodeURIComponent((await params).name);
  const season = await prisma.tourSeason.findUnique({ where: { name }, select: { id: true } });
  if (!season) notFound();
  const posts = await listSeasonNews(name);

  return (
    <main>
      <p>
        <Link href={`/seasons/${encodeURIComponent(name)}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {name}</Link>
      </p>
      <h1 className="flex items-center gap-2"><Newspaper className="size-5 text-[var(--accent)]" /> News Network</h1>
      <p className="sub">Previews, recaps, and power rankings for {name}.</p>

      {posts.length === 0 ? (
        <div className="card"><p className="sub">No posts yet this season.</p></div>
      ) : (
        posts.map((p) => (
          <article className="card" key={p.id}>
            <div className="flex flex-wrap items-baseline gap-2">
              {p.week != null && <span className="badge">Week {p.week}</span>}
              <h2 style={{ fontSize: "1.15rem", margin: 0 }}>{p.title}</h2>
            </div>
            <p className="sub" style={{ marginTop: 2 }}>{fmtDate(p.createdAt)}{p.createdBy ? ` · ${p.createdBy}` : ""}</p>
            <div style={{ whiteSpace: "pre-wrap", marginTop: 8, lineHeight: 1.5 }}>{p.body}</div>
          </article>
        ))
      )}
    </main>
  );
}
