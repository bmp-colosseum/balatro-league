// Pure-parser tests for the owner-facing /admin/host page. web/ has no test
// runner of its own (Playwright e2e only) -- this file is picked up by the
// ROOT vitest project instead (see vitest.config.ts's `include`). It is safe
// to run there because host-metrics-parsers.ts has zero imports (no
// "server-only", no node:fs, no web-specific path aliases).

import { describe, it, expect } from "vitest";
import {
  botLevelSeverity,
  computeDiskUsage,
  formatBytes,
  formatRelativeTime,
  formatUptime,
  parseLoadavg,
  parseMeminfo,
  parseUptime,
  pctSeverity,
} from "./host-metrics-parsers.js";

describe("parseUptime", () => {
  it("parses the uptime field, ignoring idle time", () => {
    expect(parseUptime("12345.67 98765.43\n")).toEqual({ uptimeSeconds: 12345.67 });
  });

  it("returns null for empty input", () => {
    expect(parseUptime("")).toBeNull();
  });

  it("returns null for non-numeric input", () => {
    expect(parseUptime("not-a-number 123\n")).toBeNull();
  });

  it("returns null for a negative uptime", () => {
    expect(parseUptime("-5 10\n")).toBeNull();
  });
});

describe("parseLoadavg", () => {
  it("parses the three load averages", () => {
    expect(parseLoadavg("0.52 0.58 0.59 1/523 12345\n")).toEqual({ load1: 0.52, load5: 0.58, load15: 0.59 });
  });

  it("returns null when fewer than 3 fields are present", () => {
    expect(parseLoadavg("0.52 0.58\n")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseLoadavg("")).toBeNull();
  });

  it("returns null for non-numeric fields", () => {
    expect(parseLoadavg("a b c 1/1 1\n")).toBeNull();
  });
});

describe("parseMeminfo", () => {
  const full = ["MemTotal:       16374644 kB", "MemFree:         1234000 kB", "MemAvailable:   10000000 kB", "Buffers:          200000 kB"].join(
    "\n",
  );

  it("computes used kB / percent from MemTotal and MemAvailable", () => {
    const result = parseMeminfo(full);
    expect(result).not.toBeNull();
    expect(result?.totalKb).toBe(16374644);
    expect(result?.availableKb).toBe(10000000);
    expect(result?.usedKb).toBe(6374644);
    expect(result?.usedPercent).toBeCloseTo((6374644 / 16374644) * 100, 6);
  });

  it("returns null when MemAvailable is missing (old kernel)", () => {
    const noAvailable = ["MemTotal:       16374644 kB", "MemFree:         1234000 kB"].join("\n");
    expect(parseMeminfo(noAvailable)).toBeNull();
  });

  it("returns null when MemTotal is missing", () => {
    const noTotal = ["MemFree:         1234000 kB", "MemAvailable:   10000000 kB"].join("\n");
    expect(parseMeminfo(noTotal)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseMeminfo("")).toBeNull();
  });
});

describe("computeDiskUsage", () => {
  it("computes used bytes / percent from total and free", () => {
    const result = computeDiskUsage({ totalBytes: 1000, freeBytes: 250 });
    expect(result).toEqual({ totalBytes: 1000, freeBytes: 250, usedBytes: 750, usedPercent: 75 });
  });

  it("returns null when total is zero or negative", () => {
    expect(computeDiskUsage({ totalBytes: 0, freeBytes: 0 })).toBeNull();
    expect(computeDiskUsage({ totalBytes: -1, freeBytes: 0 })).toBeNull();
  });

  it("returns null when free is negative", () => {
    expect(computeDiskUsage({ totalBytes: 1000, freeBytes: -1 })).toBeNull();
  });
});

describe("formatBytes", () => {
  it("formats zero and negative bytes as 0 B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
  });

  it("formats sub-KB values as whole bytes", () => {
    expect(formatBytes(500)).toBe("500 B");
  });

  it("formats KB/MB/GB with one decimal", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3.2 * 1024 ** 3)).toBe("3.2 GB");
  });
});

describe("formatUptime", () => {
  it("formats minutes-only for short uptimes", () => {
    expect(formatUptime(0)).toBe("0m");
    expect(formatUptime(90)).toBe("1m");
  });

  it("formats hours + minutes once past an hour", () => {
    expect(formatUptime(3661)).toBe("1h 1m");
  });

  it("formats days + hours + minutes once past a day", () => {
    expect(formatUptime(90000)).toBe("1d 1h 0m");
  });

  it("returns 'unknown' for invalid input", () => {
    expect(formatUptime(-1)).toBe("unknown");
    expect(formatUptime(NaN)).toBe("unknown");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");

  it("reports 'just now' for sub-5s and future timestamps", () => {
    expect(formatRelativeTime(new Date("2026-08-04T11:59:58.000Z"), now)).toBe("just now");
    expect(formatRelativeTime(new Date("2026-08-04T12:00:01.000Z"), now)).toBe("just now");
  });

  it("reports seconds/minutes/hours/days ago at the right granularity", () => {
    expect(formatRelativeTime(new Date("2026-08-04T11:59:30.000Z"), now)).toBe("30s ago");
    expect(formatRelativeTime(new Date("2026-08-04T11:55:00.000Z"), now)).toBe("5m ago");
    expect(formatRelativeTime(new Date("2026-08-04T09:00:00.000Z"), now)).toBe("3h ago");
    expect(formatRelativeTime(new Date("2026-08-01T12:00:00.000Z"), now)).toBe("3d ago");
  });
});

describe("pctSeverity", () => {
  it("is normal at and below 75%", () => {
    expect(pctSeverity(0)).toBe("normal");
    expect(pctSeverity(75)).toBe("normal");
  });

  it("is warn above 75% up to and including 90%", () => {
    expect(pctSeverity(76)).toBe("warn");
    expect(pctSeverity(90)).toBe("warn");
  });

  it("is danger above 90%", () => {
    expect(pctSeverity(91)).toBe("danger");
    expect(pctSeverity(100)).toBe("danger");
  });
});

describe("botLevelSeverity", () => {
  it("maps ok/degraded/down to normal/warn/danger", () => {
    expect(botLevelSeverity("ok")).toBe("normal");
    expect(botLevelSeverity("degraded")).toBe("warn");
    expect(botLevelSeverity("down")).toBe("danger");
  });
});
