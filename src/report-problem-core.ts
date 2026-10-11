// Pure decision/formatting logic for the "Report a problem" flow that
// replaced per-result disputes. A player presses the button on a result
// post, fills in one modal field, and that becomes a /support-style
// ticket - no pending stage, no confirm/dispute vote.

// Both the brand-new "report:problem:<id>" button and the pre-existing
// "report:dispute:<id>" customId (already posted before this change
// shipped) route to the same modal - there's no live path left that
// creates a new dispute.
export function isReportProblemAction(action: string): boolean {
  return action === "dispute" || action === "problem";
}

export interface ProblemTicketInput {
  pairingId: string;
  playerAName: string;
  playerBName: string;
  description: string;
}

// SupportTicket.issue is shown verbatim in the ticket embed (same path
// as /support), so keep it to the same 500-char budget the /support
// slash command enforces on its own "issue" option.
const MAX_ISSUE_LENGTH = 500;

export function buildProblemTicketIssue(input: ProblemTicketInput): string {
  const { pairingId, playerAName, playerBName, description } = input;
  const header = `Match ${pairingId} (${playerAName} vs ${playerBName}): `;
  const body = description.trim();
  const combined = header + body;
  return combined.length > MAX_ISSUE_LENGTH ? combined.slice(0, MAX_ISSUE_LENGTH) : combined;
}
