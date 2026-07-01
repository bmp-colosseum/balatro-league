import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Newspaper } from "lucide-react";
import { prisma } from "@/lib/db";
import { listSeasonNews } from "@/lib/services/news";
import { rankingPool } from "@/lib/services/rankings";
import { buildNameLinker, type Segment } from "@/lib/linkify";
import { renderPostMarkdown } from "@/lib/markdown";

export const dynamic = "force-dynamic";

const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

// Render linkified segments inline (text segments keep their newlines under pre-wrap).
function Linked({ parts }: { parts: Segment[] }) {
  return <>{parts.map((s, i) => (s.href ? <Link key={i} href={s.href}>{s.text}</Link> : <span key={i}>{s.text}</span>))}</>;
}

export default async function SeasonNews({ params }: { params: Promise<{ name: string }> }) {
  const name = decodeURIComponent((await params).name);
  const season = await prisma.tourSeason.findUnique({ where: { name }, select: { id: true } });
  if (!season) notFound();
  const [posts, pool] = await Promise.all([listSeasonNews(name), rankingPool(name)]);
  const entities = [
    ...pool.teams.map((t) => ({ name: t.name, href: `/teams/${t.id}` })),
    ...pool.players.map((p) => ({ name: p.name, href: `/players/${p.id}` })),
  ];
  const linker = buildNameLinker(entities);

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
              <h2 style={{ fontSize: "1.15rem", margin: 0 }}><Linked parts={linker(p.title)} /></h2>
            </div>
            <p className="sub" style={{ marginTop: 2 }}>{fmtDate(p.createdAt)}{p.createdBy ? ` · ${p.createdBy}` : ""}</p>
            <div className="post-body" dangerouslySetInnerHTML={{ __html: renderPostMarkdown(p.body, entities) }} />
          </article>
        ))
      )}
    </main>
  );
}
