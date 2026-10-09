import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { pickCurrentSignupRound, seasonToolsSeasonId, type SignupRoundSummary } from "./season-tools-core.js";

function round(overrides: Partial<SignupRoundSummary> = {}): SignupRoundSummary {
  return { id: "r1", status: "OPEN", ...overrides };
}

describe("pickCurrentSignupRound", () => {
  it.each<{ name: string; rounds: SignupRoundSummary[]; expectedId: string | null }>([
    { name: "no rounds", rounds: [], expectedId: null },
    { name: "only BUILT/ENDED rounds", rounds: [round({ id: "a", status: "BUILT" }), round({ id: "b", status: "ENDED" })], expectedId: null },
    { name: "a single OPEN round", rounds: [round({ id: "a", status: "OPEN" })], expectedId: "a" },
    { name: "a single CLOSED round", rounds: [round({ id: "a", status: "CLOSED" })], expectedId: "a" },
    {
      name: "OPEN outranks CLOSED regardless of order",
      rounds: [round({ id: "a", status: "CLOSED" }), round({ id: "b", status: "OPEN" })],
      expectedId: "b",
    },
    {
      name: "first OPEN wins when several are OPEN (newest-first order assumed)",
      rounds: [round({ id: "a", status: "OPEN" }), round({ id: "b", status: "OPEN" })],
      expectedId: "a",
    },
    {
      name: "CLOSED is picked over a later BUILT one",
      rounds: [round({ id: "a", status: "CLOSED" }), round({ id: "b", status: "BUILT" })],
      expectedId: "a",
    },
  ])("$name", ({ rounds, expectedId }) => {
    expect(pickCurrentSignupRound(rounds)?.id ?? null).toBe(expectedId);
  });

  it("is order-independent for the OPEN-outranks-CLOSED rule (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("OPEN", "CLOSED", "BUILT", "ENDED"), { minLength: 0, maxLength: 8 }),
        (statuses) => {
          const rounds = statuses.map((status, i) => round({ id: `r${i}`, status }));
          const picked = pickCurrentSignupRound(rounds);
          const hasOpen = statuses.includes("OPEN");
          const hasClosed = statuses.includes("CLOSED");
          if (hasOpen) {
            expect(picked?.status).toBe("OPEN");
          } else if (hasClosed) {
            expect(picked?.status).toBe("CLOSED");
          } else {
            expect(picked).toBeNull();
          }
        },
      ),
    );
  });
});

describe("seasonToolsSeasonId", () => {
  it.each<{ name: string; activeSeasonId: string | null; auditDefaultSeasonId: string | null; expected: string | null }>([
    { name: "active season present -> active wins", activeSeasonId: "active-1", auditDefaultSeasonId: "ended-1", expected: "active-1" },
    { name: "no active season -> falls back to audit default", activeSeasonId: null, auditDefaultSeasonId: "ended-1", expected: "ended-1" },
    { name: "neither exists -> null", activeSeasonId: null, auditDefaultSeasonId: null, expected: null },
  ])("$name", ({ activeSeasonId, auditDefaultSeasonId, expected }) => {
    expect(seasonToolsSeasonId(activeSeasonId, auditDefaultSeasonId)).toBe(expected);
  });
});
