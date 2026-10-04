import { describe, it, expect } from "vitest";
import {
  decideAttachmentStorage,
  isImageContentType,
  MAX_DM_ATTACHMENT_BYTES,
  parseStoredAttachmentRefs,
  resolveContentType,
  sanitizeAttachmentFilename,
  selectBackfillCandidateIds,
} from "./dm-attachment-core.js";

describe("decideAttachmentStorage -- size cap", () => {
  it.each([
    { label: "tiny file", size: 10, expectStore: true },
    { label: "right at the cap", size: MAX_DM_ATTACHMENT_BYTES, expectStore: true },
    { label: "one byte over the cap", size: MAX_DM_ATTACHMENT_BYTES + 1, expectStore: false },
    { label: "way over the cap", size: 50 * 1024 * 1024, expectStore: false },
    { label: "zero bytes", size: 0, expectStore: true },
  ])("$label -> store=$expectStore", ({ size, expectStore }) => {
    const decision = decideAttachmentStorage(size);
    expect(decision.store).toBe(expectStore);
    if (expectStore) {
      expect(decision.error).toBeNull();
    } else {
      expect(decision.error).toContain("too large");
    }
  });

  it("names the actual size and the cap in the error message", () => {
    const decision = decideAttachmentStorage(15 * 1024 * 1024);
    expect(decision.error).toBe("too large (15.0 MB, max 10.0 MB)");
  });
});

describe("sanitizeAttachmentFilename", () => {
  it.each([
    { input: "photo.png", expected: "photo.png" },
    { input: "  trimmed.png  ", expected: "trimmed.png" },
    { input: "../../etc/passwd", expected: ".._.._etc_passwd" },
    { input: "back\\slash.png", expected: "back_slash.png" },
    { input: 'quote"name.png', expected: "quote_name.png" },
    { input: "", expected: "attachment" },
    { input: "   ", expected: "attachment" },
  ])("sanitizes $input -> $expected", ({ input, expected }) => {
    expect(sanitizeAttachmentFilename(input)).toBe(expected);
  });

  it("strips control characters", () => {
    expect(sanitizeAttachmentFilename("na\x00me.png")).toBe("na_me.png");
  });

  it("caps extremely long filenames", () => {
    const long = "a".repeat(500) + ".png";
    const result = sanitizeAttachmentFilename(long);
    expect(result.length).toBe(200);
  });

  it("never returns an empty string", () => {
    expect(sanitizeAttachmentFilename("///")).not.toBe("");
  });
});

describe("resolveContentType", () => {
  it.each([
    { explicit: "image/png", filename: "photo.jpg", expected: "image/png" },
    { explicit: null, filename: "photo.png", expected: "image/png" },
    { explicit: null, filename: "photo.PNG", expected: "image/png" },
    { explicit: null, filename: "clip.mp4", expected: "video/mp4" },
    { explicit: null, filename: "doc.pdf", expected: "application/pdf" },
    { explicit: null, filename: "noextension", expected: null },
    { explicit: null, filename: "weird.xyz123", expected: null },
    { explicit: undefined, filename: "photo.webp", expected: "image/webp" },
  ])("explicit=$explicit filename=$filename -> $expected", ({ explicit, filename, expected }) => {
    expect(resolveContentType(explicit, filename)).toBe(expected);
  });
});

describe("isImageContentType", () => {
  it.each([
    { contentType: "image/png", expected: true },
    { contentType: "image/jpeg", expected: true },
    { contentType: "video/mp4", expected: false },
    { contentType: "application/pdf", expected: false },
    { contentType: null, expected: false },
  ])("contentType=$contentType -> $expected", ({ contentType, expected }) => {
    expect(isImageContentType(contentType)).toBe(expected);
  });
});

describe("parseStoredAttachmentRefs", () => {
  it("returns [] for null", () => {
    expect(parseStoredAttachmentRefs(null)).toEqual([]);
  });

  it("returns [] for malformed JSON", () => {
    expect(parseStoredAttachmentRefs("{not valid json")).toEqual([]);
  });

  it("returns [] when the JSON isn't an array", () => {
    expect(parseStoredAttachmentRefs('{"filename":"a.png","url":"https://x"}')).toEqual([]);
  });

  it("parses a well-formed array", () => {
    const json = JSON.stringify([
      { filename: "a.png", url: "https://cdn.discordapp.com/a.png" },
      { filename: "b.jpg", url: "https://cdn.discordapp.com/b.jpg" },
    ]);
    expect(parseStoredAttachmentRefs(json)).toEqual([
      { filename: "a.png", url: "https://cdn.discordapp.com/a.png" },
      { filename: "b.jpg", url: "https://cdn.discordapp.com/b.jpg" },
    ]);
  });

  it("skips entries with no url and defaults a missing filename", () => {
    const json = JSON.stringify([{ filename: "a.png" }, { url: "https://cdn.discordapp.com/b.jpg" }]);
    expect(parseStoredAttachmentRefs(json)).toEqual([{ filename: "attachment", url: "https://cdn.discordapp.com/b.jpg" }]);
  });

  it("skips non-object array entries", () => {
    const json = JSON.stringify(["not-an-object", null, 5]);
    expect(parseStoredAttachmentRefs(json)).toEqual([]);
  });
});

describe("selectBackfillCandidateIds", () => {
  it("drops ids that already have attachment rows", () => {
    expect(selectBackfillCandidateIds(["a", "b", "c"], ["b"], 10)).toEqual(["a", "c"]);
  });

  it("caps at the given limit, preserving input order", () => {
    expect(selectBackfillCandidateIds(["a", "b", "c", "d"], [], 2)).toEqual(["a", "b"]);
  });

  it("returns [] when every id is already captured", () => {
    expect(selectBackfillCandidateIds(["a", "b"], ["a", "b"], 10)).toEqual([]);
  });

  it("returns [] for an empty candidate list", () => {
    expect(selectBackfillCandidateIds([], [], 10)).toEqual([]);
  });
});
