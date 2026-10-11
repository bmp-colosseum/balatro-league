import { describe, expect, it } from "vitest";
import { buildProblemTicketIssue, isReportProblemAction } from "./report-problem-core.js";

describe("isReportProblemAction", () => {
  it("accepts the new 'problem' action", () => {
    expect(isReportProblemAction("problem")).toBe(true);
  });

  it("accepts the legacy 'dispute' action for backward compat", () => {
    expect(isReportProblemAction("dispute")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isReportProblemAction("confirm")).toBe(false);
    expect(isReportProblemAction("")).toBe(false);
    expect(isReportProblemAction("close")).toBe(false);
  });
});

describe("buildProblemTicketIssue", () => {
  it("includes the match id and both player names ahead of the description", () => {
    const issue = buildProblemTicketIssue({
      pairingId: "match123",
      playerAName: "Alice",
      playerBName: "Bob",
      description: "The score should have been 1-1, not 2-0.",
    });
    expect(issue).toBe("Match match123 (Alice vs Bob): The score should have been 1-1, not 2-0.");
  });

  it("trims surrounding whitespace on the description", () => {
    const issue = buildProblemTicketIssue({
      pairingId: "m1",
      playerAName: "A",
      playerBName: "B",
      description: "  wrong score  ",
    });
    expect(issue).toBe("Match m1 (A vs B): wrong score");
  });

  it("caps the combined issue text at 500 chars (the /support issue budget)", () => {
    const issue = buildProblemTicketIssue({
      pairingId: "m1",
      playerAName: "A",
      playerBName: "B",
      description: "x".repeat(600),
    });
    expect(issue.length).toBe(500);
  });
});
