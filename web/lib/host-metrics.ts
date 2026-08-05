import "server-only";

// Impure shell for the owner-facing /admin/host page. Reads what's actually
// available to a Node process in a Linux container: /proc/uptime,
// /proc/loadavg, /proc/meminfo, and statfs() on "/". All parsing/formatting
// math is pure and lives in ./host-metrics-parsers.ts -- this file is just
// "gather bytes, hand them to the pure functions, return the result".
//
// CONTAINER CAVEAT (be honest about this in the UI): the league web app runs
// as its own Docker container, not directly on the Netcup box. There's no
// lxcfs here, so /proc/uptime, /proc/loadavg, and /proc/meminfo genuinely
// reflect the HOST kernel's real values -- Docker doesn't virtualize those
// files by default. BUT a container's cgroup memory *limit* can make "memory
// available to this one container" different from MemTotal/MemAvailable
// above, which describe the whole host, not this container's slice of it.
// Every number here is "the web container's view of the host", not a
// per-container quota -- label it that way in the UI, never as gospel truth
// about what any single service can use.

import { readFile, statfs } from "node:fs/promises";
import {
  computeDiskUsage,
  parseLoadavg,
  parseMeminfo,
  parseUptime,
  type DiskInfo,
  type LoadAvgInfo,
  type MemInfo,
  type UptimeInfo,
} from "./host-metrics-parsers";

export interface HostMetrics {
  uptime: UptimeInfo | null;
  loadavg: LoadAvgInfo | null;
  memory: MemInfo | null;
  disk: DiskInfo | null;
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    console.warn(`[host-metrics] failed to read ${path}:`, err);
    return null;
  }
}

// statfs() rejects (doesn't throw synchronously) on failure -- e.g. an odd
// sandbox/permission setup with no "/" access. Caught here so a disk-read
// failure degrades to null instead of taking the whole page down.
async function readDisk(): Promise<DiskInfo | null> {
  try {
    const stat = await statfs("/");
    return computeDiskUsage({
      totalBytes: stat.blocks * stat.bsize,
      // bavail (not bfree): the space actually available to an unprivileged
      // process, excluding blocks the OS reserves for root.
      freeBytes: stat.bavail * stat.bsize,
    });
  } catch (err) {
    console.warn("[host-metrics] statfs('/') failed:", err);
    return null;
  }
}

export async function readHostMetrics(): Promise<HostMetrics> {
  const [uptimeRaw, loadavgRaw, meminfoRaw, disk] = await Promise.all([
    readTextFile("/proc/uptime"),
    readTextFile("/proc/loadavg"),
    readTextFile("/proc/meminfo"),
    readDisk(),
  ]);
  return {
    uptime: uptimeRaw !== null ? parseUptime(uptimeRaw) : null,
    loadavg: loadavgRaw !== null ? parseLoadavg(loadavgRaw) : null,
    memory: meminfoRaw !== null ? parseMeminfo(meminfoRaw) : null,
    disk,
  };
}
