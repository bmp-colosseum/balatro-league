# Knowledge Index

Project-local research for the **Balatro League** (Discord bot + website),
versioned with the code. Researchers append one line per topic:
`- [<topic>](<topic-kebab>/) - <one-line hook>`.

Durable design context lives in `docs/` (arch/, ops/, player/).

- [balatro-presence-mod](balatro-presence-mod/) - Feasibility of an in-game "who's-playing-now" presence box + nudge mod: technically green (proven by Balatro Multiplayer's TCP+love.thread transport); recommend a zero-install Discord-presence + bot-DM phase first, Steamodded/Lovely mod second.
- [bmp-style-bans](bmp-style-bans/) - "BMP-style bans" = the BMP/Botlatro competitive DRAFT-POOL policy (weighted deckxstake sampling + maxPerDeck/maxPerStake caps + guaranteed-stake mins + the Cocktail wildcard deck), not a new ban mechanic. Team Tour's match-core/match-pool.ts is a portable superset of this league's generatePool (it was ported FROM here); plan = re-merge engine + JSON preset columns, ship weights+limits first, Cocktail as follow-on.

(Prior note: the Team Tour research moved to the `balatro-team-tour` repo during
the 2026-07 monorepo split.)
- [ux-audit](ux-audit/) - Deep usability/overwhelm audit (2026-10-09): public pages browsed at phone+desktop, admin IA from source (29 nav links -> 5; weekly routine in Inbox/Matches/Messages + Season Tools hub), signup/report/end-season flows reduced to minimum steps, 39-item prioritised backlog.
- [ux-cohesion](ux-cohesion/) - UI polish round 2 + League/Team Tour cohesion (2026-10-09): both live sites shot at 390/1280 (80 shots in ux-cohesion/shots/); Tour is still on the pre-Card-Table v1 look; side-by-side token table, shared-shell proposal (fonts, tokens, one top bar with product switcher, merged URL options), per-page polish for both products with files, 45-row ranked backlog (league S no-decision items first).
- [ux-round3](ux-round3/) - Round-3 UX audit of both sites on the Card Table look (2026-10-12): 31 pages shot at 390/1280 with measured overflow, tap targets, tiny text, contrast, weight and console errors (ux-round3/shots/, metrics.json); 10 headline findings (Tour felt is navy not burgundy, league has no link to the Tour, Tour header ghost shadow + 1.59:1 brand label, records page broken on phone, league standings gold-bar wall, how-it-works date mismatch, paper-faint fails its own contrast rule), per-page notes, cross-site component table, 45-row backlog with files.
- [bot-ux](bot-ux/) - Discord bot player-facing message audit (2026-10-12): 48-row inventory of every DM/channel post with buttons and file:line, 10 findings (Help button lists slash commands, three conflicting tie-rule texts vs the chain/lives code, silent thread deletions on expiry/idle/paused, game-1 ban screen unexplained, match/matchup/game naming, result-path contradictions, "1 lives left" plurals, cuid footers), five paste-ready rewrites, 26-row ranked backlog.
