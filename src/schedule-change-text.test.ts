import { describe, it, expect } from "vitest";
import { changedScheduleText, divisionNoticeText } from "./schedule-change-text.js";

describe("changedScheduleText", () => {
  it("names the removed opponent and the replacement", () => {
    const text = changedScheduleText("Rare 3", ["Lan"], ["Torb22"]);
    expect(text).toBe(
      "\u{1F504} **Schedule update -- Rare 3.** Your match against **Lan** is off -- they left the division, so if you had a time arranged it no longer counts. You now play **Torb22** instead -- reach out to set up a time. Everything else on your schedule stays as it was. Here is your current schedule:",
    );
  });

  it("says only what happened when a match was removed and nothing replaced it", () => {
    const text = changedScheduleText("Rare 3", ["Lan"], []);
    expect(text).toContain("Your match against **Lan** is off");
    expect(text).not.toContain("You now play");
    expect(text).toContain("Everything else on your schedule stays as it was.");
  });

  it("handles two removed opponents with plural wording", () => {
    const text = changedScheduleText("Common 2", ["A", "B"], ["C"]);
    expect(text).toContain("Your match against **A** and **B** is off -- they have left the division");
    expect(text).toContain("You now play **C** instead");
  });

  it("falls back to a generic line when the diff is empty", () => {
    expect(changedScheduleText("Rare 1", [], [])).toContain("One of your matchups changed.");
  });

  it("adds the best-N line when the season counts best results", () => {
    const text = changedScheduleText("Rare 3", ["Lan"], [], { countBest: 3 });
    expect(text).toContain("Everything else on your schedule stays as it was. From now on only your best 3 results count toward the standings");
    expect(text.endsWith("Here is your current schedule:")).toBe(true);
  });
});

describe("divisionNoticeText", () => {
  it("tells unaffected members who left and that only their best N count now", () => {
    expect(divisionNoticeText("Rare 3", "Lan", 3)).toBe(
      "\u{1F504} **Schedule update -- Rare 3.** **Lan** has left the division. Your own matchups have not changed -- keep playing them as planned. From now on only your best 3 results count toward the standings, so nobody is worse off for having one match fewer. Here is your current schedule:",
    );
  });

  it("leaves out the best-N line when every match still counts", () => {
    const text = divisionNoticeText("Rare 3", "Lan", undefined);
    expect(text).not.toContain("best");
  });
});
