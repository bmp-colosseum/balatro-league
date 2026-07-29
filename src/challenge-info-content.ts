// The self-updating "how challenges work" post the bot keeps current in the
// challenges channel (see refreshChallengeInfoPinned in channel-refresh.ts).
// Plain content string — no DB reads, so it renders identically every refresh.
// Keep it under Discord's 2000-char message limit.

export function composeChallengeInfoContent(): string {
  return [
    "## Casual Challenges",
    "Use **/challenge** to play a casual match against anyone. These are just for fun / practice / grudge matches -- they do **NOT** count toward league standings.",
    "",
    "**Start one**",
    "`/challenge opponent:@player` -- they get an invite to accept in a fresh thread.",
    "",
    "**Options**",
    "- **best-of** -- 1 (default), 2, 3, or **5**. Odd series play until someone clinches (first to 2 of 3, first to 3 of 5); a best-of-2 always plays both games (1-1 is a tie).",
    "- **no-repeats** -- a best-of-5 \"finals\" rule: once a deck+stake combo has been **played**, it can't be picked again for the rest of the series. Pair it with `best-of:5` for a playoff-style final.",
    "",
    "**Each game** runs the normal ban -> pick flow, same as league matches: both players ban combos from the pool, then the picker chooses from what's left. A fresh pool is drawn each game.",
    "",
    "**Playoff final example**",
    "`/challenge opponent:@rival best-of:5 no-repeats:true`",
  ].join("\n");
}
