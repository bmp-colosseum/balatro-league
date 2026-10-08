import { describe, it, expect } from "vitest";
import { mentionWithHandle, handleOf } from "./mention.js";

describe("mentionWithHandle", () => {
  it("appends the handle when a username is synced and allowed", () => {
    expect(mentionWithHandle({ discordId: "1", username: "coolguy" })).toBe("<@1> (@coolguy)");
  });

  it("falls back to a bare mention when username is null", () => {
    expect(mentionWithHandle({ discordId: "1", username: null })).toBe("<@1>");
  });

  it("falls back to a bare mention when username is an empty string", () => {
    expect(mentionWithHandle({ discordId: "1", username: "" })).toBe("<@1>");
    expect(mentionWithHandle({ discordId: "1", username: "   " })).toBe("<@1>");
  });

  it("falls back to a bare mention when username is omitted entirely", () => {
    expect(mentionWithHandle({ discordId: "1" })).toBe("<@1>");
  });

  it("strips a leading @ already stored on the username, never doubling it", () => {
    expect(mentionWithHandle({ discordId: "1", username: "@coolguy" })).toBe("<@1> (@coolguy)");
  });

  it("hides the handle when the player opted out (showUsername: false)", () => {
    expect(mentionWithHandle({ discordId: "1", username: "coolguy", showUsername: false })).toBe("<@1>");
  });

  it("treats a null/undefined showUsername as allowed (schema default true)", () => {
    expect(mentionWithHandle({ discordId: "1", username: "coolguy", showUsername: null })).toBe(
      "<@1> (@coolguy)",
    );
    expect(mentionWithHandle({ discordId: "1", username: "coolguy", showUsername: undefined })).toBe(
      "<@1> (@coolguy)",
    );
  });
});

describe("handleOf", () => {
  it("returns the bare @handle when available and allowed", () => {
    expect(handleOf({ discordId: "1", username: "coolguy" })).toBe("@coolguy");
  });

  it("returns empty string when username is null, empty, or opted out", () => {
    expect(handleOf({ discordId: "1", username: null })).toBe("");
    expect(handleOf({ discordId: "1", username: "" })).toBe("");
    expect(handleOf({ discordId: "1", username: "coolguy", showUsername: false })).toBe("");
  });

  it("strips a leading @ without doubling it", () => {
    expect(handleOf({ discordId: "1", username: "@coolguy" })).toBe("@coolguy");
  });
});
