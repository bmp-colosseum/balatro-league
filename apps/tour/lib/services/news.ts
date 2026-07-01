// Team Tour News Network — editorial posts (previews / recaps / power rankings) per season,
// optionally tied to a week. Body is free text; the render preserves line breaks. Centralized
// service; the admin actions + public page are thin callers.
import { prisma } from "../db";

export interface NewsPostView {
  id: string;
  week: number | null;
  title: string;
  body: string;
  createdBy: string | null;
  createdAt: Date;
}

async function seasonIdOf(seasonName: string): Promise<string | null> {
  const s = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  return s?.id ?? null;
}

export async function listSeasonNews(seasonName: string): Promise<NewsPostView[]> {
  const sid = await seasonIdOf(seasonName);
  if (!sid) return [];
  const posts = await prisma.newsPost.findMany({ where: { seasonId: sid }, orderBy: { createdAt: "desc" } });
  return posts.map((p) => ({ id: p.id, week: p.week, title: p.title, body: p.body, createdBy: p.createdBy, createdAt: p.createdAt }));
}

export async function getNewsPost(id: string) {
  return prisma.newsPost.findUnique({ where: { id } });
}

export async function createNews(seasonName: string, data: { week: number | null; title: string; body: string; by?: string }) {
  const sid = await seasonIdOf(seasonName);
  if (!sid) throw new Error("No such season.");
  if (!data.title.trim()) throw new Error("A title is required.");
  if (!data.body.trim()) throw new Error("The post is empty.");
  return prisma.newsPost.create({ data: { seasonId: sid, week: data.week, title: data.title.trim(), body: data.body, createdBy: data.by ?? null } });
}

export async function updateNews(id: string, data: { week: number | null; title: string; body: string }) {
  if (!data.title.trim()) throw new Error("A title is required.");
  if (!data.body.trim()) throw new Error("The post is empty.");
  return prisma.newsPost.update({ where: { id }, data: { week: data.week, title: data.title.trim(), body: data.body } });
}

export async function deleteNews(id: string) {
  await prisma.newsPost.delete({ where: { id } });
}
