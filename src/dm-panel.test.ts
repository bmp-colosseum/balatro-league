import { describe, it, expect } from "vitest";
import {
  buildDmPanel,
  buildDmPanelLines,
  capPanelContent,
  classifyDmPanelEditError,
  decideDmPanelAction,
  parseDmPanelRecord,
  shouldSendFallbackSeasonStartDm,
  type DmPanelRecord,
} from "./dm-panel.js";
import type { PlayerStatusSummary } from "./commands/status.js";

const okSummary: PlayerStatusSummary = {
  kind: "ok",
  seasonLabel: "Season 6",
  divisionName: "Rare 1",
  tierName: "Rare",
  rank: 3,
  totalInDivision: 8,
  points: 12,
  wins: 4,
  draws: 0,
  losses: 1,
  played: 5,
  movement: "Safe - holding your spot",
  remainingOpponents: ["Alice", "Bob"],
};

describe("buildDmPanelLines -- compact panel content", () => {
  it("links to the player's division channel when one is provisioned", () => {
    const lines = buildDmPanelLines({ ...okSummary, divisionChannelId: "123456789" }, []);
    expect(lines.some((l) => l.includes("<#123456789>"))).toBe(true); // clickable channel mention, works in DMs
  });

  it("omits the channel line when the division has no channel yet", () => {
    const lines = buildDmPanelLines({ ...okSummary, divisionChannelId: null }, []);
    expect(lines.some((l) => l.includes("division channel"))).toBe(false);
  });

  it("leads with the season-start intro, then the timeline lines", () => {
    const lines = buildDmPanelLines(okSummary, ["Finish by X", "Buffer note"]);
    expect(lines[0]).toBe("**Your League Panel**");
    expect(lines[1]).toBe("**Season 6** is live -- you're in **Rare 1**.");
    expect(lines[2]).toBe("Finish by X");
    expect(lines[3]).toBe("Buffer note");
  });

  it("has no timeline lines when none are given, intro still present", () => {
    const lines = buildDmPanelLines(okSummary, []);
    expect(lines[0]).toBe("**Your League Panel**");
    expect(lines[1]).toBe("**Season 6** is live -- you're in **Rare 1**.");
    expect(lines[2]).toContain("Rare 1");
  });

  it("omits the season-start intro for a non-'ok' kind", () => {
    const lines = buildDmPanelLines({ kind: "no-season", message: "No active season right now." }, []);
    expect(lines.some((l) => l.includes("is live"))).toBe(false);
  });

  it("includes division, rank, record, and movement for an 'ok' summary", () => {
    const lines = buildDmPanelLines(okSummary, []);
    const joined = lines.join("\n");
    expect(joined).toContain("Rare 1");
    expect(joined).toContain("Rare tier");
    expect(joined).toContain("rank #3 of 8");
    expect(joined).toContain("12 pts");
    expect(joined).toContain("4W 0D 1L");
    expect(joined).toContain("Safe - holding your spot");
  });

  it.each([
    ["4 matchups", ["Alice", "Bob", "Cara", "Dee"], "**Matchups still to play (4):**\n- Alice\n- Bob\n- Cara\n- Dee"],
    ["2 matchups", ["Alice", "Bob"], "**Matchups still to play (2):**\n- Alice\n- Bob"],
    ["0 matchups left", [], "All your matches are done!"],
  ] as const)("matchups section -- %s", (_label, remainingOpponents, expected) => {
    const lines = buildDmPanelLines({ ...okSummary, remainingOpponents: [...remainingOpponents] }, []);
    expect(lines[lines.length - 1]).toBe(expected);
  });

  it("falls back to done when remainingOpponents is undefined", () => {
    const { remainingOpponents: _drop, ...rest } = okSummary;
    const lines = buildDmPanelLines(rest as PlayerStatusSummary, []);
    expect(lines[lines.length - 1]).toBe("All your matches are done!");
  });

  it("pairs each matchup with its @handle (parallel to remainingOpponents)", () => {
    const lines = buildDmPanelLines(
      {
        ...okSummary,
        remainingOpponents: ["Alice", "Bob", "Cara", "Dee"],
        remainingOpponentHandles: ["@alice1", "@bobby", "", "@dee_d"],
      },
      [],
    );
    expect(lines[lines.length - 1]).toBe(
      "**Matchups still to play (4):**\n- Alice (@alice1)\n- Bob (@bobby)\n- Cara\n- Dee (@dee_d)",
    );
  });

  it("falls back to no-handle rendering when remainingOpponentHandles is missing or shorter", () => {
    const noHandles = buildDmPanelLines({ ...okSummary, remainingOpponents: ["Alice", "Bob"] }, []);
    expect(noHandles[noHandles.length - 1]).toBe("**Matchups still to play (2):**\n- Alice\n- Bob");

    const shortHandles = buildDmPanelLines(
      { ...okSummary, remainingOpponents: ["Alice", "Bob"], remainingOpponentHandles: ["@alice1"] },
      [],
    );
    expect(shortHandles[shortHandles.length - 1]).toBe("**Matchups still to play (2):**\n- Alice (@alice1)\n- Bob");
  });

  it("shows just the explanation message for a non-'ok' kind (no-season)", () => {
    const lines = buildDmPanelLines({ kind: "no-season", message: "No active season right now." }, ["Timeline"]);
    expect(lines).toEqual(["**Your League Panel**", "Timeline", "No active season right now."]);
  });

  it("shows just the explanation message for a non-'ok' kind (no-division)", () => {
    const lines = buildDmPanelLines(
      { kind: "no-division", message: "You're not in a division this season." },
      [],
    );
    expect(lines).toEqual(["**Your League Panel**", "You're not in a division this season."]);
  });

  it("falls back to a generic message when a non-'ok' kind is missing one", () => {
    const lines = buildDmPanelLines({ kind: "no-standings-row" }, []);
    expect(lines[lines.length - 1]).toBe("No status available right now.");
  });
});

