# Balatro League - self-hosted infra (Netcup)

Full migration off Railway to one Netcup box (EPYC 9645 / 32 GB ECC / 12 cores
/ 1 TB NVMe). Two layers:

- **NixOS** = the thin, declarative base OS (`nixos/`) - firewall, Docker,
  NetBird, sops secrets, the CI runner. Deployed with deploy-rs, atomic rollback.
- **Docker Compose** = every service (`compose/`) - Traefik, Postgres, and the
  4 app containers. Deployed by GitHub Actions on the self-hosted runner.

User login is Discord-native (NextAuth in each app); there is no separate SSO
layer. See "Auth model" below.

```
                internet
                   |  :80/:443 only
              [ Traefik ]  <-- Let's Encrypt TLS
                /     \
        league-web   tour-web        (network: proxy, has egress)
                \     /
          league-bot  tour-bot       (proxy for Discord egress)
                 \   /
       [ Postgres ]  (network: data, internal:true - NO internet, NO public port)
                   ^
                   |  127.0.0.1:5432 only -> reach via SSH tunnel over NetBird

   Admin plane (SSH, Postgres, Traefik dashboard): NetBird mesh only.
```

## DNS (point balatroleague.com at the box)

| Record | Type | Value |
|--------|------|-------|
| `balatroleague.com` | A | box public IP |
| `www.balatroleague.com` | A | box public IP |
| `tour.balatroleague.com` | A | box public IP |

Traefik gets certs via TLS-ALPN-01 on :443, so no extra DNS/API config.

## One-time bring-up

1. **Base install.** Install NixOS on the Netcup VPS (minimal). Create the
   deploy user's SSH key locally and put the public half in
   `nixos/configuration.nix` (`users.users.deploy`).
2. **Hardware config.** On the box: `nixos-generate-config --show-hardware-config
   > hardware-configuration.nix`; commit the real output over the placeholder.
   Fix the bootloader block in `configuration.nix` to match (UEFI vs BIOS).
3. **Secrets (sops).** Generate an age key (`age-keygen`), put your public key +
   the box key in `nixos/.sops.yaml`, then `cp secrets.yaml.example secrets.yaml
   && sops secrets.yaml` and fill the NetBird setup key + runner token. Put the
   age private key on the box at `/var/lib/sops-nix/key.txt`.
4. **First deploy.** Temporarily allow SSH (firewall bootstrap note in
   `configuration.nix`, or the Netcup console), then from your laptop:
   `nix run github:serokell/deploy-rs -- .#balatro` (or `nixos-rebuild` on the
   box). This brings up Docker, NetBird, and the runner.
5. **Join NetBird**, confirm you can SSH over the mesh, then remove port 22 from
   the public firewall and re-deploy. SSH is now mesh-only.
6. **Compose secrets.** `cp compose/.env.example /srv/balatro/secrets.env` on the
   box and fill every value (or sops-encrypt it and decrypt on deploy).
7. **Restore data** (see below) into Postgres before first app boot.
8. **Runner + first app deploy.** Confirm the runner shows up in GitHub
   (Settings -> Actions -> Runners), then merge to `main` (or run the `deploy`
   workflow) - it builds the 4 images, pushes to GHCR, and `compose up`.

## Auth model

There is deliberately NO SSO layer. Each app authenticates users with Discord
(NextAuth v5) and authorizes off live Discord state - guild membership, roles,
and player identity (`lib/permissions.ts`, `lib/admin.ts`, capabilities, captain
team-scoping). Discord is the identity provider and the source of roles, which
is correct for a Discord community.

Operator tools (Traefik dashboard, Postgres) are not user-facing and are gated
by NetBird + loopback binding, not a login page. If you later add ops dashboards
(Grafana, pgAdmin, etc.) and want one SSO + MFA gate for THOSE, add Authentik
then and wire the forwardAuth breadcrumb left in `traefik/dynamic/middlewares.yml`
- it does not belong in front of the apps.

## Migrating the databases off Railway

Dump each Railway DB and restore into the box's `league` / `tour` databases
(do this after step 6, before step 8):

```bash
# from anywhere with the Railway connection strings:
pg_dump "$RAILWAY_LEAGUE_URL" -Fc -f league.dump
pg_dump "$RAILWAY_TOUR_URL"   -Fc -f tour.dump

# copy to the box, then (over the SSH tunnel, see below):
pg_restore -d "postgres://league:PW@127.0.0.1:5432/league" --no-owner league.dump
pg_restore -d "postgres://tour:PW@127.0.0.1:5432/tour"     --no-owner tour.dump
```

The league bot runs `prisma migrate deploy` and tour runs `prisma db push` on
boot - both idempotent, so they reconcile the restored schema cleanly.

## Day-2

- **Deploy** = merge to `main`. CI (`ci.yml`, GitHub-hosted) gates the PR; the
  `deploy` workflow (self-hosted runner) builds + ships. Image tag == git SHA.
- **Rollback** = run the `deploy` workflow via `workflow_dispatch` with a prior
  `ref`, or `compose up` with an older tag in `versions.env`.
- **Reach Postgres / Traefik dashboard** (mesh only): SSH over NetBird with a
  tunnel:
  ```bash
  ssh -L 5432:127.0.0.1:5432 -L 8080:127.0.0.1:8080 deploy@balatro
  # then psql postgres://league:PW@127.0.0.1:5432/league
  # and open http://127.0.0.1:8080 for the Traefik dashboard
  ```

## Verify before first prod deploy (living-software bits)

These change over time - confirm against current docs, they're marked in-file:

- **NixOS channel** in `flake.nix` (`nixos-25.05`) -> set to current stable.
- **Traefik tag** `v3.3` and **Postgres tag** `17` in `deploy.yml` /
  `versions.env` -> pin to current.
- **`services.netbird.clients.wt0`** + **`services.github-runners`** option
  shapes - confirm against your pinned nixpkgs; verify the runner's DynamicUser
  actually gets the `docker` group (`SupplementaryGroups`).

## Security posture

- Public interface: **only 80/443 + WireGuard**. SSH is mesh-only.
- Postgres: `internal:true` network (no internet), host port bound to
  `127.0.0.1` (SSH-tunnel only).
- Apps: `cap_drop: ALL` + `no-new-privileges`.
- PR CI runs on GitHub-hosted runners (never the box). Turn on repo Settings ->
  Actions -> "Require approval for all outside collaborators" so a fork PR can't
  run without your click. Only you merge `main` -> only trusted code deploys.
- Harden later: swap Traefik's raw docker.sock mount for a socket-proxy; give
  tour a read-only role on the league DB; move Postgres to its own no-public-IP
  box on the mesh if it's ever worth it (one-service move, nothing else changes).
