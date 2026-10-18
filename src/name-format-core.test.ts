import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { fitLines, joinNames, nameMd, namePlain } from "./name-format-core.js";

const AT = "\uFF20";
const HASH = "\uFF03";

const NASTY: ReadonlyArray<readonly [label: string, input: string, md: string, plain: string]> = [
  ["underscore", "_x_", "\\_x\\_", "_x_"],
  ["bold", "**x**", "\\*\\*x\\*\\*", "**x**"],
  ["strike", "~~x~~", "\\~\\~x\\~\\~", "~~x~~"],
  ["code", "`x`", "\\`x\\`", "`x`"],
  ["spoiler", "||x||", "\\|\\|x\\|\\|", "||x||"],
  ["quote", "> x", "\\> x", "> x"],
  ["heading", "# x", "\\# x", "# x"],
  ["bullet", "- x", "\\- x", "- x"],
  ["numbered", "1. x", "1\\. x", "1. x"],
  ["masked link", "[x](https://evil.example)", "\\[x](https://evil.example)", "[x](https://evil.example)"],
  ["everyone", "@everyone", `${AT}everyone`, `${AT}everyone`],
  ["here", "@here", `${AT}here`, `${AT}here`],
  ["user mention", "<@123>", `<${AT}123>`, `<${AT}123>`],
  ["role mention", "<@&123>", `<${AT}&123>`, `<${AT}&123>`],
  ["channel mention", "<#123>", `<${HASH}123>`, `<${HASH}123>`],
  ["32 asterisks", "*".repeat(32), "\\*".repeat(32), "*".repeat(32)],
  ["backslash", "a\\b", "a\\\\b", "a\\b"],
  ["plain name", "big_mike", "big\\_mike", "big_mike"],
  ["plain no markup", "Mike", "Mike", "Mike"],
  ["empty", "", "", ""],
  ["padded", "  pad  ", "  pad  ", "pad"],
];

describe("nameMd / namePlain scenarios", () => {
  test.each(NASTY)("%s: nameMd", (_label, input, md) => {
    expect(nameMd(input)).toBe(md);
  });
  test.each(NASTY)("%s: namePlain", (_label, input, _md, plain) => {
    expect(namePlain(input)).toBe(plain);
  });
});

const nameArb = fc
  .array(
    fc.oneof(
      fc.string({ maxLength: 6 }),
      fc.constantFrom("@everyone", "@here", "<@1>", "<@&2>", "<#3>", "**", "_", "||", "[", "# ", "> ", "1. ", "\\"),
    ),
    { maxLength: 8 },
  )
  .map((parts) => parts.join(""));

describe("properties", () => {
  test("namePlain is never longer than its input (swaps are length-preserving, trim only shrinks)", () => {
    fc.assert(fc.property(nameArb, (n) => namePlain(n).length <= n.length));
  });

  test("neither mode emits a live mention token", () => {
    fc.assert(
      fc.property(nameArb, (n) => {
        for (const out of [nameMd(n), namePlain(n)]) {
          expect(out.toLowerCase()).not.toContain("@everyone");
          expect(out.toLowerCase()).not.toContain("@here");
          expect(out).not.toContain("<@");
          expect(out).not.toContain("<#");
        }
      }),
    );
  });

  test("nameMd only adds backslashes and swaps mention chars (stripping them recovers the input)", () => {
    fc.assert(
      fc.property(nameArb, (n) => {
        const undone = nameMd(n).replace(/\\(.)/gs, "$1");
        expect(undone.length).toBe(n.length);
      }),
    );
  });

  test("nameMd is deliberately NOT idempotent (apply once, at the boundary)", () => {
    expect(nameMd(nameMd("_"))).not.toBe(nameMd("_"));
  });

  test("joinNames never exceeds max, in either mode", () => {
    fc.assert(
      fc.property(
        fc.array(nameArb, { maxLength: 40 }),
        fc.integer({ min: 0, max: 300 }),
        fc.constantFrom("md" as const, "plain" as const),
        (names, max, mode) => joinNames(names, { max, mode }).length <= max,
      ),
    );
  });

  test("joinNames keeps every name, in order, when the list fits", () => {
    fc.assert(
      fc.property(
        fc.array(nameArb, { maxLength: 12 }),
        fc.constantFrom("md" as const, "plain" as const),
        (names, mode) => {
          const fmt = mode === "md" ? nameMd : namePlain;
          const expected = names.map(fmt).join(", ");
          expect(joinNames(names, { max: expected.length, mode })).toBe(expected);
        },
      ),
    );
  });
});

describe("joinNames truncation", () => {
  test.each([
    ["fits", ["ann", "bo"], 100, "plain", "ann, bo"],
    ["exact fit", ["ann", "bo"], 7, "plain", "ann, bo"],
    ["drops tail", ["alice", "bob", "carol", "dave"], 22, "plain", "alice, bob and 2 more"],
    ["keeps one", ["ann", "bobbyjoe", "cy"], 16, "plain", "ann and 2 more"],
    ["md escapes", ["a_b", "c_d"], 100, "md", "a\\_b, c\\_d"],
    ["tiny max", ["ann", "bo"], 5, "plain", "and 2"],
    ["empty list", [], 10, "plain", ""],
  ] as const)("%s", (_label, names, max, mode, expected) => {
    expect(joinNames(names, { max, mode })).toBe(expected);
  });
});

describe("fitLines", () => {
  test.each([
    ["fits", ["a", "b"], 10, "a\nb"],
    ["exact fit", ["a", "b"], 3, "a\nb"],
    ["drops tail", ["aaaaaaaa", "bbbbbbbb", "cccccccc"], 24, "aaaaaaaa\n_...and 2 more_"],
    ["empty", [], 5, ""],
  ] as const)("%s", (_label, lines, max, expected) => {
    expect(fitLines(lines, max)).toBe(expected);
  });

  test("never exceeds max", () => {
    fc.assert(
      fc.property(
        fc.array(nameArb, { maxLength: 40 }),
        fc.integer({ min: 0, max: 400 }),
        (lines, max) => fitLines(lines, max).length <= max,
      ),
    );
  });
});
