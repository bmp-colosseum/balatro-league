# Standings & Tiebreakers

How your rank in a division is decided — including **head-to-head**, **real ties**,
and **showdowns**.

---

## The columns

A standings row shows:

- **Rank** — your place in the division (`1`, `2`, `3`…). Tied players share a rank
  shown like `#2 #2` (see [Real ties](#real-ties) below).
- **Points** — `3` per 2-0 win, `1` per 1-1 draw, `0` per loss.
- **W / D / L** — your matchups won (2-0) / drawn (1-1) / lost (0-2).
- **Games** — total individual games won–lost (a 2-0 is two game wins).
- Plus win rates and your global/seed rank.

---

## How rank is decided (the sort order)

Players are sorted by this chain, **in order** — the first thing that separates two
players wins:

1. **Points** (most first).
2. **Wins** — more 2-0 wins. Two players can be level on points but differ on wins
   (e.g. 3 wins + 0 draws = 9 pts beats 2 wins + 3 draws = 9 pts), and the decisive
   wins rank higher.
3. **Head-to-head** — did one of you sweep the other when you met? (See below.)
4. **The tiebreaker game / lives:**
   - **Two players** still tied → a **BO1 showdown** between them; the winner ranks
     higher.
   - **Three or more** tied → **lives** decide it (see below).
5. If nothing above separates you → it's a **real tie** and you **share the rank**.

### Head-to-head — the important detail

Head-to-head only **breaks a tie when your meeting had a clear winner** — i.e. one
of you won it **2-0**.

- You beat them **2-0** in the regular season → **you rank above them.**
- Your meeting was a **1-1 draw** → head-to-head **does not** separate you. It
  falls through to the next tiebreaker (a showdown, then wins, then draws).
- You never played → no head-to-head to use.

So "we're tied on points but I beat them" only helps if that win was a sweep.

---

## Showdowns — the BO1 tiebreaker

When **two** players are still tied after points, wins, and head-to-head, the tie is
settled with a **showdown** — a single **BO1** (one extra game) between them. The
winner ranks above the loser. (These often decide who promotes or relegates at the
boundary, so they matter.)

- A showdown is played through the bot (`/start-match` in showdown mode) or
  recorded by an admin.
- It does **not** change anyone's points or W/D/L — it's purely a tiebreaker.
- You'll see them listed in a **⚔ Showdowns** box on the division page.

---

## Real ties

The league **allows genuine ties.** If two (or more) players come out equal on the
*entire* chain — same points, head-to-head didn't separate them, no showdown, same
wins, same draws — they **share the rank** instead of being force-ordered
alphabetically.

- A shared rank shows as the same number on each tied row, e.g. **`#1  #1  #1`** for
  a three-way tie at the top.
- The next distinct player resumes at the proper position (so `1, 2, 2, 4`).

### Breaking a 3-or-more-way tie — lives

A showdown is only between **two** players, so a **three-or-more-way** tie is broken
by **lives**. Each tied player has a **net life differential** — how many lives you
kept across games you won, minus how many your opponents kept when they beat you.
Higher = you were "closer to winning" → higher rank.

An admin applies this (so there's room to handle an unusual season differently if
needed), but **lives are the criterion** for 3+-way ties.

---

## Where the numbers come from

- Standings update whenever a result is confirmed.
- "Game wins" come from the individual games in each set; "lives" come from matches
  played through the guided `/start-match` flow (a manually-reported `2-0` has no
  per-game lives).
- Your **global rank** (across every tier) is written at **season end** and is what
  seeds you into the next season's placement.
