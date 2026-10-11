# Balatro League -- Operations Handbook

How the league actually runs, written from the code. This is the book the
organiser (the TO), a helper, or a future AI session opens before touching a
season. Every claim here was checked against the source files it links to;
where the code and the organiser's mental model disagreed, the page says so.

Player-facing docs live in [docs/player/](../player/README.md). The website's
look lives in [design-system/MASTER.md](../../design-system/MASTER.md). This
handbook is about behaviour and procedure.

## Pages

| Page | What it answers | Owner |
|---|---|---|
| [season-lifecycle.md](season-lifecycle.md) | Signups, building divisions, starting, running and ending a season; the Season tools page | TO |
| [scheduling-and-roster-changes.md](scheduling-and-roster-changes.md) | How schedules are drawn, and what happens when a player is added, moved, dropped or reinstated | TO + whoever edits `schedule*.ts` |
| [standings-and-tiebreaks.md](standings-and-tiebreaks.md) | Points, scoring modes, the chain and lives tiebreaks, the standings cache, the hand-mirrored files | whoever edits `standings*.ts` |
| [matches-and-results.md](matches-and-results.md) | Start a match, pick/ban, lives, result posts, confirm/dispute, admin Matches page, forfeit/DQ/void | whoever edits `src/commands/match-buttons.ts` or `web/lib/match-admin.ts` |
| [messages-and-dms.md](messages-and-dms.md) | Every DM and channel post the bot sends, when, and where its wording lives; copy rules | whoever edits message text |
| [admin-guide.md](admin-guide.md) | Task-by-task clicks on the current admin UI | TO |
| [operations.md](operations.md) | Deploy pipeline, the prod box rules, security scanning, the Team Tour sibling repo | whoever edits `.github/workflows/` |

## Who this is for

- The TO, when a season event comes up and the exact rule or button matters.
- A helper who has admin access and needs to do one task safely.
- A future coding session that needs the behaviour, not just the code, before
  changing it.

## How to keep this current

1. A behaviour change updates the matching handbook page in the same commit.
   "Behaviour" means anything a player or admin could notice: a rule, a
   message, a button, a schedule, a deploy step. The repo's `CLAUDE.md` states
   this rule so coding sessions see it too.
2. Link to source files with relative paths, not line numbers. Line numbers
   rot; file and function names rot slowly and are greppable.
3. Prefer "the code does X" over "we usually do X". When a page records a
   manual procedure the code does not enforce, say so in that sentence.
4. If a page and the code disagree, the code wins and the page gets fixed.
   If the code is wrong, fix the code and the page together.
5. Keep sections short and the language plain. ASCII only (no smart quotes,
   no emoji) so the files diff cleanly and read in any terminal.
6. When a page grows past about 200 lines, split it and add the new page to
   the table above.

## Conventions used in these pages

- Discord channel names are written as `#league-info`. Setting keys are
  written as `signups_auto_open_days`. Admin routes are written as
  `/admin/season-tools`.
- Button labels are quoted exactly as rendered, minus any leading emoji.
- "Bot" is the Discord process in `src/`. "Web" is the Next.js app in `web/`.
  Both talk to the same Postgres database.
