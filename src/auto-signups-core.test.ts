import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { addDays, decideAutoSignups, MS_PER_DAY, type AutoSignupInput, autoSignupsDueAt, weekLeftReminderDue } from "./auto-signups-core.js";

const SEASON_START = new Date("2026-10-01T00:00:00.000Z");

function input(overrides: Partial<AutoSignupInput> = {}): AutoSignupInput {
  return {
    now: new Date("2026-10-08T00:00:00.000Z"), // exactly 7 days after start
    autoOpenDays: 7,
    activeSeasonStartedAt: SEASON_START,
    nextSeasonExists: false,
    nextSeasonHadRound: false,
    anyOpenRoundExists: false,
    ...overrides,
  };
}

describe("decideAutoSignups", () => {
  it.each<[string, Partial<AutoSignupInput>, string]>([
    ["disabled at 0 days", { autoOpenDays: 0 }, "off"],
    ["disabled at negative days", { autoOpenDays: -1 }, "off"],
    ["not due yet, one day short", { now: addDays(SEASON_START, 6) }, "wait"],
    ["due exactly on the boundary", { now: addDays(SEASON_START, 7), nextSeasonExists: true }, "open-now"],
    ["due and next season missing", { now: addDays(SEASON_START, 7), nextSeasonExists: false }, "needs-next-season"],
    ["due and next season already exists, no round yet", { nextSeasonExists: true, nextSeasonHadRound: false }, "open-now"],
    ["due but next season already had a round (closed/built)", { nextSeasonExists: true, nextSeasonHadRound: true }, "already-open"],
    ["an OPEN round already exists anywhere", { anyOpenRoundExists: true }, "already-open"],
    ["not due AND already open -- already-open wins (idempotent, no flapping)", { now: addDays(SEASON_START, 1), anyOpenRoundExists: true }, "already-open"],
    ["off wins even when an OPEN round exists", { autoOpenDays: 0, anyOpenRoundExists: true }, "off"],
  ])("%s -> %s", (_name, overrides, expectedAction) => {
    expect(decideAutoSignups(input(overrides)).action).toBe(expectedAction);
  });

  it("wait carries the exact due date (startedAt + autoOpenDays days)", () => {
    const decision = decideAutoSignups(input({ now: addDays(SEASON_START, 3), autoOpenDays: 10 }));
    expect(decision).toEqual({ action: "wait", dueAt: addDays(SEASON_START, 10) });
  });

  it("addDays adds whole days in milliseconds", () => {
    expect(addDays(SEASON_START, 1).getTime() - SEASON_START.getTime()).toBe(MS_PER_DAY);
    expect(addDays(SEASON_START, 0).getTime()).toBe(SEASON_START.getTime());
  });

  // Property: once a round is OPEN (or the next season already had one), the
  // decision is "already-open" for every possible timing/flag combination
  // except the feature being off -- i.e. the tick can never re-open or
  // double-create no matter how it's called. This is the idempotence
  // guarantee the hourly tick depends on.
  it("property: an existing open round (or a settled next-season round) always wins over timing, unless off", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }), // autoOpenDays, always > 0 here
        fc.integer({ min: -30, max: 30 }), // days offset from "now" relative to start
        fc.boolean(), // nextSeasonExists
        fc.constantFrom<"open" | "settled">("open", "settled"),
        (autoOpenDays, dayOffset, nextSeasonExists, which) => {
          const decision = decideAutoSignups({
            now: addDays(SEASON_START, dayOffset),
            autoOpenDays,
            activeSeasonStartedAt: SEASON_START,
            nextSeasonExists: which === "settled" ? true : nextSeasonExists,
            nextSeasonHadRound: which === "settled",
            anyOpenRoundExists: which === "open",
          });
          expect(decision.action).toBe("already-open");
        },
      ),
    );
  });

  // Property: with the feature off, the decision is always "off" -- no
  // combination of other inputs can override it.
  it("property: autoOpenDays <= 0 is always off, regardless of every other input", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -100, max: 0 }),
        fc.integer({ min: -30, max: 30 }),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (autoOpenDays, dayOffset, nextSeasonExists, nextSeasonHadRound, anyOpenRoundExists) => {
          const decision = decideAutoSignups({
            now: addDays(SEASON_START, dayOffset),
            autoOpenDays,
            activeSeasonStartedAt: SEASON_START,
            nextSeasonExists,
            nextSeasonHadRound,
            anyOpenRoundExists,
          });
          expect(decision.action).toBe("off");
        },
      ),
    );
  });
});

describe("one week before the end", () => {
  const start = new Date("2026-09-30T20:00:00Z");
  const end = new Date("2026-10-21T20:00:00Z");
  const base = {
    autoOpenDays: 7,
    activeSeasonStartedAt: start,
    nextSeasonExists: false,
    nextSeasonHadRound: false,
    anyOpenRoundExists: false,
    activeSeasonScheduledEndAt: end,
  };

  it("counts back from the scheduled end when there is one", () => {
    expect(autoSignupsDueAt(base)).toEqual(new Date("2026-10-14T20:00:00Z"));
    expect(decideAutoSignups({ ...base, now: new Date("2026-10-11T12:00:00Z") })).toEqual({
      action: "wait",
      dueAt: new Date("2026-10-14T20:00:00Z"),
    });
    expect(decideAutoSignups({ ...base, now: new Date("2026-10-14T21:00:00Z") })).toEqual({ action: "needs-next-season" });
  });

  it.each([
    ["before the due date", "2026-10-13T00:00:00Z", null, false],
    ["at the due date", "2026-10-14T20:00:00Z", null, true],
    ["already posted this season", "2026-10-15T00:00:00Z", 9, false],
    ["posted last season only", "2026-10-15T00:00:00Z", 8, true],
    ["after the season ended", "2026-10-22T00:00:00Z", null, false],
  ])("week-left reminder %s", (_name, now, last, expected) => {
    expect(
      weekLeftReminderDue({
        now: new Date(now),
        autoOpenDays: 7,
        activeSeasonNumber: 9,
        activeSeasonStartedAt: start,
        activeSeasonScheduledEndAt: end,
        lastReminderSeasonNumber: last,
      }),
    ).toBe(expected);
  });

  it("never posts the reminder when the feature is off or there is no end date", () => {
    const at = { now: new Date("2026-10-15T00:00:00Z"), activeSeasonNumber: 9, activeSeasonStartedAt: start, lastReminderSeasonNumber: null };
    expect(weekLeftReminderDue({ ...at, autoOpenDays: 0, activeSeasonScheduledEndAt: end })).toBe(false);
    expect(weekLeftReminderDue({ ...at, autoOpenDays: 7, activeSeasonScheduledEndAt: null })).toBe(false);
  });
});

