import { describe, it, expect } from "vitest";
import { isQueueEntryExpired, QUEUE_IDLE_TIMEOUT_MS } from "./league-queue.js";

describe("isQueueEntryExpired", () => {
  const now = new Date("2026-07-16T12:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("is not expired well within the window", () => {
    expect(isQueueEntryExpired(ago(60 * 60 * 1000), now)).toBe(false); // 1h idle
    expect(isQueueEntryExpired(ago(QUEUE_IDLE_TIMEOUT_MS - 1), now)).toBe(false);
  });

  it("expires exactly at the timeout boundary (>=)", () => {
    expect(isQueueEntryExpired(ago(QUEUE_IDLE_TIMEOUT_MS), now)).toBe(true);
  });

  it("is expired well past the window", () => {
    expect(isQueueEntryExpired(ago(QUEUE_IDLE_TIMEOUT_MS + 60 * 60 * 1000), now)).toBe(true);
  });

  it("treats a just-queued entry (or a future clock skew) as fresh", () => {
    expect(isQueueEntryExpired(now, now)).toBe(false);
    expect(isQueueEntryExpired(new Date(now.getTime() + 1000), now)).toBe(false);
  });

  it("honors a custom timeout", () => {
    const sixH = 6 * 60 * 60 * 1000;
    expect(isQueueEntryExpired(ago(5 * 60 * 60 * 1000), now, sixH)).toBe(false);
    expect(isQueueEntryExpired(ago(7 * 60 * 60 * 1000), now, sixH)).toBe(true);
  });
});
