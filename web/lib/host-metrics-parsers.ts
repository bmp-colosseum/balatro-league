// Pure parsing/formatting core for the owner-facing /admin/host page. Zero
// imports on purpose -- every function here takes plain strings/numbers in
// and returns plain data out, so it is testable without touching node:fs,
// "server-only", or any container-specific I/O. The impure shell that reads
// /proc and statfs() lives in ./host-metrics.ts and calls these.
//
// Every parser degrades to null on missing/unreadable/malformed input --
// never throws. A partially-unavailable /proc file must not take down the
// whole page.

export interface UptimeInfo {
  uptimeSeconds: number;
}

export interface LoadAvgInfo {
  load1: number;
  load5: number;
  load15: number;
}

export interface MemInfo {
  totalKb: number;
  availableKb: number;
  usedKb: number;
  usedPercent: number;
}

export interface DiskUsageInput {
  totalBytes: number;
  freeBytes: number;
}

export interface DiskInfo {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

export type Severity = "danger" | "warn" | "normal";

// Mirrors src/bot-health.ts's HealthLevel -- duplicated here (not imported)
// because this module must stay dependency-free and the web app is a
// separate npm project from the bot.
export type HealthLevel = "ok" | "degraded" | "down";

// /proc/uptime: "<uptime seconds> <idle seconds>", e.g. "12345.67 98765.43".
// We only want the first field.
export function parseUptime(raw: string): UptimeInfo | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const first = trimmed.split(/\s+/)[0];
  if (first === undefined) return null;
  const uptimeSeconds = Number(first);
  if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) return null;
  return { uptimeSeconds };
}

// /proc/loadavg: "<1m> <5m> <15m> <running>/<total> <last pid>",
// e.g. "0.52 0.58 0.59 1/523 12345".
export function parseLoadavg(raw: string): LoadAvgInfo | null {
  const [a, b, c] = raw.trim().split(/\s+/);
  if (a === undefined || b === undefined || c === undefined) return null;
  const load1 = Number(a);
  const load5 = Number(b);
  const load15 = Number(c);
  if (![load1, load5, load15].every(Number.isFinite)) return null;
  return { load1, load5, load15 };
}

// /proc/meminfo: many "Key:    <value> kB" lines. We only need MemTotal and
// MemAvailable (the kernel's own "usable without swapping" estimate --
// closer to real headroom than MemFree). Missing either field -> null,
// rather than reporting a half-true number.
export function parseMeminfo(raw: string): MemInfo | null {
  const fields = new Map<string, number>();
  for (const line of raw.split("\n")) {
    const match = /^(\w+):\s*(\d+)/.exec(line);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined) continue;
    const value = Number(rawValue);
    if (Number.isFinite(value)) fields.set(key, value);
  }
  const totalKb = fields.get("MemTotal");
  const availableKb = fields.get("MemAvailable");
  if (totalKb === undefined || availableKb === undefined || totalKb <= 0) return null;
  const usedKb = Math.max(0, totalKb - availableKb);
  const usedPercent = (usedKb / totalKb) * 100;
  return { totalKb, availableKb, usedKb, usedPercent };
}

// Pure percent/used-bytes math over an already-read statfs() sample --
// separated from the syscall itself so the arithmetic is testable with a
// plain object instead of a real filesystem.
export function computeDiskUsage(input: DiskUsageInput): DiskInfo | null {
  const { totalBytes, freeBytes } = input;
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  if (!Number.isFinite(freeBytes) || freeBytes < 0) return null;
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const usedPercent = (usedBytes / totalBytes) * 100;
  return { totalBytes, freeBytes, usedBytes, usedPercent };
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

// Binary (1024-based) byte formatting -- "GB" here means 1024^3, the
// convention every system-monitor dashboard actually uses despite the
// technically-correct label being "GiB".
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const rawExponent = Math.floor(Math.log(bytes) / Math.log(1024));
  const exponent = Math.max(0, Math.min(rawExponent, BYTE_UNITS.length - 1));
  const unit = BYTE_UNITS[exponent] ?? "B";
  const value = bytes / 1024 ** exponent;
  return exponent === 0 ? `${Math.round(value)} ${unit}` : `${value.toFixed(1)} ${unit}`;
}

// "3d 4h 12m" style, dropping leading zero units (but always showing minutes,
// even at 0, so "just booted" doesn't render as an empty string).
export function formatUptime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "unknown";
  const totalMinutes = Math.floor(totalSeconds / 60);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

// Clock is injected (both timestamps passed in) rather than read internally,
// so this stays a pure function of its arguments -- the page calls it with
// `new Date()` at render time.
export function formatRelativeTime(from: Date, now: Date): string {
  const diffSeconds = Math.floor((now.getTime() - from.getTime()) / 1000);
  if (diffSeconds < 5) return "just now";
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

// Threshold policy shared by every "% used" stat on the page: >90% is bad
// enough to page over, >75% is worth a look, otherwise it's unremarkable.
export function pctSeverity(pct: number): Severity {
  if (pct > 90) return "danger";
  if (pct > 75) return "warn";
  return "normal";
}

// Same severity scale, applied to the bot's own health level instead of a
// percentage -- so both sections use one color vocabulary.
export function botLevelSeverity(level: HealthLevel): Severity {
  switch (level) {
    case "down":
      return "danger";
    case "degraded":
      return "warn";
    case "ok":
      return "normal";
  }
}
