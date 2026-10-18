---
date: 2026-10-18
sources:
  - https://nextjs.org/docs/app/api-reference/directives/use-cache
  - https://nextjs.org/docs/app/api-reference/functions/cacheLife
  - https://nextjs.org/docs/app/api-reference/functions/cacheTag
  - https://nextjs.org/docs/app/api-reference/functions/revalidateTag
  - https://nextjs.org/docs/app/api-reference/functions/updateTag
  - https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheComponents
  - https://nextjs.org/docs/app/api-reference/functions/unstable_cache
  - https://doc.traefik.io/traefik/middlewares/http/overview/ (no cache middleware in Traefik Proxy OSS)
  - https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control
  - ~/.claude/planning/api-first/DESIGN.md and REQUIREMENTS.md (apiJson ETag policy)
  - curl -sI https://balatroleague.com/ on 2026-10-18
confidence: high for the Next 16 API surface and current headers (docs plus live curl); medium for Traefik (doc absence of a cache middleware, not an explicit statement); unknown whether a CDN sits in front
---

# 05 - Caching (short)

## Today

- Live `/` and profile responses send `Cache-Control: private, no-cache, no-store` (Next's default for dynamic
  routes) and `Vary: rsc, next-router-state-tree, ...`. Nothing is cached by any layer. 49 files under `web/app` export
  `force-dynamic`.
- Traefik Proxy (open source) has no HTTP cache middleware. It passes `Cache-Control`, `ETag` and `304` through
  unchanged. Caching at the edge would need a CDN in front, which is an open question for MJ.

## API responses (/api/v1)

DESIGN.md already fixes the policy. This research confirms it needs no data-layer support:
- `apiJson` hashes the serialized body to a weak ETag `W/"<sha1 b64url>"`, answers `If-None-Match` with `304`, and sets
  `Vary: Authorization`.
- Finished seasons: long `max-age` plus ETag. Live data: `max-age=30..60, stale-while-revalidate`. Static documents
  (OpenAPI spec): `public, max-age=300, stale-while-revalidate=86400`.
- Responses for an authenticated key should be `private` unless the payload is identical for every caller.
- ETag saves bandwidth, not DB work. DB work is saved by the data cache below.

## Pages: data cache now, Cache Components later

| Option | Status in Next 16.3 | Cost for us |
|---|---|---|
| `unstable_cache(fn, keys, { tags, revalidate })` | Works, already used in 3 loaders; persists in the Next data cache across requests | Low: wrap the standings and profile loaders |
| `'use cache'` + `cacheLife` + `cacheTag` | Stable since 16.0, requires `cacheComponents: true` | High: with cacheComponents on, `dynamic`/`revalidate`/`fetchCache` route exports become build errors, so all 49 `force-dynamic` exports must be removed and each page re-checked for request-time APIs |

- `use cache` default storage is in memory, per server process and per deployment. A deploy empties it, which is fine.
- Invalidation: `revalidateTag(tag, 'max')` works in Server Actions and Route Handlers (stale-while-revalidate semantics).
  `updateTag(tag)` (read-your-own-writes) works only in Server Actions.
- **The bot writes too.** Match reports land through the bot, which is a separate process. A web cache keyed on
  standings needs either an internal authenticated route (`POST /api/internal/revalidate`) the bot calls after a write,
  or a short `revalidate`/`cacheLife` (30-60 s) that tolerates bot-side lag. Once ws04 routes bot writes through the
  shared API, the API handler can call `revalidateTag` itself.

## Recommendation

1. ws04: tag-cache the standings and profile loaders with `unstable_cache` plus `revalidateTag` from the report paths,
   and a 60 s revalidate as the safety net for bot writes until the bot goes through the API.
2. /api/v1: implement DESIGN's ETag/304 policy as written.
3. Defer `cacheComponents` to its own workstream. It is a page-architecture migration across 49 files, not a data-layer
   decision.
