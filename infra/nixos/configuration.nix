# Thin declarative base for the Netcup box (hostname: balatro).
# Owns the OS: networking, SSH, Docker, firewall, users. Secret-dependent
# services (NetBird, the GitHub runner) live in services.nix and are switched on
# in a SECOND deploy once the sops age key + secrets.yaml are on the box - see
# infra/README.md. Disk layout is declarative via disko (./disk-config.nix).
{ config, pkgs, lib, ... }:

{
  # ---- boot / hardware (Netcup KVM: virtio disk, legacy BIOS) ---------------
  boot.loader.grub = {
    enable = true;
    efiSupport = false;
    # disko sets boot.loader.grub.devices from the disk's EF02 partition, so do
    # NOT also set `device` here - that duplicates it (mirroredBoots error).
  };
  boot.initrd.availableKernelModules = [
    "ahci" "xhci_pci" "virtio_pci" "virtio_scsi" "virtio_blk" "sd_mod" "sr_mod"
  ];
  nixpkgs.hostPlatform = "x86_64-linux";

  networking.hostName = "balatro";
  time.timeZone = "America/New_York";
  system.stateVersion = "26.05";

  # ---- static networking (Netcup serves NO DHCP; must match the box) --------
  networking.useDHCP = false;
  networking.usePredictableInterfaceNames = false; # keep the NIC named eth0
  networking.interfaces.eth0 = {
    ipv4.addresses = [ { address = "159.195.16.100"; prefixLength = 22; } ];
    ipv6.addresses = [ { address = "2a0a:4cc0:101:16ac:9898:33ff:fe40:f715"; prefixLength = 64; } ];
  };
  networking.defaultGateway = { address = "159.195.16.1"; interface = "eth0"; };
  networking.defaultGateway6 = { address = "fe80::1"; interface = "eth0"; };
  networking.nameservers = [ "46.38.252.230" "46.38.225.230" "2a03:4000:0:1::e1e6" ];

  # ---- firewall -------------------------------------------------------------
  networking.nftables.enable = true;
  networking.firewall = {
    enable = true;
    # SSH (22) is public + key-only (see openssh below). 80/443 = Traefik.
    # No mesh VPN; add plain WireGuard + its UDP port here to take SSH off the
    # public internet later.
    allowedTCPPorts = [ 22 80 443 ];
  };

  # ---- ssh: key-only ---------------------------------------------------------
  # Root stays key-only during bootstrap (the installer + first verifies connect
  # as root); tighten to "no" after cutover once the deploy user is confirmed.
  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "prohibit-password";
    };
  };

  users.users.root.openssh.authorizedKeys.keys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAkUXZlNWVxSKhGpQDkUfu+QgS7IoikHXwJTrUhbBkNv claude-code-balatro-deploy@MJ-PC"
  ];

  users.users.deploy = {
    isNormalUser = true;
    extraGroups = [ "wheel" "docker" ];
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAkUXZlNWVxSKhGpQDkUfu+QgS7IoikHXwJTrUhbBkNv claude-code-balatro-deploy@MJ-PC"
    ];
  };
  security.sudo.wheelNeedsPassword = false; # deploy-rs / passwordless activate

  # ---- Docker ---------------------------------------------------------------
  virtualisation.docker = {
    enable = true;
    autoPrune = { enable = true; dates = "weekly"; };
  };

  # ---- base hardening -------------------------------------------------------
  services.fail2ban.enable = true;

  environment.systemPackages = with pkgs; [ git vim docker-compose sops age ];
}
