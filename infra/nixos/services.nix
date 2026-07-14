# STAGE 2 - secret-dependent services. NOT part of the first install.
#
# Enable AFTER the sops age key (/var/lib/sops-nix/key.txt) and the encrypted
# secrets.yaml (netbird-setup-key + github-runner-token) are on the box:
#   1. add `./services.nix` and `sops-nix.nixosModules.sops` to flake.nix modules
#   2. nixos-rebuild switch --flake .#balatro  (from the box or a nix host)
{ config, pkgs, lib, ... }:

{
  # ---- secrets (sops-nix) ---------------------------------------------------
  sops.defaultSopsFile = ./secrets.yaml;
  sops.age.keyFile = "/var/lib/sops-nix/key.txt";
  sops.secrets."netbird-setup-key" = { };
  sops.secrets."github-runner-token" = { };

  # ---- NetBird agent (private mesh: SSH + Postgres + dashboards) ------------
  services.netbird.clients.wt0 = {
    login.enable = true;
    login.setupKeyFile = config.sops.secrets."netbird-setup-key".path;
    port = 51821;
    ui.enable = false;
    openFirewall = true;
    openInternalFirewall = true;
  };

  # ---- GitHub Actions self-hosted runner ------------------------------------
  # DynamicUser + SupplementaryGroups grants the docker group so it can build.
  services.github-runners.balatro = {
    enable = true;
    name = "balatro-netcup";
    url = "https://github.com/ChronoFinale/balatro-league";
    tokenFile = config.sops.secrets."github-runner-token".path;
    extraLabels = [ "balatro" ];
    replace = true;
    extraPackages = [ pkgs.docker pkgs.docker-compose pkgs.git pkgs.nodejs_24 ];
    serviceOverrides.SupplementaryGroups = [ "docker" ];
  };

  # ---- auto security updates ------------------------------------------------
  system.autoUpgrade = {
    enable = true;
    flake = "github:ChronoFinale/balatro-league?dir=infra/nixos";
    allowReboot = false;
  };
}
