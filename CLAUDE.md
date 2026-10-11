# Balatro League -- project instructions

## Keep docs/handbook current

`docs/handbook/` is the operations handbook: how seasons, schedules,
standings, matches, messages, the admin UI and deploys actually work, written
from the code. Any change a player or admin could notice (a rule, a message,
a button, a schedule step, a deploy step, a setting) updates the matching
handbook page in the same commit. The page index and owners are in
`docs/handbook/README.md`. If the code and a page disagree, fix both
together; never leave the page describing behaviour the code no longer has.

Web styling conventions live in `web/AGENTS.md` (loaded via `web/CLAUDE.md`).
