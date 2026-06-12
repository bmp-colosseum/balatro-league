# How the League Works

The Balatro League is a recurring, skill-tiered Balatro Multiplayer (BMP) league.
You're placed with players around your level, play a round-robin against your
group, and **promote up or drop down** between seasons based on how you finish.
No matter your level, you're playing people your own size — and the people above
you are there to coach.

---

## The season, start to finish

1. **Sign up** when a new season opens (a button in `#league-signups`, or on the
   site at `/join`).
2. **Placement** — you're seeded into a **tier** and a **division** based on your
   skill/rating (we look at your BMP rank as a starting point).
3. **Play** — a round-robin inside your division: you play everyone in it once.
4. **Season ends** — final standings lock in.
5. **Promotion / relegation** — top finishers move **up** a tier, bottom finishers
   move **down**. Then the next season starts and you do it again.

---

## Tiers & divisions

- A **tier** is a skill band — think of them stacked top to bottom (the strongest
  tier at the top).
- Each tier holds one or more **divisions** — the actual group you play in. When a
  tier has several, they're named like a card run: **`A`, `2`, `3`, `4`, `5`** (the
  top division is the "Ace"). A single-division tier just uses the tier name.
- You only play the people **in your division**. Divisions are kept small so you
  can realistically play everyone.

---

## The format

- **Round-robin:** you play **every other player in your division once.**
- Each matchup is a **best-of-2 set** — two games. So a matchup ends one of three
  ways:
  - **2-0** — you won both games → **a win**
  - **1-1** — one each → **a draw** (yes, draws are a real result here)
  - **0-2** — you lost both → **a loss**

### Scoring

| Result | Your points |
|---|---|
| **2-0 win** | **3** |
| **1-1 draw** | **1** (each player) |
| **0-2 loss** | **0** |

Your division rank is driven by total points first — see
**[standings.md](standings.md)** for exactly how ties are broken.

---

## Playing a match

Two ways to play a matchup:

- **Guided (`/start-match @opponent`)** — the bot walks both of you through the
  deck **ban/pick** for each game, records the winner, and logs everything
  automatically. This is the recommended way.
- **Manual (`/report @opponent result:2-0`)** — if you played in BMP without the
  bot, just report the score. Your opponent gets a confirm/dispute prompt.

### Deck ban/pick (the guided flow)

Each game is played on one deck/stake combo, chosen by banning down a pool:

1. A pool of **9** deck/stake combos is generated.
2. **First player bans 1.**
3. **Second player bans 3.**
4. **First player bans 3 more** (4 total).
5. **2 combos are left → the second player picks 1** of them. That's what you play.

For game 2, the **loser of game 1 chooses who bans first.** (Best-of-2, so there's
no game 3 in the league.)

### Lives

Balatro MP is played with **4 lives** (attrition). After each game, the **winner
records how many lives they had left** (1–4). This is captured as a tiebreak
reference — see [standings.md](standings.md).

### Stakes & decks

Stakes and the deck pool are set per season by the admins (e.g. a White-stake
preset). You'll see the allowed combos in the ban/pick flow.

---

## Disconnects, disputes, forfeits

Covered in **[reporting.md](reporting.md)** — including what happens if someone
disconnects mid-game, how to dispute a wrong score, and DQ/forfeit results.

---

## Promotion & relegation

At the **end of each season**, in every division:
- the **top finishers promote** up to the next tier,
- the **bottom finishers relegate** down a tier,
- everyone else stays put.

The exact number promoted/relegated is set per season by the admins and shown on
the season page. Your **global rank** (across all tiers) updates at season end and
is what seeds you into next season.

---

## Where to look

- **Standings:** `/standings` on the site, or `/standings` in Discord.
- **Your profile:** click your name anywhere, or `/me` — match history, win rates,
  most-played/most-banned decks, and your season-by-season record.
- **Sign up for next season:** the `🔔 Notify` / `🔁 Auto-sign-up` options on your
  profile.
