// Pure core for the "Season N" / "Season N -- Subtitle" label shown on
// public signup surfaces outside /join itself (the StandingsBoard banner,
// the home page hero line) and the two bits of copy built from it. No I/O,
// no Date.now() -- the caller passes in every date/formatter.
//
// signupSeasonLabel is the ONE place that derives a signup round's
// human-facing label: when the round is already linked to a built Season
// row (resultingSeasonId), that Season's canonical label wins --
// lib/format-season.ts's formatSeasonLabel, the same rule every other
// season-facing surface on the site uses (kept in sync by hand with the
// bot's src/format-season.ts). Otherwise it falls back to the round's own
// name with a trailing "Signups" word stripped ("Season 10 Signups" ->
// "Season 10"), so a round posted before its Season row exists still reads
// naturally instead of showing the raw "... Signups" round name.

import { formatSeasonLabel } from "./format-season";

export interface SignupSeasonLabelInput {
  seasonNumber: number | null;
  subtitle: string | null;
  roundName: string;
}

export function signupSeasonLabel(input: SignupSeasonLabelInput): string {
  const { seasonNumber, subtitle, roundName } = input;
  if (seasonNumber != null) {
    return formatSeasonLabel({ number: seasonNumber, subtitle });
  }

  const stripped = roundName.replace(/\s*signups\s*$/i, "").trim();
  if (stripped.length > 0) return stripped;

  // The round name was nothing but "Signups" (or blank) -- the one case the
  // strip above can't produce a usable label from. Fall back to a fixed
  // phrase that deliberately does NOT end in the bare word "Signups", so
  // the "never ends with Signups" invariant holds unconditionally.
  return "Sign-ups";
}

export interface SignupBannerTextInput {
  label: string;
  signupCount: number;
}

// "Season 10 sign-ups are open! 5 signed up so far. Join ->" -- the count
// sentence is dropped entirely when nobody's signed up yet rather than
// reading "0 signed up so far."
export function signupBannerText({ label, signupCount }: SignupBannerTextInput): string {
  const countSentence = signupCount > 0 ? ` ${signupCount} signed up so far.` : "";
  return `${label} sign-ups are open!${countSentence} Join ->`;
}

export interface SignupHeroLineInput {
  label: string;
  closesAt: Date | null;
  formatDate: (d: Date) => string;
}

// "Season 10 sign-ups are open -- closes <date>" -- the close clause is
// dropped entirely when the round has no deadline set.
export function signupHeroLine({ label, closesAt, formatDate }: SignupHeroLineInput): string {
  const base = `${label} sign-ups are open`;
  return closesAt ? `${base} -- closes ${formatDate(closesAt)}` : base;
}
