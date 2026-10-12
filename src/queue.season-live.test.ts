// One tiny pure-function test, kept out of a full queue.ts test suite (that
// file is almost entirely the impure pg-boss shell). Covers B19: the two
// "season is live" announcements (season-start completion, and match-sweep's
// scheduled-start path) now share this single builder instead of each
// hand-writing slightly different wording.
import { describe, it, expect } from "vitest";
import { buildSeasonLiveAnnouncement } from "./queue.js";

describe("buildSeasonLiveAnnouncement", () => {
  it("names the season and points at Who do I play?", () => {
    const text = buildSeasonLiveAnnouncement("Season 7");
    expect(text).toBe(
      "\u{1F0CF} **Season 7** is live! Your matchups are in your **DMs**; if you need a reminder, click **Who do I play?** under the quick actions in your division channel. Good luck.",
    );
  });
});
