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
2. **Head-to-head** — if you're tied on points, *did one of you beat the other?*
3. **Showdown** — a played 1-game tiebreaker, if one exists.
4. **Match wins** (more 2-0s).
5. **Draws** (more 1-1s).
6. If you're **still** dead even on everything above → it's a **real tie** (you
   share the rank).

### Head-to-head — the important detail

Head-to-head only **breaks a tie when your meeting had a clear winner** — i.e. one
of you won it **2-0**.

- You beat them **2-0** in the regular season → **you rank above them.**
- Your meeting was a **1-1 draw** → head-to-head **does not** separate you. It
  falls through to the next tiebreaker (a showdown, then wins, then draws).
- You never played → no head-to-head to use.

So "we're tied on points but I beat them" only helps if that win was a sweep.

---

## Showdowns (a.k.a. tiebreakers)

When **exactly two** players are tied on points and their head-to-head was a
**1-1 draw**, the tie can be settled with a **showdown** — a single extra game
between them. The winner ranks above the loser.

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

### Breaking a 3-or-more-way tie

A showdown only works for **two** players. For a **3+-way** tie, an admin resolves
it **by hand** (placing the tied players) — this keeps flexibility for how a given
season wants to handle it.

To help that call, admins can see each tied player's **net life differential** — how
many lives you kept across games you won, minus how many your opponents kept when
they beat you. Higher = you were "closer to winning." It's a **reference** the admin
can use; it isn't applied automatically.

---

## Where the numbers come from

- Standings update whenever a result is confirmed.
- "Game wins" come from the individual games in each set; "lives" come from matches
  played through the guided `/start-match` flow (a manually-reported `2-0` has no
  per-game lives).
- Your **global rank** (across every tier) is written at **season end** and is what
  seeds you into the next season's placement.
