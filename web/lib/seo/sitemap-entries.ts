// Pure URL-building core for app/sitemap.ts. The shell (sitemap.ts) does all the I/O --
// queries Prisma for every season/division row, already has their dates in hand from
// that one query -- then hands this function plain `{ path, lastModified? }` rows to
// turn into absolute sitemap entries. No prisma/Date.now() here: a caller that wants
// "today" passes its own Date in.

export interface SitemapEntryInput {
  /** Site-relative path, with a leading slash, e.g. "/standings" or "/divisions/abc". */
  path: string;
  /** Omitted when there's no cheap, trustworthy "last changed" date for this path. */
  lastModified?: Date;
}

export interface SitemapEntry {
  url: string;
  lastModified?: Date;
}

/** Builds absolute sitemap entries from site-relative paths. Stable order (same
 *  order as the input) so a snapshot/regression test is meaningful. */
export function buildSitemapEntries(siteUrl: string, paths: SitemapEntryInput[]): SitemapEntry[] {
  return paths.map(({ path, lastModified }) =>
    lastModified ? { url: `${siteUrl}${path}`, lastModified } : { url: `${siteUrl}${path}` },
  );
}
