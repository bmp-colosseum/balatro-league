import { describe, it, expect } from "vitest";
import { buildExpiredInviteDm, buildMatchCancelledNotice } from "./match-sweep.js";

describe("buildExpiredInviteDm", () => {
  it("names the invitee and points back at Start a match", () => {
    const text = buildExpiredInviteDm("Bob");
    expect(text).toBe(
      "Your match invite to **Bob** expired -- they didn't accept in time. " +
        "Nothing is recorded. Agree a time with them first, then press **Start a match** again.",
    );
  });

  it("escapes markdown in the invitee's display name (no bold break-out)", () => {
    expect(buildExpiredInviteDm("**Bob**")).toContain("\\*\\*Bob\\*\\*");
  });
});

describe("buildMatchCancelledNotice", () => {
  it("names both players, the duration, and says nothing is recorded", () => {
    const text = buildMatchCancelledNotice("Alice", "Bob", "24 hours");
    expect(text).toBe(
      "Your match **Alice vs Bob** was cancelled after 24 hours with no activity. " +
        "Nothing is recorded. If you still want to play it, press **Start a match** and pick each other again.",
    );
  });

  it("the paused-cancel duration label reads naturally too", () => {
    expect(buildMatchCancelledNotice("Alice", "Bob", "7 days")).toContain("cancelled after 7 days with no activity");
  });
});
