{
  description = "Balatro League host - thin NixOS base for the Netcup box";

  inputs = {
    # Current NixOS stable (matches the bmp-mod nix host: 26.05 Yarara).
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    disko.url = "github:nix-community/disko";
    disko.inputs.nixpkgs.follows = "nixpkgs";
    sops-nix.url = "github:Mic92/sops-nix";
    sops-nix.inputs.nixpkgs.follows = "nixpkgs";
    deploy-rs.url = "github:serokell/deploy-rs";
    deploy-rs.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, disko, sops-nix, deploy-rs, ... }:
    let system = "x86_64-linux";
    in {
      nixosConfigurations.balatro = nixpkgs.lib.nixosSystem {
        inherit system;
        modules = [
          ./configuration.nix
          ./disk-config.nix
          disko.nixosModules.disko
          # ---- STAGE 2 (uncomment once secrets are on the box) ----
          # ./services.nix
          # sops-nix.nixosModules.sops
        ];
      };

      # Declarative remote deploy: `nix run github:serokell/deploy-rs`
      # reaches the box over NetBird (SSH host alias `balatro`).
      deploy.nodes.balatro = {
        hostname = "balatro";
        profiles.system = {
          sshUser = "deploy";
          user = "root";
          path = deploy-rs.lib.${system}.activate.nixos
            self.nixosConfigurations.balatro;
        };
      };

      checks = builtins.mapAttrs
        (_: lib: lib.deployChecks self.deploy) deploy-rs.lib;
    };
}
