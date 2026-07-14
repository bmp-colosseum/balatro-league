# Declarative disk layout (disko) for the Netcup box: one 1 TB virtio disk,
# GPT, legacy-BIOS boot via GRUB. nixos-anywhere runs this to partition the
# target - it WIPES /dev/vda.
{
  disko.devices.disk.main = {
    device = "/dev/vda";
    type = "disk";
    content = {
      type = "gpt";
      partitions = {
        boot = {
          size = "1M";
          type = "EF02"; # BIOS boot partition (holds GRUB core.img on GPT)
        };
        root = {
          size = "100%";
          content = {
            type = "filesystem";
            format = "ext4";
            mountpoint = "/";
          };
        };
      };
    };
  };
}