describe("buildDmPanel -- full send/edit payload", () => {
  it("joins the lines into content, attaches the controls row, and clears mentions", () => {
    const options = buildDmPanel(okSummary, ["Timeline line"]);
    expect(options.content).toContain("**Your League Panel**");
    expect(options.content).toContain("Timeline line");
    expect(options.content).toContain("Rare 1");
    expect(options.components).toHaveLength(2); // controls row + hammertime link row
    // The second row is the Hammertime scheduling link.
    expect(JSON.stringify(options.components)).toContain("hammertime.cyou");
    expect(options.allowedMentions).toEqual({ parse: [] });
  });
});

describe("parseDmPanelRecord -- defensive JSON parse", () => {
  it("returns null for null/undefined/empty input", () => {
    expect(parseDmPanelRecord(null)).toBeNull();
    expect(parseDmPanelRecord(undefined)).toBeNull();
    expect(parseDmPanelRecord("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseDmPanelRecord("{not json")).toBeNull();
  });

  it("returns null when required fields are missing or the wrong type", () => {
    expect(parseDmPanelRecord(JSON.stringify({ channelId: "c1" }))).toBeNull();
    expect(parseDmPanelRecord(JSON.stringify({ channelId: 123, messageId: "m1" }))).toBeNull();
    expect(parseDmPanelRecord(JSON.stringify(null))).toBeNull();
    expect(parseDmPanelRecord(JSON.stringify("just a string"))).toBeNull();
  });

  it("parses a valid record", () => {
    const record: DmPanelRecord = { channelId: "c1", messageId: "m1" };
    expect(parseDmPanelRecord(JSON.stringify(record))).toEqual(record);
  });
});

describe("decideDmPanelAction -- send vs edit gate", () => {
  it("sends fresh when there's no stored record", () => {
    expect(decideDmPanelAction(null)).toBe("send");
  });

  it("edits in place when a record is already stored", () => {
    expect(decideDmPanelAction({ channelId: "c1", messageId: "m1" })).toBe("edit");
  });
});

describe("classifyDmPanelEditError -- what to do after a failed edit", () => {
  it.each([
    [10008, "resend"], // unknown message
    [10003, "resend"], // unknown channel
    [50007, "skip-undeliverable"], // cannot send to user
    [10013, "skip-undeliverable"], // unknown user
    [50001, "skip-undeliverable"], // missing access
    [50013, "skip-transient"], // missing permissions -- unexpected, don't nuke the record
    [undefined, "skip-transient"], // no code at all (network error, etc)
  ] as const)("code %s -> %s", (code, expected) => {
    expect(classifyDmPanelEditError(code === undefined ? null : { code })).toBe(expected);
  });
});

describe("capPanelContent -- Discord content-length safety net", () => {
  it("returns the content unchanged when under the limit", () => {
    expect(capPanelContent("short content")).toBe("short content");
  });

  it("returns content exactly at the limit unchanged", () => {
    const exact = "x".repeat(2000);
    expect(capPanelContent(exact)).toBe(exact);
  });

  it("truncates with a trailing marker when over the limit", () => {
    const long = "x".repeat(2100);
    const result = capPanelContent(long);
    expect(result.length).toBe(2000);
    expect(result.endsWith("\n...(truncated)")).toBe(true);
  });

  it("honors a custom limit", () => {
    const result = capPanelContent("x".repeat(100), 20);
    expect(result.length).toBe(20);
    expect(result.endsWith("\n...(truncated)")).toBe(true);
  });
});

describe("shouldSendFallbackSeasonStartDm -- season-start double-DM guard", () => {
  it.each([
    ["panels disabled", false, true], // panel DM won't carry matchups -- fallback must fire
    ["panels enabled", true, false], // panel DM already carries matchups -- no fallback
  ] as const)("%s -> %s", (_label, panelsEnabled, expected) => {
    expect(shouldSendFallbackSeasonStartDm(panelsEnabled)).toBe(expected);
  });
});
