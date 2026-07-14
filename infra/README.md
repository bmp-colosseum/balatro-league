# Balatro League - self-hosted infra (Netcup)

The Balatro League + Pizza Power Team Tour, migrated off Railway to one Netcup
box (EPYC 9645 / 32 GB ECC / 12 cores / 1 TB NVMe). Two layers:

- **NixOS** = the thin, declarative base OS (`nixos/`) - firewall, Docker daemon,
  key-only SSH, users. Installed with `nixos-anywhere`; the disk layout is
  declarative via disko.
- **Docker Compose** = every service (`compose/`) - Traefik, Postgres, the league
  bot + web, the tour web, an isolated tour DEV stack, and the CI runner. This is
  where all the moving parts live.

User login is Discord-native (NextAuth in each app); there is no SSO layer.

## Architecture

```
internet -- :80/:443 --> [ Traefik ]   (Let's Encrypt via TLS-ALPN-01)
                            | routes by Host (FILE provider, no docker socket)
   www / balatroleague.com     -> league-web
   tour.balatroleague.com       -> tour-web
   tour-dev.balatroleague.com   -> tour-web-dev   (separate dev stack)

app containers on network `proxy` (has egress for the Discord API):
   league-bot, league-web, tour-web      (+ dev: tour-web-dev)

[ Postgres 18 ] on network `data` (internal: true - NO internet, NO host port)
   apps reach it by DNS `postgres:5432`; admin via `docker exec`.
   the dev stack has its OWN postgres-dev on `data-dev`.

Admin plane: SSH (port 22, key-only). No mesh VPN - a small solo admin surface
didn't warrant NetBird/WireGuard. Add plain WireGuard later to take SSH off the
public internet if you want.
```

## Access
- **SSH:** key-only on port 22 (`deploy@<box>`), passwords off + fail2ban.
- **Postgres** (no host port - it's on the internal network):
  `docker exec -it balatro-postgres-1 psql -U postgres -d league`
- **Traefik dashboard:** published on `127.0.0.1:8080` -
  `ssh -L 8080:127.0.0.1:8080 deploy@<box>` then open `http://127.0.0.1:8080`.

## DNS (Cloudflare, grey / DNS-only)
Every record is an `A` -> the box IP, **un-proxied (grey cloud)** - orange/proxied
breaks TLS-ALPN cert issuance.

| Record | Value |
|--------|-------|
| `balatroleague.com`, `www.balatroleague.com` | box IP (grey) |
| `tour.balatroleague.com` | box IP (grey) |
| `tour-dev.balatroleague.com` | box IP (grey) |

## CI/CD
- **Runner:** a self-hosted GitHub Actions runner (Docker container,
  `myoung34/github-runner`, label `balatro`) with the docker socket + `/srv/balatro`
  mounted so it can build + deploy. Registered with a `gh api` registration token.
- **Deploy** (`.github/workflows/deploy.yml`): build the 4 images on the runner ->
  push to GHCR -> refresh `/srv/balatro/repo/infra` -> roll the app containers via
  `docker compose` from that STABLE path (so bind-mounts persist). Image tag == SHA.
  - auto on push to `master` (paths: app code / Dockerfiles / `infra/compose`)
  - manual full deploy: `gh workflow run deploy.yml -f deploy=true`
  - safe build-only test: `gh workflow run deploy.yml -f deploy=false`
- **PR CI** (`ci.yml`, pre-existing): runs on GitHub-HOSTED runners (never the box).
- **Secrets** stay box-local at `/srv/balatro/secrets.env` (+ `secrets.dev.env`),
  never in git. `compose/.env.example` is the template.

## Data migration (Railway -> box)
Two-step, because Postgres is on an internal network (no host port to dump into):
```bash
# dump from Railway via a host-network container (has internet):
docker run --rm --network host -e SRC="$RAILWAY_URL" -v /srv/balatro/dumps:/dumps \
  postgres:18 bash -c 'pg_dump "$SRC" -Fc -f /dumps/db.dump'
# restore via a data-network container (reaches postgres by DNS):
docker run --rm --network data -v /srv/balatro/dumps:/dumps postgres:18 \
  bash -c 'pg_restore -d "postgres://ROLE:PW@postgres:5432/DB" --no-owner --no-acl /dumps/db.dump'
```
The league bot runs `prisma migrate deploy` and tour runs `prisma db push` on boot
- both idempotent against a restored schema.

## Gotchas (learned the hard way; don't re-learn them)
- **Postgres 18 image** mounts the volume at `/var/lib/postgresql`, NOT
  `/var/lib/postgresql/data` (the old path crash-loops on 18).
- **Internal networks can't publish host ports** - no loopback `5432`; use
  `docker exec` or the two-step dump/restore above.
- **Traefik routes via the FILE provider** (`traefik/dynamic/routers.yml`), NOT
  docker labels - Docker 29's daemon rejects Traefik's default old API version.
  (Also lets Traefik run with no docker.sock mount.)
- **ACME + Cloudflare:** records must be grey/DNS-only, and point DNS FIRST + let
  it propagate before adding the Traefik router, or the failed-auth rate limit
  (5/hr/identifier) locks the domain. A `404 Certificate not found` on cert fetch
  is fixed by `docker restart balatro-traefik-1` (fresh order, keeps existing certs).

## Auth model
No SSO. Each app authenticates users with Discord (NextAuth v5) and authorizes off
live Discord state - guild membership, roles, player identity. Discord is the
identity provider. If you later add ops dashboards (Grafana/pgAdmin) and want one
SSO gate for THOSE, wire the forwardAuth breadcrumb in
`traefik/dynamic/middlewares.yml` to an Authentik instance - it does not belong in
front of the apps.

## Security posture
- Public interface: **only 80/443 + SSH (22, key-only)**. fail2ban on.
- Postgres: internal network (no internet, no host port).
- Apps: `cap_drop: ALL` + `no-new-privileges`.
- Traefik: file-provider routing, no docker socket.
- CI: PR builds on GitHub-hosted runners; only `master` (which only you merge)
  deploys via the box runner. Turn on repo Settings -> Actions -> "require approval
  for outside collaborators" for the fork-PR gate.
- Harden later: give tour a read-only role on the league DB; add plain WireGuard to
  take SSH off the public internet; split Postgres onto its own box if it's ever
  worth it.

## NixOS notes (`nixos/`)
Installed via `nixos-anywhere` from a nix host. `configuration.nix` is the active
base (networking is STATIC - Netcup serves no DHCP; `eth0` is pinned).
`services.nix` (sops + a NixOS `services.github-runners` + auto-upgrade) is an
OPTIONAL layer, currently NOT enabled - the runner runs as a Docker container
instead. If you enable it, confirm option shapes against the pinned nixpkgs
(`nixos-26.05`).
```
