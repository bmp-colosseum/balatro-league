import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  signupSeasonLabel,
  signupBannerText,
  signupHeroLine,
  type SignupSeasonLabelInput,
} from "./signup-season-label-core";

describe("signupSeasonLabel -- scenarios", () => {
  it.each<{ name: string; input: SignupSeasonLabelInput; expected: string }>([
    {
      name: "season known, no subtitle",
      input: { seasonNumber: 10, subtitle: null, roundName: "Season 10 Signups" },
      expected: "Season 10",
    },
    {
      name: "season known, with subtitle",
      input: { seasonNumber: 10, subtitle: "Launch", roundName: "Season 10 Signups" },
      // Built via fromCharCode rather than a literal em dash so this file
      // itself stays pure ASCII -- the real formatSeasonLabel() output
      // (lib/format-season.ts) does use an em dash here, unchanged/pre-existing.
      expected: `Season 10 ${String.fromCharCode(8212)} Launch`,
    },
    {
      name: "no season yet, round name ends with Signups",
      input: { seasonNumber: null, subtitle: null, roundName: "Season 11 Signups" },
      expected: "Season 11",
    },
    {
      name: "no season yet, round name ends with lowercase signups",
      input: { seasonNumber: null, subtitle: null, roundName: "Verify Next Season signups" },
      expected: "Verify Next Season",
    },
    {
      name: "no season yet, round name has no trailing Signups word",
      input: { seasonNumber: null, subtitle: null, roundName: "Preseason Tryouts" },
      expected: "Preseason Tryouts",
    },
    {
      name: "no season yet, round name is bare Signups",
      input: { seasonNumber: null, subtitle: null, roundName: "Signups" },
      expected: "Sign-ups",
    },
    {
      name: "no season yet, round name is blank",
      input: { seasonNumber: null, subtitle: null, roundName: "" },
      expected: "Sign-ups",
    },
  ])("$name", ({ input, expected }) => {
    expect(signupSeasonLabel(input)).toBe(expected);
  });
});

describe("signupSeasonLabel -- properties", () => {
  it("never ends with the bare word Signups and is never empty", () => {
    fc.assert(
      fc.property(
        fc.option(fc.integer({ min: 1, max: 999 }), { nil: null }),
        fc
          .option(fc.string({ minLength: 1, maxLength: 20 }), { nil: null })
          .map((s) => (s === null ? null : s.replace(/signups/gi, "").trim() || null)),
        fc.string({ minLength: 0, maxLength: 20 }).map((s) => s.replace(/signups/gi, "").trim()),
        fc.boolean(),
        (seasonNumber, subtitle, roundNameBase, appendSignups) => {
          const roundName = appendSignups ? `${roundNameBase} Signups` : roundNameBase;
          const label = signupSeasonLabel({ seasonNumber, subtitle, roundName });
          expect(label.length).toBeGreaterThan(0);
          expect(/signups$/i.test(label)).toBe(false);
        },
      ),
    );
  });
});

describe("signupBannerText -- scenarios", () => {
  it.each([
    {
      name: "with signups so far",
      label: "Season 10",
      signupCount: 5,
      expected: "Season 10 sign-ups are open! 5 signed up so far. Join ->",
    },
    {
      name: "zero signups omits the count sentence",
      label: "Season 10",
      signupCount: 0,
      expected: "Season 10 sign-ups are open! Join ->",
    },
  ])("$name", ({ label, signupCount, expected }) => {
    expect(signupBannerText({ label, signupCount })).toBe(expected);
  });
});

describe("signupHeroLine -- scenarios", () => {
  const formatDate = (d: Date): string => d.toISOString().slice(0, 10);

  it.each([
    {
      name: "with a close date",
      label: "Season 10",
      closesAt: new Date("2026-11-01T00:00:00Z"),
      expected: "Season 10 sign-ups are open -- closes 2026-11-01",
    },
    {
      name: "no close date set",
      label: "Season 10",
      closesAt: null,
      expected: "Season 10 sign-ups are open",
    },
  ])("$name", ({ label, closesAt, expected }) => {
    expect(signupHeroLine({ label, closesAt, formatDate })).toBe(expected);
  });
});
